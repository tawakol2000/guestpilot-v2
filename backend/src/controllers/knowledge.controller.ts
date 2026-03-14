import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { AuthenticatedRequest } from '../types';
import { appendLearnedAnswer } from '../services/rag.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

        // When a suggestion is approved and has a propertyId, append to learned-answers chunk
        if (status === 'approved' && (suggestion.propertyId || propertyId)) {
          const targetPropertyId = suggestion.propertyId || propertyId;
          if (targetPropertyId && suggestion.question && suggestion.answer) {
            appendLearnedAnswer(tenantId, targetPropertyId, suggestion.question, suggestion.answer, prisma)
              .catch(err => console.error('[Knowledge] Failed to append learned answer:', err));
          }
        }

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

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: `You are a hospitality knowledge base analyst. Given a list of recent guest messages and existing knowledge base Q&A entries, identify frequently asked questions or common guest concerns that are NOT covered by the existing knowledge base. Return ONLY a JSON array of objects with "question" and "suggestedAnswer" fields. Each entry should be a real gap — a question guests are asking that the KB doesn't address. Return at most 5 gaps. If there are no gaps, return an empty array []. Return raw JSON only, no markdown fences.`,
          messages: [{
            role: 'user',
            content: `RECENT GUEST MESSAGES:\n${guestTexts}\n\nEXISTING KNOWLEDGE BASE:\n${kbTexts}\n\nIdentify knowledge base gaps and return as JSON array.`,
          }],
        });

        const textBlock = response.content.find(b => b.type === 'text');
        const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '[]';
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

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: `Parse the following text into question-and-answer pairs for a vacation rental knowledge base. Return a JSON array of objects with "question" and "answer" fields. Extract as many relevant Q&A pairs as possible. Return raw JSON only, no markdown fences.`,
          messages: [{
            role: 'user',
            content: text,
          }],
        });

        const textBlock = response.content.find(b => b.type === 'text');
        const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '[]';
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
        const { rating } = req.body as { rating: 'positive' | 'negative' };
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
