import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'child_process';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { AuthenticatedRequest } from '../types';
import { appendLearnedAnswer } from '../services/rag.service';
import { extractIntent } from '../services/intent-extractor.service';
import { reinitializeClassifier, loadLrWeightsMetadata } from '../services/classifier.service';
import { TRAINING_EXAMPLES } from '../services/classifier-data';

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

    async gapAnalysis(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Step 1: Query ClassifierEvaluation for entries with empty classifierLabels in last 30 days
        const emptyLabelEvals = await prisma.classifierEvaluation.findMany({
          where: {
            tenantId,
            classifierLabels: { isEmpty: true },
            createdAt: { gte: thirtyDaysAgo },
          },
          select: { guestMessage: true },
        });

        // Step 2: Detect language per message
        const arabicRegex = /[\u0600-\u06FF]/;
        const langDist: Record<string, number> = { ar: 0, en: 0, other: 0 };
        for (const eval_ of emptyLabelEvals) {
          if (arabicRegex.test(eval_.guestMessage)) {
            langDist.ar++;
          } else if (/[a-zA-Z]/.test(eval_.guestMessage)) {
            langDist.en++;
          } else {
            langDist.other++;
          }
        }

        // Step 3: Count existing ClassifierExample records grouped by label to find underrepresented
        const allExamples = await prisma.classifierExample.findMany({
          where: { tenantId, active: true },
          select: { labels: true },
        });
        const labelCounts: Record<string, number> = {};
        for (const ex of allExamples) {
          for (const label of ex.labels) {
            labelCounts[label] = (labelCounts[label] || 0) + 1;
          }
        }
        const underrepresentedCategories = Object.entries(labelCounts)
          .filter(([, count]) => count < 10)
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => a.count - b.count);

        // Step 4: Get existing example texts for dedup
        const existingTexts = new Set(
          (await prisma.classifierExample.findMany({
            where: { tenantId },
            select: { text: true },
          })).map(e => e.text)
        );

        // Step 5: For each empty-label message, call intent extractor and save as pending example
        let suggestedCount = 0;
        for (const eval_ of emptyLabelEvals) {
          const msg = eval_.guestMessage.trim();
          if (!msg || existingTexts.has(msg)) continue;

          // Call intent extractor with message formatted as a single guest message
          const intentResult = await extractIntent(
            [{ role: 'guest', content: msg }],
            tenantId,
            'gap-analysis'
          );

          const labels = intentResult?.sops ?? [];
          if (labels.length === 0) continue;

          // Save as ClassifierExample with active=false (pending approval)
          try {
            await prisma.classifierExample.create({
              data: {
                tenantId,
                text: msg,
                labels,
                source: 'gap-analysis',
                active: false,
              },
            });
            existingTexts.add(msg); // prevent duplicates within this run
            suggestedCount++;
          } catch (err: any) {
            // Skip unique constraint violations (text already exists)
            if (err?.code === 'P2002') continue;
            throw err;
          }
        }

        res.json({
          emptyLabelMessages: emptyLabelEvals.length,
          underrepresentedCategories,
          languageDistribution: langDist,
          suggestedExamples: suggestedCount,
          message: `Generated ${suggestedCount} suggested examples. Review in classifier examples UI.`,
        });
      } catch (err) {
        console.error('[Knowledge] gapAnalysis error:', err);
        res.status(500).json({ error: 'Failed to run gap analysis' });
      }
    },

    async retrainClassifier(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;

        // 1. Fetch all active ClassifierExample from DB (global — no tenantId filter)
        const dbExamples = await prisma.classifierExample.findMany({
          where: { active: true },
          select: { text: true, labels: true },
        });

        // 2. Merge hardcoded base examples + DB examples (deduplicated by text)
        const baseExamples = TRAINING_EXAMPLES.map(ex => ({
          text: ex.text,
          labels: ex.labels,
        }));
        const baseTexts = new Set(baseExamples.map(e => e.text));
        const newExamples = dbExamples
          .map(ex => ({ text: ex.text, labels: ex.labels as string[] }))
          .filter(e => !baseTexts.has(e.text));
        const mergedExamples = [...baseExamples, ...newExamples];

        // 3. Get Cohere API key
        const cohereApiKey = process.env.COHERE_API_KEY;
        if (!cohereApiKey) {
          res.status(400).json({ error: 'COHERE_API_KEY not configured — required for LR training' });
          return;
        }

        // 4. Call the Python training script using execFile (safe from injection)
        const scriptPath = path.join(__dirname, '../../scripts/train_classifier.py');
        const outputPath = path.join(__dirname, '../config/classifier-weights.json');

        const summary = await new Promise<any>((resolve, reject) => {
          const child = execFile('python3', [scriptPath, '--output', outputPath], {
            timeout: 120000, // 2 min max
          }, (error, stdout, stderr) => {
            if (error) {
              console.error('[retrainClassifier] Script error:', error.message);
              console.error('[retrainClassifier] stderr:', stderr);
              reject(new Error(`Training script failed: ${error.message}\n${stderr}`));
              return;
            }

            if (stderr) {
              console.log('[retrainClassifier] Progress:', stderr);
            }

            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseErr) {
              reject(new Error(`Failed to parse training output: ${stdout}`));
            }
          });

          // Write input to stdin
          child.stdin?.write(JSON.stringify({ examples: mergedExamples, cohereApiKey }));
          child.stdin?.end();
        });

        // 5. Reload LR weights metadata
        loadLrWeightsMetadata();

        // 6. Trigger atomic swap reinit of the LR classifier
        await reinitializeClassifier(tenantId, prisma);

        res.json(summary);
      } catch (err: any) {
        console.error('[Knowledge] retrainClassifier error:', err);
        res.status(500).json({ error: err.message || 'Failed to retrain classifier' });
      }
    },

    async rateMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const { id: messageId } = req.params;
        const { rating, correction } = req.body as {
          rating: 'positive' | 'negative';
          correction?: string[];  // labels array for thumbs-down corrections
        };
        if (!['positive', 'negative'].includes(rating)) {
          res.status(400).json({ error: 'rating must be positive or negative' });
          return;
        }
        const msg = await prisma.message.findFirst({ where: { id: messageId, tenantId } });
        if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

        // Save or update the rating
        await prisma.messageRating.upsert({
          where: { messageId },
          create: { messageId, rating },
          update: { rating },
        });

        // ─── Self-improvement: connect rating to classifier training ─────────

        // Find the preceding guest message in this conversation (the message the AI was responding to)
        const precedingGuestMsg = await prisma.message.findFirst({
          where: {
            conversationId: msg.conversationId,
            tenantId,
            role: 'GUEST',
            sentAt: { lt: msg.sentAt },
          },
          orderBy: { sentAt: 'desc' },
        });

        let exampleCreated = false;

        if (rating === 'negative' && correction && Array.isArray(correction) && correction.length > 0 && precedingGuestMsg) {
          // ── Thumbs-down with correction labels ──────────────────────────────
          // Create an operator-correction ClassifierExample (immediately active)
          const guestText = precedingGuestMsg.content.trim();
          if (guestText) {
            try {
              // Deactivate any judge-generated example for the same message text
              await prisma.classifierExample.updateMany({
                where: {
                  tenantId,
                  text: guestText,
                  source: { in: ['judge-auto-fix', 'judge-correct'] },
                  active: true,
                },
                data: { active: false },
              });

              // Create or update the operator correction example
              await prisma.classifierExample.upsert({
                where: { tenantId_text: { tenantId, text: guestText } },
                create: {
                  tenantId,
                  text: guestText,
                  labels: correction,
                  source: 'operator-correction',
                  active: true,
                },
                update: {
                  labels: correction,
                  source: 'operator-correction',
                  active: true,
                },
              });
              exampleCreated = true;

              // Trigger classifier reinit in the background
              reinitializeClassifier(tenantId, prisma).catch(err =>
                console.error('[Rating] Classifier reinit after operator correction failed:', err)
              );
              console.log(`[Rating] Operator correction: "${guestText.substring(0, 60)}..." -> [${correction.join(', ')}]`);
            } catch (err: any) {
              console.error('[Rating] Failed to create operator-correction example:', err);
            }
          }
        } else if (rating === 'positive' && precedingGuestMsg) {
          // ── Thumbs-up reinforcement for low-confidence classifications ──────
          // Look up the AiApiLog for this conversation to get classifier topSimilarity
          try {
            const aiLog = await prisma.aiApiLog.findFirst({
              where: { tenantId, conversationId: msg.conversationId },
              orderBy: { createdAt: 'desc' },
              select: { ragContext: true },
            });

            const ragCtx = aiLog?.ragContext as any;
            const classifierConfidence = ragCtx?.classifierConfidence ?? ragCtx?.classifierTopSim ?? null;
            const classifierLabels = ragCtx?.classifierLabels as string[] | undefined;

            if (
              classifierConfidence !== null &&
              classifierConfidence < 0.40 &&
              classifierLabels &&
              classifierLabels.length > 0
            ) {
              const guestText = precedingGuestMsg.content.trim();
              if (guestText) {
                // Create a reinforcement example (immediately active)
                await prisma.classifierExample.upsert({
                  where: { tenantId_text: { tenantId, text: guestText } },
                  create: {
                    tenantId,
                    text: guestText,
                    labels: classifierLabels,
                    source: 'operator-reinforcement',
                    active: true,
                  },
                  update: {
                    labels: classifierLabels,
                    source: 'operator-reinforcement',
                    active: true,
                  },
                });
                exampleCreated = true;

                // Trigger classifier reinit in the background
                reinitializeClassifier(tenantId, prisma).catch(err =>
                  console.error('[Rating] Classifier reinit after operator reinforcement failed:', err)
                );
                console.log(`[Rating] Operator reinforcement (LR confidence=${classifierConfidence.toFixed(3)}): "${guestText.substring(0, 60)}..." -> [${classifierLabels.join(', ')}]`);
              }
            }
          } catch (err) {
            console.error('[Rating] Failed to process thumbs-up reinforcement:', err);
          }
        }

        res.json({ ok: true, exampleCreated });
      } catch (err) {
        console.error('[Knowledge] rateMessage error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
