import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { AuthenticatedRequest } from '../types';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function makeKnowledgeController(prisma: PrismaClient) {
  return {
    async list(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { status, category, search } = req.query as { status?: string; category?: string; search?: string };
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;
        if (category) where.category = category;
        if (search) {
          where.OR = [
            { question: { contains: search, mode: 'insensitive' } },
            { answer: { contains: search, mode: 'insensitive' } },
          ];
        }
        const suggestions = await prisma.knowledgeSuggestion.findMany({
          where: where as any,
          orderBy: { createdAt: 'desc' },
        });
        res.json(suggestions);
      } catch (err) {
        console.error('[Knowledge] list error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async create(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { question, answer, propertyId, category } = req.body as { question: string; answer: string; propertyId?: string; category?: string };
        const suggestion = await prisma.knowledgeSuggestion.create({
          data: {
            tenantId,
            question,
            answer: answer || '',
            propertyId: propertyId || null,
            category: category || null,
            status: 'approved',
            source: 'manual',
          },
        });
        res.json(suggestion);
      } catch (err) {
        console.error('[Knowledge] create error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const { answer, status, propertyId, category } = req.body as { answer?: string; status?: string; propertyId?: string | null; category?: string };
        const existing = await prisma.knowledgeSuggestion.findFirst({ where: { id, tenantId } });
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        const suggestion = await prisma.knowledgeSuggestion.update({
          where: { id },
          data: {
            ...(answer !== undefined ? { answer } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(propertyId !== undefined ? { propertyId } : {}),
            ...(category !== undefined ? { category } : {}),
          },
        });

        res.json(suggestion);
      } catch (err) {
        console.error('[Knowledge] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id } = req.params;
        const existing = await prisma.knowledgeSuggestion.findFirst({ where: { id, tenantId } });
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        await prisma.knowledgeSuggestion.delete({ where: { id } });
        res.json({ ok: true });
      } catch (err) {
        console.error('[Knowledge] remove error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async detectGaps(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;

        // Fetch last 100 guest messages
        const guestMessages = await prisma.message.findMany({
          where: { tenantId, role: 'GUEST' },
          orderBy: { sentAt: 'desc' },
          take: 100,
          select: { content: true },
        });

        // Fetch all approved knowledge suggestions
        const approvedKb = await prisma.knowledgeSuggestion.findMany({
          where: { tenantId, status: 'approved' },
          select: { question: true, answer: true },
        });

        const guestTexts = guestMessages.map(m => m.content).join('\n---\n');
        const kbTexts = approvedKb.length > 0
          ? approvedKb.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n---\n')
          : '(No knowledge base entries yet)';

        const response = await (openai.responses as any).create({
          model: 'gpt-5.4-mini-2026-03-17',
          max_output_tokens: 2048,
          instructions: `You are a hospitality knowledge base analyst. Given a list of recent guest messages and existing knowledge base Q&A entries, identify frequently asked questions or common guest concerns that are NOT covered by the existing knowledge base. Return ONLY a JSON array of objects with "question" and "suggestedAnswer" fields. Each entry should be a real gap — a question guests are asking that the KB doesn't address. Return at most 5 gaps. If there are no gaps, return an empty array []. Return raw JSON only, no markdown fences.`,
          input: `RECENT GUEST MESSAGES:\n${guestTexts}\n\nEXISTING KNOWLEDGE BASE:\n${kbTexts}\n\nIdentify knowledge base gaps and return as JSON array.`,
          reasoning: { effort: 'none' },
          store: true,
        });

        const raw = response.output_text || '[]';
        let gaps: Array<{ question: string; suggestedAnswer: string }>;
        try {
          gaps = JSON.parse(raw);
        } catch {
          gaps = [];
        }
        res.json(gaps);
      } catch (err) {
        console.error('[Knowledge] detectGaps error:', err);
        res.status(500).json({ error: 'Failed to detect knowledge gaps' });
      }
    },

    async bulkImport(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { text } = req.body as { text: string };

        if (!text || !text.trim()) {
          res.status(400).json({ error: 'text is required' });
          return;
        }

        const response = await (openai.responses as any).create({
          model: 'gpt-5.4-mini-2026-03-17',
          max_output_tokens: 4096,
          instructions: `Parse the following text into question-and-answer pairs for a vacation rental knowledge base. Return a JSON array of objects with "question" and "answer" fields. Extract as many relevant Q&A pairs as possible. Return raw JSON only, no markdown fences.`,
          input: text,
          reasoning: { effort: 'none' },
          store: true,
        });

        const raw = response.output_text || '[]';
        let pairs: Array<{ question: string; answer: string }>;
        try {
          pairs = JSON.parse(raw);
        } catch {
          pairs = [];
        }

        const created = await Promise.all(
          pairs.map(pair =>
            prisma.knowledgeSuggestion.create({
              data: {
                tenantId,
                question: pair.question,
                answer: pair.answer,
                status: 'approved',
                source: 'bulk_import',
              },
            })
          )
        );

        res.json(created);
      } catch (err) {
        console.error('[Knowledge] bulkImport error:', err);
        res.status(500).json({ error: 'Failed to bulk import knowledge' });
      }
    },

    async rateMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id: messageId } = req.params;
        const { rating } = req.body as {
          rating: 'positive' | 'negative';
        };
        if (!['positive', 'negative'].includes(rating)) {
          res.status(400).json({ error: 'rating must be positive or negative' });
          return;
        }
        const msg = await prisma.message.findFirst({ where: { id: messageId, tenantId } });
        if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

        await prisma.messageRating.upsert({
          where: { messageId },
          create: { messageId, rating },
          update: { rating },
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('[Knowledge] rateMessage error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

  };
}
