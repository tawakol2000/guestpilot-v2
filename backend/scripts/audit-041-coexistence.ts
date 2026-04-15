/**
 * Sprint 05 §10 — read-only DB-coexistence audit for the feature 041 schema.
 *
 * Confirms:
 *   - Each new table exists and counts rows (is the new branch writing?).
 *   - For each new nullable column on existing tables, counts null vs
 *     non-null (proves both old-branch writers and new-branch writers
 *     coexist on the same table).
 *
 * Usage:
 *   npx tsx scripts/audit-041-coexistence.ts
 *
 * Or with Railway env:
 *   railway run --service guestpilot-v2 --environment production npx tsx scripts/audit-041-coexistence.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const audit: Record<string, unknown> = {};

    // New tables (sprint 01, 02, 05).
    audit.newTables = {
      TuningConversation: await prisma.tuningConversation.count(),
      TuningMessage: await prisma.tuningMessage.count(),
      AgentMemory: await prisma.agentMemory.count(),
      EvidenceBundle: await prisma.evidenceBundle.count(),
      CapabilityRequest: await prisma.capabilityRequest.count(),
      PreferencePair: await prisma.preferencePair.count(),
      TuningCategoryStats: await prisma.tuningCategoryStats.count(),
      SopVariantHistory: await prisma.sopVariantHistory.count(),
      FaqEntryHistory: await prisma.faqEntryHistory.count(),
    };

    // Nullable extensions on existing tables — null vs non-null cohort sizes.
    const newColumns = [
      // TuningSuggestion (sprint 01 + sprint 02).
      `SELECT 'TuningSuggestion' as "t", 'applyMode' as "col",
         COUNT(*) FILTER (WHERE "applyMode" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "applyMode" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'conversationId' as "col",
         COUNT(*) FILTER (WHERE "conversationId" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "conversationId" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'confidence' as "col",
         COUNT(*) FILTER (WHERE "confidence" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "confidence" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'appliedAndRetained7d' as "col",
         COUNT(*) FILTER (WHERE "appliedAndRetained7d" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "appliedAndRetained7d" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'editEmbedding' as "col",
         COUNT(*) FILTER (WHERE "editEmbedding" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "editEmbedding" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'diagnosticCategory' as "col",
         COUNT(*) FILTER (WHERE "diagnosticCategory" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "diagnosticCategory" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'diagnosticSubLabel' as "col",
         COUNT(*) FILTER (WHERE "diagnosticSubLabel" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "diagnosticSubLabel" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'triggerType' as "col",
         COUNT(*) FILTER (WHERE "triggerType" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "triggerType" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      `SELECT 'TuningSuggestion' as "t", 'evidenceBundleId' as "col",
         COUNT(*) FILTER (WHERE "evidenceBundleId" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "evidenceBundleId" IS NOT NULL) as "nonNulls"
       FROM "TuningSuggestion"`,
      // AiConfigVersion (sprint 01).
      `SELECT 'AiConfigVersion' as "t", 'experimentId' as "col",
         COUNT(*) FILTER (WHERE "experimentId" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "experimentId" IS NOT NULL) as "nonNulls"
       FROM "AiConfigVersion"`,
      `SELECT 'AiConfigVersion' as "t", 'trafficPercent' as "col",
         COUNT(*) FILTER (WHERE "trafficPercent" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "trafficPercent" IS NOT NULL) as "nonNulls"
       FROM "AiConfigVersion"`,
      // Message (sprint 05).
      `SELECT 'Message' as "t", 'editMagnitudeScore' as "col",
         COUNT(*) FILTER (WHERE "editMagnitudeScore" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "editMagnitudeScore" IS NOT NULL) as "nonNulls"
       FROM "Message"`,
      // TuningConversation.sdkSessionId (sprint 01).
      `SELECT 'TuningConversation' as "t", 'sdkSessionId' as "col",
         COUNT(*) FILTER (WHERE "sdkSessionId" IS NULL) as "nulls",
         COUNT(*) FILTER (WHERE "sdkSessionId" IS NOT NULL) as "nonNulls"
       FROM "TuningConversation"`,
    ];

    const cohorts: Array<Record<string, unknown>> = [];
    for (const sql of newColumns) {
      const rows: Array<{ t: string; col: string; nulls: bigint; nonNulls: bigint }> =
        await prisma.$queryRawUnsafe(sql);
      for (const r of rows) {
        cohorts.push({
          table: r.t,
          column: r.col,
          nulls: Number(r.nulls),
          nonNulls: Number(r.nonNulls),
        });
      }
    }
    audit.cohorts = cohorts;

    // Old-branch writes still succeed: read a recent TuningSuggestion row that
    // the live `main` analyzer would have written (no diagnosticCategory,
    // no triggerType) and confirm it deserializes cleanly.
    const legacyRow = await prisma.tuningSuggestion.findFirst({
      where: { diagnosticCategory: null, triggerType: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, actionType: true, status: true, createdAt: true },
    });
    audit.legacyRowSample = legacyRow;

    // New-pipeline write also coexists: a TuningSuggestion with diagnosticCategory set.
    const newPipelineRow = await prisma.tuningSuggestion.findFirst({
      where: { diagnosticCategory: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, diagnosticCategory: true, confidence: true, triggerType: true, createdAt: true },
    });
    audit.newPipelineRowSample = newPipelineRow;

    process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
  } catch (err) {
    console.error('[audit-041-coexistence] failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
