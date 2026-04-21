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
): Promise<void> {
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

    await prisma.buildArtifactHistory.create({
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
    });
  } catch (err) {
    // Best-effort: log + continue. The real write already succeeded.
    // eslint-disable-next-line no-console
    console.error('[build] emitArtifactHistory failed (logged, not raised):', err);
  }
}
