/**
 * Feature 041 sprint 05 §2 — SOP / FAQ history snapshot helper.
 *
 * Closes concern C17. Single helper called from BOTH the legacy
 * /accept controller path and the sprint-04 suggestion_action tool path
 * before the corresponding artifact mutation, so every accept/apply lands a
 * snapshot row in `SopVariantHistory` or `FaqEntryHistory`.
 *
 * Snapshot semantics:
 *   - SopVariant + SopPropertyOverride share `SopVariantHistory` because both
 *     are SOP-content edits at the same conceptual layer. previousContent is
 *     a kind-tagged JSON object so a rollback can route to the right table.
 *   - FAQ snapshots capture the full row (question + answer + category +
 *     scope + propertyId + status) so a rollback can restore even after a
 *     question rename.
 *   - When the artifact is being created (no prior row), nothing is written —
 *     a creation event is not a rollback target.
 */
import { Prisma, type PrismaClient } from '@prisma/client';

export type SopHistoryKind = 'variant' | 'override';

export interface SopVariantSnapshotInput {
  tenantId: string;
  targetId: string; // SopVariant.id or SopPropertyOverride.id
  kind: SopHistoryKind;
  sopDefinitionId: string;
  status: string;
  content: string;
  propertyId?: string | null;
  metadata?: Record<string, unknown>;
  editedByUserId?: string | null;
  triggeringSuggestionId?: string | null;
}

export interface FaqSnapshotInput {
  tenantId: string;
  targetId: string;
  question: string;
  answer: string;
  category: string;
  scope: string;
  propertyId: string | null;
  status: string;
  metadata?: Record<string, unknown>;
  editedByUserId?: string | null;
  triggeringSuggestionId?: string | null;
}

/**
 * Snapshot a SopVariant (or SopPropertyOverride) into history. Best-effort —
 * never throws into the caller. The accept/apply path must succeed even if
 * snapshot capture fails (it's a follow-on improvement, not a gate).
 */
export async function snapshotSopVariant(
  prisma: PrismaClient,
  input: SopVariantSnapshotInput
): Promise<{ id: string } | null> {
  try {
    const previousContent: Prisma.InputJsonValue = {
      kind: input.kind,
      sopDefinitionId: input.sopDefinitionId,
      status: input.status,
      content: input.content,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
    };
    const row = await prisma.sopVariantHistory.create({
      data: {
        tenantId: input.tenantId,
        targetId: input.targetId,
        previousContent,
        previousMetadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        editedByUserId: input.editedByUserId ?? null,
        triggeringSuggestionId: input.triggeringSuggestionId ?? null,
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    console.warn('[ArtifactHistory] snapshotSopVariant failed (non-fatal):', err);
    return null;
  }
}

/**
 * Snapshot a FaqEntry into history. Best-effort.
 */
export async function snapshotFaqEntry(
  prisma: PrismaClient,
  input: FaqSnapshotInput
): Promise<{ id: string } | null> {
  try {
    const previousContent: Prisma.InputJsonValue = {
      question: input.question,
      answer: input.answer,
      category: input.category,
      scope: input.scope,
      propertyId: input.propertyId,
      status: input.status,
    };
    const row = await prisma.faqEntryHistory.create({
      data: {
        tenantId: input.tenantId,
        targetId: input.targetId,
        previousContent,
        previousMetadata: input.metadata
          ? (input.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        editedByUserId: input.editedByUserId ?? null,
        triggeringSuggestionId: input.triggeringSuggestionId ?? null,
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    console.warn('[ArtifactHistory] snapshotFaqEntry failed (non-fatal):', err);
    return null;
  }
}

/**
 * Lightweight loader for the history controller — returns recent SOP+FAQ
 * snapshot entries the manager can rollback to.
 */
export async function listSopVariantHistory(prisma: PrismaClient, tenantId: string, limit = 40) {
  return prisma.sopVariantHistory.findMany({
    where: { tenantId },
    orderBy: { editedAt: 'desc' },
    take: limit,
  });
}

export async function listFaqEntryHistory(prisma: PrismaClient, tenantId: string, limit = 40) {
  return prisma.faqEntryHistory.findMany({
    where: { tenantId },
    orderBy: { editedAt: 'desc' },
    take: limit,
  });
}
