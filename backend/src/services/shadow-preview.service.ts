/**
 * Feature 040: Copilot Shadow Mode — preview lifecycle helpers.
 *
 * When TenantAiConfig.shadowModeEnabled is true, copilot AI replies are rendered
 * as in-chat preview bubbles (Message rows with previewState=PREVIEW_PENDING)
 * instead of the legacy suggestion-card flow.
 *
 * This service contains the small helpers that support the shadow-mode branch
 * in ai.service.ts and the Send endpoint in shadow-preview.controller.ts.
 */
import { PrismaClient } from '@prisma/client';

/**
 * Lock every currently-pending preview on a conversation by transitioning them
 * from PREVIEW_PENDING to PREVIEW_LOCKED. Called immediately before creating a
 * new preview so the "only the latest preview is actionable" invariant holds.
 *
 * Returns the ids of the rows that were just locked so the caller can broadcast
 * a 'shadow_preview_locked' socket event and let any open inbox client discard
 * an in-progress edit buffer on one of them (FR-011a).
 */
export async function lockOlderPreviews(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string
): Promise<string[]> {
  // Find the rows first so we can return their ids.
  const pending = await prisma.message.findMany({
    where: {
      tenantId,
      conversationId,
      previewState: 'PREVIEW_PENDING',
    },
    select: { id: true },
  });

  if (pending.length === 0) return [];

  const ids = pending.map(m => m.id);

  await prisma.message.updateMany({
    where: { id: { in: ids } },
    data: { previewState: 'PREVIEW_LOCKED' },
  });

  return ids;
}
