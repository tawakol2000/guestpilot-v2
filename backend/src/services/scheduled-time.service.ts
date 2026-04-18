// Feature 043 — scheduled-time policy evaluator + auto-accept applier.
//
// Called by the AI pipeline (ai.service.ts) when the coordinator emits
// parsed.scheduledTime. Evaluates the property/tenant threshold and, if the
// request falls within policy, applies the override, delivers the templated
// approval, writes a resolved Task + TaskActionLog, and returns true so the
// caller knows to skip creating an escalation card.
//
// Policy-as-authority (Constitution §III carve-out, research.md Decision 1):
// auto-accept fires ONLY when an operator has explicitly configured a threshold
// — the AI merely mirrors the policy.
import { PrismaClient, MessageRole } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { renderReplyTemplate } from './reply-template.service';
import { broadcastToTenant } from './socket.service';

export interface EvaluateOpts {
  tenantId: string;
  conversationId: string;
  propertyId: string | null | undefined;
  scheduledTime: { kind: 'check_in' | 'check_out'; time: string };
}

/**
 * Lexicographic string compare on HH:MM (24-h) matches numeric ordering for
 * valid inputs. Callers should regex-validate shape before calling.
 */
function within(kind: 'check_in' | 'check_out', requested: string, threshold: string): boolean {
  if (kind === 'check_out') return requested <= threshold;
  return requested >= threshold;
}

/**
 * Evaluate the effective threshold (property → tenant default) and, if the
 * request falls within policy, run the full auto-accept side effects. Returns
 * true iff the caller should SKIP creating an escalation task.
 *
 * Always returns (never throws) — errors degrade to the escalation path.
 */
export async function evaluateAndMaybeApply(
  opts: EvaluateOpts,
  prisma: PrismaClient
): Promise<boolean> {
  const { tenantId, conversationId, propertyId, scheduledTime } = opts;

  try {
    if (!propertyId) return false;

    const [property, tenant] = await Promise.all([
      prisma.property.findFirst({
        where: { id: propertyId, tenantId },
        select: {
          id: true,
          autoAcceptLateCheckoutUntil: true,
          autoAcceptEarlyCheckinFrom: true,
        },
      }),
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          defaultAutoAcceptLateCheckoutUntil: true,
          defaultAutoAcceptEarlyCheckinFrom: true,
        },
      }),
    ]);

    if (!property || !tenant) return false;

    const threshold =
      scheduledTime.kind === 'check_out'
        ? property.autoAcceptLateCheckoutUntil ?? tenant.defaultAutoAcceptLateCheckoutUntil
        : property.autoAcceptEarlyCheckinFrom ?? tenant.defaultAutoAcceptEarlyCheckinFrom;

    if (!threshold) {
      console.log(
        `[ScheduledTime] no threshold configured — escalating. conv=${conversationId} kind=${scheduledTime.kind} time=${scheduledTime.time}`
      );
      return false;
    }

    if (!within(scheduledTime.kind, scheduledTime.time, threshold)) {
      console.log(
        `[ScheduledTime] outside threshold — escalating. conv=${conversationId} kind=${scheduledTime.kind} requested=${scheduledTime.time} threshold=${threshold}`
      );
      return false;
    }

    // Within policy — auto-accept.
    console.log(
      `[ScheduledTime] auto-accepting. conv=${conversationId} kind=${scheduledTime.kind} requested=${scheduledTime.time} threshold=${threshold}`
    );

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { tenant: true, reservation: true },
    });
    if (!conversation) return false;

    const escalationType =
      scheduledTime.kind === 'check_in' ? 'early_checkin_request' : 'late_checkout_request';

    const body = await renderReplyTemplate(
      tenantId,
      escalationType,
      'approve',
      { conversationId, requestedTime: scheduledTime.time },
      prisma
    );

    // Deliver to guest via Hostaway. If send fails, bail to escalation path so
    // the manager can handle it manually — don't persist any override.
    let hostawayMsgId = '';
    if (conversation.hostawayConversationId) {
      try {
        const hwResult = await hostawayService.sendMessageToConversation(
          conversation.tenant.hostawayAccountId,
          conversation.tenant.hostawayApiKey,
          conversation.hostawayConversationId,
          body,
          'channel'
        );
        hostawayMsgId = String((hwResult as any)?.result?.id || '');
      } catch (err: any) {
        console.warn(`[ScheduledTime] Hostaway send failed during auto-accept: ${err?.message}. Falling back to escalation.`);
        return false;
      }
    }

    // Persist: Message, Reservation override, resolved Task, audit log.
    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          tenantId,
          role: MessageRole.HOST,
          content: body,
          channel: conversation.channel,
          communicationType: 'channel',
          sentAt: new Date(),
          hostawayMessageId: hostawayMsgId,
          deliveryStatus: conversation.hostawayConversationId ? 'sent' : 'pending',
          deliveredAt: conversation.hostawayConversationId ? new Date() : null,
          source: 'ai',
        },
      });

      await tx.conversation.updateMany({
        where: { id: conversationId, tenantId },
        data: { lastMessageAt: new Date() },
      });

      const updatedReservation = conversation.reservationId
        ? await tx.reservation.update({
            where: { id: conversation.reservationId },
            data:
              scheduledTime.kind === 'check_in'
                ? { scheduledCheckInAt: scheduledTime.time }
                : { scheduledCheckOutAt: scheduledTime.time },
            select: { id: true, scheduledCheckInAt: true, scheduledCheckOutAt: true },
          })
        : null;

      // Create a resolved Task so the audit log is uniform with the manual
      // path (INV-5 adjusted).
      const task = await tx.task.create({
        data: {
          tenantId,
          conversationId,
          propertyId,
          title: escalationType,
          note: '',
          urgency: 'scheduled',
          type: escalationType,
          status: 'resolved',
          source: 'ai',
          metadata: { kind: scheduledTime.kind, requestedTime: scheduledTime.time },
          completedAt: new Date(),
        },
      });

      await tx.taskActionLog.create({
        data: {
          tenantId,
          taskId: task.id,
          action: 'auto_accepted',
          actorKind: 'ai_autoaccept',
          deliveredBody: body,
          requestedTime: scheduledTime.time,
          appliedTime: scheduledTime.time,
        },
      });

      return { message, reservation: updatedReservation };
    });

    if (result.reservation) {
      broadcastToTenant(tenantId, 'reservation_scheduled_updated', {
        reservationId: result.reservation.id,
        conversationId,
        scheduledCheckInAt: result.reservation.scheduledCheckInAt,
        scheduledCheckOutAt: result.reservation.scheduledCheckOutAt,
      });
    }

    return true;
  } catch (err: any) {
    console.warn(`[ScheduledTime] evaluateAndMaybeApply failed (non-fatal, falling back to escalation): ${err?.message}`);
    return false;
  }
}
