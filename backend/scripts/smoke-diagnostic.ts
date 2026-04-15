/**
 * Feature 041 sprint 02 §8 — end-to-end smoke for the diagnostic pipeline.
 *
 * Picks a recent edited Message (originalAiText set and != content) off the
 * live DB, runs runDiagnostic + writeSuggestionFromDiagnostic, and prints:
 *   - the resolved messageId
 *   - the assembled EvidenceBundle row id (on Postgres)
 *   - the DiagnosticResult
 *   - the written TuningSuggestion (or null if NO_FIX / MISSING_CAPABILITY
 *     or cooldown)
 *
 * Usage:
 *   npx tsx scripts/smoke-diagnostic.ts [messageId]
 *
 * Cleanup the rows this script inserts:
 *   --- paste into psql ---
 *   DELETE FROM "TuningSuggestion" WHERE "diagnosticSubLabel" LIKE 'smoke-%';
 *   DELETE FROM "CapabilityRequest" WHERE title LIKE 'smoke-%';
 *   -- The EvidenceBundle rows are kept so you can inspect them in Studio.
 *   -- Manual deletion if desired:
 *   DELETE FROM "EvidenceBundle" WHERE "createdAt" > NOW() - INTERVAL '1 hour';
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runDiagnostic } from '../src/services/tuning/diagnostic.service';
import { writeSuggestionFromDiagnostic } from '../src/services/tuning/suggestion-writer.service';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const argMessageId = process.argv[2];
    let messageId: string | null = argMessageId ?? null;
    let tenantId: string;

    if (!messageId) {
      const candidate = await prisma.message.findFirst({
        where: {
          role: 'AI',
          originalAiText: { not: null },
          NOT: [{ originalAiText: { equals: '' } }],
        },
        orderBy: { sentAt: 'desc' },
        select: {
          id: true,
          tenantId: true,
          sentAt: true,
          originalAiText: true,
          content: true,
        },
      });
      if (!candidate) {
        console.error('[smoke-diagnostic] no edited AI messages in DB. Pass an explicit messageId.');
        process.exit(1);
      }
      if (candidate.originalAiText === candidate.content) {
        console.warn('[smoke-diagnostic] most-recent candidate has originalAiText == content; falling back anyway.');
      }
      messageId = candidate.id;
      tenantId = candidate.tenantId;
      console.error(
        `[smoke-diagnostic] using messageId=${candidate.id} tenant=${candidate.tenantId} sentAt=${candidate.sentAt.toISOString()}`
      );
    } else {
      const msg = await prisma.message.findUnique({
        where: { id: messageId },
        select: { tenantId: true },
      });
      if (!msg) {
        console.error(`[smoke-diagnostic] message ${messageId} not found`);
        process.exit(1);
      }
      tenantId = msg.tenantId;
    }

    const result = await runDiagnostic(
      {
        triggerType: 'EDIT_TRIGGERED',
        tenantId,
        messageId: messageId!,
        note: 'sprint-02 smoke-diagnostic',
      },
      prisma
    );

    if (!result) {
      console.error('[smoke-diagnostic] runDiagnostic returned null (OPENAI_API_KEY missing or call failed).');
      process.exit(0);
    }

    // Force a recognizable sub-label so the cleanup SQL in the header actually
    // matches our rows. We rewrite it before the suggestion write.
    const labeledResult = { ...result, subLabel: `smoke-${result.subLabel}` };
    const outcome = await writeSuggestionFromDiagnostic(labeledResult, {}, prisma);

    const report = {
      messageId,
      tenantId,
      diagnostic: {
        category: result.category,
        subLabel: result.subLabel,
        confidence: result.confidence,
        rationale: result.rationale,
        proposedText: result.proposedText,
        artifactTarget: result.artifactTarget,
        capabilityRequest: result.capabilityRequest,
        similarity: result.diagMeta.similarity,
        magnitude: result.diagMeta.magnitude,
      },
      evidenceBundleId: result.evidenceBundleId,
      written: {
        note: outcome.note,
        suggestionId: outcome.suggestion?.id ?? null,
        capabilityRequestId: outcome.capabilityRequestId,
      },
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (err) {
    console.error('[smoke-diagnostic] threw:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
