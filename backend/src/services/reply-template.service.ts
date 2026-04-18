// Feature 043 — render reply templates for action-card escalations.
//
// Single source of truth for "given (tenant, escalation type, decision), what
// message text do we send to the guest?" — used by both the manual accept path
// (task-actions.controller preview + send) and the auto-accept pipeline.
//
// Variable substitution is intentionally simple `{VAR}` → value. Unknown
// variables render as empty string (FR-017); never block the send.
import { PrismaClient } from '@prisma/client';
import { getDefaultReplyTemplate } from '../config/reply-template-defaults';
import {
  resolveCheckInTime,
  resolveCheckOutTime,
} from './template-variable.service';

export interface RenderContext {
  conversationId: string;
  requestedTime?: string | null; // HH:MM — optional (reject paths may omit)
}

// Format "HH:MM" (24h) → friendly "h:mm AM/PM". Passes through unparseable.
function friendlyTime(time: string | null | undefined): string {
  if (!time) return '';
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return time;
  let h = parseInt(m[1], 10);
  const min = m[2];
  if (Number.isNaN(h) || h < 0 || h > 23) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${period}`;
}

function firstWord(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().split(/\s+/)[0] || '';
}

/**
 * Resolve and substitute variables in a reply template body.
 * Unknown variables render as empty string. Never throws for variable issues.
 */
export async function renderReplyTemplate(
  tenantId: string,
  escalationType: string,
  decision: 'approve' | 'reject',
  context: RenderContext,
  prisma: PrismaClient
): Promise<string> {
  // 1. Load template body: tenant override → system default → hardcoded fallback.
  let body: string | null = null;

  const row = await prisma.automatedReplyTemplate.findUnique({
    where: {
      tenantId_escalationType_decision: {
        tenantId,
        escalationType,
        decision,
      },
    },
    select: { body: true },
  });
  if (row?.body) body = row.body;

  if (!body) body = getDefaultReplyTemplate(escalationType, decision);

  if (!body) {
    // Last-resort fallback so the send never blocks on misconfigured types.
    console.warn(
      `[ReplyTemplate] no default for (${escalationType}, ${decision}) — using bare fallback`
    );
    body = decision === 'approve'
      ? "Hi {GUEST_FIRST_NAME} — confirmed."
      : "Hi {GUEST_FIRST_NAME} — unfortunately we can't accommodate that.";
  }

  // 2. Load substitution context via the conversation (one query fans out to
  //    everything we need: guest, reservation, property).
  const conv = await prisma.conversation.findFirst({
    where: { id: context.conversationId, tenantId },
    include: {
      guest: { select: { name: true } },
      reservation: { select: { scheduledCheckInAt: true, scheduledCheckOutAt: true } },
      property: { select: { name: true, customKnowledgeBase: true } },
    },
  });

  const vars: Record<string, string> = {
    GUEST_FIRST_NAME: firstWord(conv?.guest?.name),
    REQUESTED_TIME: friendlyTime(context.requestedTime),
    PROPERTY_NAME: conv?.property?.name ?? '',
    CHECK_IN_TIME: friendlyTime(resolveCheckInTime(conv?.reservation, conv?.property)),
    CHECK_OUT_TIME: friendlyTime(resolveCheckOutTime(conv?.reservation, conv?.property)),
  };

  // 3. Substitute. Unknown {VAR} renders as empty string (FR-017).
  return body.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
    return vars[key] ?? '';
  });
}
