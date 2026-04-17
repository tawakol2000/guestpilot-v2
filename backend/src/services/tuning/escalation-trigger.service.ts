/**
 * Feature 041 sprint 08 §2 — Escalation-triggered tuning events (D6).
 *
 * Wires the pre-existing `ESCALATION_TRIGGERED` trigger enum into the real
 * escalation-resolution flow. Fires when a Task with `type: 'ESCALATION'` is
 * transitioned to `status: 'completed'` AND the resolution included a host /
 * manager reply to the guest after the escalation was opened — that reply is
 * what the AI "should have said". The diagnostic pipeline runs on the AI
 * message that triggered the escalation; the resolution context surfaces via
 * the conversation window inside the evidence bundle.
 *
 * Guards (any false → silent no-op; never blocks the task update):
 *   - Task must be `type: 'ESCALATION'`.
 *   - Old status !== 'completed' AND new status === 'completed'.
 *   - Task must be linked to a conversationId.
 *   - Tenant config must have `shadowModeEnabled === true` — nearest equivalent
 *     to a "tuningEnabled" flag until we add one explicitly. Tenants that
 *     aren't using any of the tuning surfaces yet don't get their queue
 *     populated on every task close.
 *   - We must find a host / manager reply sent *after* the escalation was
 *     opened (otherwise the resolution didn't actually change the AI output).
 *   - We must find an AI message the manager was reacting to (the latest
 *     AI reply in the conversation on or before the escalation's createdAt).
 *   - Per-process 60s dedup + 48h cooldown from the suggestion writer are
 *     respected downstream without extra work here.
 *
 * Fire-and-forget: the diagnostic call is `void (async …)`. The caller
 * (`task.controller.ts`) must not await this function; any failure is logged
 * and swallowed.
 */
import {
  PrismaClient,
  MessageRole,
  type Task,
} from '@prisma/client';
import { runDiagnostic } from './diagnostic.service';
import { writeSuggestionFromDiagnostic } from './suggestion-writer.service';
import { shouldProcessTrigger } from './trigger-dedup.service';

export interface EscalationResolutionContext {
  /** Task row *before* the PATCH — used to gate on prior status and type. */
  previous: Pick<Task, 'id' | 'type' | 'status' | 'conversationId' | 'createdAt' | 'title'>;
  /** Status value from the PATCH body. */
  newStatus: string;
  /** Tenant that owns the task + conversation. */
  tenantId: string;
}

/**
 * Fire-and-forget. Returns immediately. If the guards pass, queues a
 * background diagnostic run against the AI message that triggered the
 * escalation, with triggerType = ESCALATION_TRIGGERED.
 */
export function maybeFireEscalationTrigger(
  prisma: PrismaClient,
  ctx: EscalationResolutionContext,
): void {
  // Synchronous guards — bail before spawning the async worker.
  if (ctx.previous.type !== 'ESCALATION') return;
  if (ctx.newStatus !== 'completed') return;
  if (ctx.previous.status === 'completed') return;
  if (!ctx.previous.conversationId) return;

  void (async () => {
    try {
      const conversationId = ctx.previous.conversationId!;

      // Gate on the tenant's shadow-mode / tuning participation flag. Tenants
      // without it aren't actively using the tuning pipeline, so firing on
      // every escalation close would just populate a queue nobody looks at.
      const cfg = await prisma.tenantAiConfig.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { shadowModeEnabled: true },
      });
      if (!cfg?.shadowModeEnabled) return;

      // Find the AI message the manager was reacting to: the latest AI reply
      // in the conversation on or before the escalation was opened. If none
      // exists (rare: task created against a conversation with no AI turns
      // yet), abandon — there's no "disputed message" to diagnose.
      const disputedAiMessage = await prisma.message.findFirst({
        where: {
          conversationId,
          tenantId: ctx.tenantId,
          role: MessageRole.AI,
          sentAt: { lte: ctx.previous.createdAt },
        },
        orderBy: { sentAt: 'desc' },
        select: { id: true, sentAt: true },
      });
      if (!disputedAiMessage) return;

      // Confirm the resolution included a host (or manager-private) reply
      // after the escalation was opened. This is the "signal changed" guard
      // the sprint brief calls for — just closing a task without replying
      // to the guest is not a tuning signal.
      const resolutionReply = await prisma.message.findFirst({
        where: {
          conversationId,
          tenantId: ctx.tenantId,
          role: { in: [MessageRole.HOST, MessageRole.MANAGER_PRIVATE] },
          sentAt: { gt: ctx.previous.createdAt },
        },
        orderBy: { sentAt: 'desc' },
        select: { id: true },
      });
      if (!resolutionReply) return;

      // 60s per-process dedup keyed on the disputed-message id. Double-click
      // "mark complete" or webhook retries within a minute collapse to one.
      // The 48h artifact cooldown still applies inside the suggestion writer.
      if (!shouldProcessTrigger('ESCALATION_TRIGGERED', disputedAiMessage.id)) return;

      const result = await runDiagnostic(
        {
          triggerType: 'ESCALATION_TRIGGERED',
          tenantId: ctx.tenantId,
          messageId: disputedAiMessage.id,
          note: [
            `Escalation resolved.`,
            `Task: ${ctx.previous.title}`,
            `Task created: ${ctx.previous.createdAt.toISOString()}`,
            `Resolution reply message: ${resolutionReply.id}`,
          ].join(' '),
        },
        prisma,
      );

      if (result) {
        await writeSuggestionFromDiagnostic(result, {}, prisma);
      }
      console.log(
        `[EscalationTrigger] taskId=${ctx.previous.id} disputed=${disputedAiMessage.id} resolution=${resolutionReply.id} ` +
          (result ? `diagnostic.category=${result.category}` : 'diagnostic=null'),
      );
    } catch (err) {
      console.error('[EscalationTrigger] fire-and-forget failed (non-fatal):', err);
    }
  })();
}
