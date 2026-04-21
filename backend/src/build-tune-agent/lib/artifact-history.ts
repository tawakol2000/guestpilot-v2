/**
 * Sprint 053-A D2 — write-ledger emission helper.
 *
 * One entry point: `emitArtifactHistory(prisma, ctx, payload)`. Best-effort
 * persistence — wraps the insert in try/catch and logs on failure. NEVER
 * propagate the error back to the caller; the real write must not roll
 * back because of a history-row failure.
 *
 * Sanitiser parity: tool_definition prevBody/newBody MUST run through
 * sanitiseArtifactPayload before storage. Same function backs the D1
 * dry-run preview path, so a secret hidden in the preview is hidden here.
 *
 * Property-override sanitisation: today overrides are plain text; the JSON
 * shape is just `{ content: string }`. We do NOT sanitise property_override
 * rows — see open question §8 in the sprint spec.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { sanitiseArtifactPayload } from './sanitise-artifact-payload';

export type ArtifactHistoryType =
  | 'sop'
  | 'faq'
  | 'system_prompt'
  | 'tool_definition'
  | 'property_override';

export type ArtifactHistoryOperation =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'REVERT';

export interface ArtifactHistoryInput {
  tenantId: string;
  artifactType: ArtifactHistoryType;
  artifactId: string;
  operation: ArtifactHistoryOperation;
  prevBody?: unknown;
  newBody?: unknown;
  actorUserId?: string | null;
  actorEmail?: string | null;
  conversationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function emitArtifactHistory(
  prisma: PrismaClient,
  input: ArtifactHistoryInput,
): Promise<{ historyId: string | null }> {
  try {
    const sanitise = input.artifactType === 'tool_definition';
    const prev =
      input.prevBody === undefined
        ? null
        : sanitise
        ? sanitiseArtifactPayload(input.prevBody)
        : input.prevBody;
    const next =
      input.newBody === undefined
        ? null
        : sanitise
        ? sanitiseArtifactPayload(input.newBody)
        : input.newBody;

    const row = await prisma.buildArtifactHistory.create({
      data: {
        tenantId: input.tenantId,
        artifactType: input.artifactType,
        artifactId: input.artifactId,
        operation: input.operation,
        prevBody: prev as Prisma.InputJsonValue,
        newBody: next as Prisma.InputJsonValue,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        conversationId: input.conversationId ?? null,
        metadata: (input.metadata ?? null) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { historyId: row.id };
  } catch (err) {
    // Best-effort: log + continue. The real write already succeeded.
    // eslint-disable-next-line no-console
    console.error('[build] emitArtifactHistory failed (logged, not raised):', err);
    return { historyId: null };
  }
}

/**
 * Sprint 054-A F3 — writeback of a test-pipeline verification result
 * onto the triggering history row's metadata.testResult. Appends one
 * variant entry and recomputes aggregateVerdict in a single update.
 *
 * Best-effort: a failed writeback (row gone, DB down) is logged and
 * swallowed. The ritual itself does not fail because of a writeback
 * miss — the chat card still renders.
 */
export interface VerificationVariantInput {
  triggerMessage: string;
  pipelineOutput: string;
  verdict: 'passed' | 'failed';
  judgeReasoning: string;
  judgePromptVersion: string;
  ranAt: string;
}

export interface VerificationTestResult {
  variants: VerificationVariantInput[];
  aggregateVerdict: 'all_passed' | 'partial' | 'all_failed';
  ritualVersion: string;
}

export function computeAggregateVerdict(
  variants: VerificationVariantInput[],
): VerificationTestResult['aggregateVerdict'] {
  if (variants.length === 0) return 'all_failed';
  const passed = variants.filter((v) => v.verdict === 'passed').length;
  if (passed === variants.length) return 'all_passed';
  if (passed === 0) return 'all_failed';
  return 'partial';
}

export async function appendVerificationResult(
  prisma: PrismaClient,
  historyId: string,
  newVariants: VerificationVariantInput[],
  ritualVersion: string,
): Promise<void> {
  try {
    const existing = await prisma.buildArtifactHistory.findUnique({
      where: { id: historyId },
      select: { metadata: true },
    });
    if (!existing) return;
    const prevMeta =
      (existing.metadata && typeof existing.metadata === 'object'
        ? (existing.metadata as Record<string, unknown>)
        : {}) ?? {};
    const prevResult =
      typeof prevMeta.testResult === 'object' && prevMeta.testResult !== null
        ? (prevMeta.testResult as Partial<VerificationTestResult>)
        : null;
    const mergedVariants: VerificationVariantInput[] = [
      ...(Array.isArray(prevResult?.variants) ? (prevResult!.variants as VerificationVariantInput[]) : []),
      ...newVariants,
    ];
    const nextResult: VerificationTestResult = {
      variants: mergedVariants,
      aggregateVerdict: computeAggregateVerdict(mergedVariants),
      ritualVersion,
    };
    const nextMeta = {
      ...prevMeta,
      testResult: nextResult,
    };
    await prisma.buildArtifactHistory.update({
      where: { id: historyId },
      data: { metadata: nextMeta as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[build] appendVerificationResult failed (logged, not raised):', err);
  }
}
