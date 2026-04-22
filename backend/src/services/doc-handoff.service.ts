/**
 * Feature 044: Check-in Document Handoff via WhatsApp
 *
 * Responsibilities:
 *  - Schedule REMINDER + HANDOFF rows when a reservation is created/updated.
 *  - React to checklist updates (flip DEFERRED handoff → SCHEDULED when complete).
 *  - Polling tick: evaluate due rows, render, send via WAsender, update status.
 *
 * Contract:  see specs/044-doc-handoff-whatsapp/data-model.md for state machine.
 * Test plan: see specs/044-doc-handoff-whatsapp/quickstart.md.
 */
import { PrismaClient, Reservation, Tenant, Property } from '@prisma/client';
import {
  DOC_HANDOFF_TIMEZONE,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  MESSAGE_TYPE_HANDOFF,
  MESSAGE_TYPE_REMINDER,
  STATUS_SCHEDULED,
  STATUS_DEFERRED,
  STATUS_SENT,
  STATUS_FAILED,
  STATUS_SKIPPED_CANCELLED,
  STATUS_SKIPPED_NO_RECIPIENT,
  STATUS_SKIPPED_NO_CHECKLIST,
  STATUS_SKIPPED_NO_PROVIDER,
  STATUS_SKIPPED_FEATURE_OFF,
  ACTIVE_STATUSES,
  isValidRecipient,
} from '../config/doc-handoff-defaults';
import { DocumentChecklist, ReceivedDocRef } from './document-checklist.service';
import {
  isWasenderEnabled,
  sendText,
  sendImage,
  WasenderDisabledError,
  WasenderRequestError,
} from './wasender.service';
import { broadcastToTenant } from './socket.service';

// ── Timezone helpers ────────────────────────────────────────────────────────

/**
 * Build a Date representing a specific HH:MM on a specific calendar day in Africa/Cairo timezone,
 * returned as a UTC Date. The calendar day is derived from `referenceDate` in the target timezone.
 *
 * We use `Intl.DateTimeFormat` parts to read the TZ-local year/month/day of `referenceDate`,
 * then reconstruct the target UTC instant by subtracting the TZ's UTC offset at that date.
 */
function atLocalTime(referenceDate: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const tzFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(referenceDate);
  const part = (t: string) => Number(tzFormat.find((p) => p.type === t)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');

  // Build candidate UTC by naive construction then correct for tz offset.
  const naiveUtc = Date.UTC(year, month - 1, day, h, m, 0, 0);
  // Probe: what wall time does naiveUtc show when formatted in the target tz?
  const probed = new Intl.DateTimeFormat('en-US', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const probedH = Number(probed.find((p) => p.type === 'hour')?.value);
  const probedM = Number(probed.find((p) => p.type === 'minute')?.value);
  const diffMinutes = (h - probedH) * 60 + (m - probedM);
  return new Date(naiveUtc + diffMinutes * 60_000);
}

function minusOneDay(d: Date): Date {
  return new Date(d.getTime() - 24 * 60 * 60 * 1000);
}

function isCheckinToday(checkIn: Date, now: Date): boolean {
  const tzFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return tzFmt.format(checkIn) === tzFmt.format(now);
}

function isCheckinInPast(checkIn: Date, now: Date): boolean {
  const tzFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return tzFmt.format(checkIn) < tzFmt.format(now);
}

// ── Checklist helpers ───────────────────────────────────────────────────────

function getChecklistFromReservation(reservation: Reservation): DocumentChecklist | null {
  const sa = (reservation.screeningAnswers as any) || {};
  return (sa.documentChecklist as DocumentChecklist | undefined) ?? null;
}

function isChecklistComplete(checklist: DocumentChecklist | null): boolean {
  if (!checklist) return false;
  if (checklist.passportsReceived < checklist.passportsNeeded) return false;
  if (checklist.marriageCertNeeded && !checklist.marriageCertReceived) return false;
  return true;
}

function unitIdentifier(reservation: Reservation, property: Property): string {
  const ckb = (property.customKnowledgeBase as any) || {};
  const unitNumber = typeof ckb.unitNumber === 'string' && ckb.unitNumber.trim() ? ckb.unitNumber.trim() : null;
  const shortCode = typeof ckb.shortCode === 'string' && ckb.shortCode.trim() ? ckb.shortCode.trim() : null;
  return unitNumber ?? shortCode ?? property.name?.trim() ?? reservation.hostawayReservationId;
}

function formatDdMm(d: Date): string {
  const tzFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
  });
  return tzFmt.format(d).replace(/\s/g, '');
}

// ── Scheduling entry points ─────────────────────────────────────────────────

/**
 * Called on reservation create or when a reservation's key fields change (check-in/out/status).
 * Upserts both REMINDER and HANDOFF rows for eligible cases.
 * Never resurrects terminal rows.
 */
export async function scheduleOnReservationUpsert(
  reservationId: string,
  prisma: PrismaClient
): Promise<void> {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { tenant: true },
    });
    if (!reservation) return;
    if (reservation.status === 'CANCELLED') {
      await markCancelled(reservationId, prisma);
      return;
    }

    const now = new Date();
    if (isCheckinInPast(reservation.checkIn, now)) {
      // Nothing to schedule for past check-ins.
      return;
    }

    const tenant = reservation.tenant;
    const isWalkIn = isCheckinToday(reservation.checkIn, now);

    // ─── REMINDER ─── skipped entirely for walk-ins (clarify Q2)
    if (!isWalkIn) {
      const reminderDay = minusOneDay(reservation.checkIn);
      let reminderAt = atLocalTime(reminderDay, tenant.docHandoffReminderTime);
      if (reminderAt.getTime() < now.getTime()) reminderAt = now;
      await upsertScheduledRow(reservationId, tenant.id, MESSAGE_TYPE_REMINDER, reminderAt, prisma);
    }

    // ─── HANDOFF ───
    const checklist = getChecklistFromReservation(reservation);
    let handoffAt = atLocalTime(reservation.checkIn, tenant.docHandoffTime);
    let handoffStatus: string = STATUS_SCHEDULED;
    if (isWalkIn && handoffAt.getTime() < now.getTime()) {
      if (!checklist || isChecklistComplete(checklist)) {
        handoffAt = now;
      } else {
        handoffAt = now;
        handoffStatus = STATUS_DEFERRED;
      }
    }
    await upsertScheduledRow(reservationId, tenant.id, MESSAGE_TYPE_HANDOFF, handoffAt, prisma, handoffStatus);
  } catch (err: any) {
    console.warn('[DocHandoff] scheduleOnReservationUpsert failed (non-fatal):', err?.message ?? err);
  }
}

async function upsertScheduledRow(
  reservationId: string,
  tenantId: string,
  messageType: string,
  scheduledFireAt: Date,
  prisma: PrismaClient,
  status: string = STATUS_SCHEDULED
): Promise<void> {
  // Skip if a terminal row already exists — never re-send.
  const existing = await prisma.documentHandoffState.findUnique({
    where: { reservationId_messageType: { reservationId, messageType } },
  });
  if (existing && !ACTIVE_STATUSES.includes(existing.status as any)) return;

  await prisma.documentHandoffState.upsert({
    where: { reservationId_messageType: { reservationId, messageType } },
    create: {
      tenantId,
      reservationId,
      messageType,
      status,
      scheduledFireAt,
    },
    update: {
      scheduledFireAt,
      status,
    },
  });
}

export async function rescheduleOnReservationChange(
  reservationId: string,
  prisma: PrismaClient
): Promise<void> {
  return scheduleOnReservationUpsert(reservationId, prisma);
}

export async function markCancelled(reservationId: string, prisma: PrismaClient): Promise<void> {
  try {
    await prisma.documentHandoffState.updateMany({
      where: { reservationId, status: { in: [STATUS_SCHEDULED, STATUS_DEFERRED] } },
      data: { status: STATUS_SKIPPED_CANCELLED },
    });
  } catch (err: any) {
    console.warn('[DocHandoff] markCancelled failed (non-fatal):', err?.message ?? err);
  }
}

/**
 * Called from document-checklist.service after any checklist mutation.
 * If a DEFERRED handoff is now eligible (checklist complete), flip it to SCHEDULED at NOW().
 */
export async function onChecklistUpdated(
  reservationId: string,
  prisma: PrismaClient
): Promise<void> {
  try {
    const row = await prisma.documentHandoffState.findUnique({
      where: { reservationId_messageType: { reservationId, messageType: MESSAGE_TYPE_HANDOFF } },
    });
    if (!row || row.status !== STATUS_DEFERRED) return;

    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) return;
    const checklist = getChecklistFromReservation(reservation);
    if (!isChecklistComplete(checklist)) return;

    await prisma.documentHandoffState.update({
      where: { id: row.id },
      data: { status: STATUS_SCHEDULED, scheduledFireAt: new Date() },
    });
  } catch (err: any) {
    console.warn('[DocHandoff] onChecklistUpdated failed (non-fatal):', err?.message ?? err);
  }
}

// ── Polling evaluator ───────────────────────────────────────────────────────

export async function evaluateDueRows(prisma: PrismaClient): Promise<{
  scanned: number;
  sent: number;
  deferred: number;
  failed: number;
  skipped: number;
  claimRaces: number;
}> {
  const now = new Date();
  const rows = await prisma.documentHandoffState.findMany({
    where: {
      status: { in: [STATUS_SCHEDULED, STATUS_DEFERRED] },
      scheduledFireAt: { lte: now },
    },
    take: 500,
    orderBy: { scheduledFireAt: 'asc' },
  });
  let sent = 0;
  let deferred = 0;
  let failed = 0;
  let skipped = 0;
  let claimRaces = 0;
  for (const row of rows) {
    // Bugfix (2026-04-22): atomic claim before evaluation. Multi-instance
    // Railway deploys (or a crash + restart overlap) previously had two
    // pollers reading the same SCHEDULED row and both calling WAsender —
    // managers + security recipients received duplicate WhatsApp
    // handoffs and duplicate passport images on every check-in.
    //
    // Use `updatedAt` as the optimistic-lock sentinel (Prisma's
    // `@updatedAt` auto-touches on any successful update). The
    // updateMany returns count=1 only for the worker whose observed
    // updatedAt matches — every other concurrent worker sees count=0
    // and skips. The data write is a no-op self-set on `lastError` so
    // we don't accidentally clear other state, but it still triggers
    // the @updatedAt bump that locks subsequent claims out.
    const claim = await prisma.documentHandoffState.updateMany({
      where: {
        id: row.id,
        updatedAt: row.updatedAt,
        status: { in: [STATUS_SCHEDULED, STATUS_DEFERRED] },
      },
      data: { lastError: row.lastError ?? null },
    });
    if (claim.count === 0) {
      claimRaces += 1;
      continue;
    }

    const result = await evaluateSingleRow(row.id, prisma);
    if (result === 'sent') sent++;
    else if (result === 'deferred') deferred++;
    else if (result === 'failed') failed++;
    else if (result === 'skipped') skipped++;
  }
  return { scanned: rows.length, sent, deferred, failed, skipped, claimRaces };
}

async function evaluateSingleRow(
  rowId: string,
  prisma: PrismaClient
): Promise<'sent' | 'deferred' | 'failed' | 'skipped' | 'noop'> {
  const row = await prisma.documentHandoffState.findUnique({ where: { id: rowId } });
  if (!row) return 'noop';
  if (!ACTIVE_STATUSES.includes(row.status as any)) return 'noop';

  const reservation = await prisma.reservation.findUnique({
    where: { id: row.reservationId },
    include: { tenant: true, property: true },
  });
  if (!reservation) {
    await finalize(rowId, STATUS_SKIPPED_CANCELLED, prisma);
    return 'skipped';
  }
  if (reservation.status === 'CANCELLED') {
    await finalize(rowId, STATUS_SKIPPED_CANCELLED, prisma);
    return 'skipped';
  }
  const tenant = reservation.tenant;
  if (!tenant.docHandoffEnabled) {
    await finalize(rowId, STATUS_SKIPPED_FEATURE_OFF, prisma);
    return 'skipped';
  }
  if (!isWasenderEnabled()) {
    await finalize(rowId, STATUS_SKIPPED_NO_PROVIDER, prisma);
    return 'skipped';
  }

  const recipient =
    row.messageType === MESSAGE_TYPE_REMINDER
      ? tenant.docHandoffManagerRecipient
      : tenant.docHandoffSecurityRecipient;
  if (!recipient || !isValidRecipient(recipient)) {
    await finalize(rowId, STATUS_SKIPPED_NO_RECIPIENT, prisma);
    return 'skipped';
  }

  const checklist = getChecklistFromReservation(reservation);

  if (row.messageType === MESSAGE_TYPE_REMINDER) {
    if (!checklist) {
      await finalize(rowId, STATUS_SKIPPED_NO_CHECKLIST, prisma);
      return 'skipped';
    }
    return await doSendReminder(row.id, reservation, reservation.property, tenant, checklist, recipient, prisma);
  }

  // HANDOFF branch
  if (row.status === STATUS_DEFERRED) {
    // Only proceed if checklist is now complete.
    if (!isChecklistComplete(checklist)) {
      return 'deferred';
    }
  }
  return await doSendHandoff(row.id, reservation, reservation.property, checklist, recipient, prisma);
}

async function doSendReminder(
  rowId: string,
  reservation: Reservation,
  property: Property,
  _tenant: Tenant,
  checklist: DocumentChecklist,
  recipient: string,
  prisma: PrismaClient
): Promise<'sent' | 'failed'> {
  const text = renderReminderText(reservation, property, checklist);
  try {
    const result = await sendText({ to: recipient, text });
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        status: STATUS_SENT,
        sentAt: new Date(),
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: [],
        providerMessageId: result.providerMessageId,
        lastError: null,
      },
    });
    emitStateUpdate(rowId, prisma);
    return 'sent';
  } catch (err: any) {
    return await handleSendFailure(rowId, err, recipient, text, [], prisma);
  }
}

async function doSendHandoff(
  rowId: string,
  reservation: Reservation,
  property: Property,
  checklist: DocumentChecklist | null,
  recipient: string,
  prisma: PrismaClient
): Promise<'sent' | 'failed'> {
  const { text, imageUrls } = renderHandoff(reservation, property, checklist);
  try {
    // Text-only first. If we have images, this carries the caption.
    if (imageUrls.length === 0) {
      const result = await sendText({ to: recipient, text });
      await prisma.documentHandoffState.update({
        where: { id: rowId },
        data: {
          status: STATUS_SENT,
          sentAt: new Date(),
          recipientUsed: recipient,
          messageBodyUsed: text,
          imageUrlsUsed: [],
          providerMessageId: result.providerMessageId,
          lastError: null,
        },
      });
      emitStateUpdate(rowId, prisma);
      return 'sent';
    }

    // Caption + first image in one call.
    const [firstUrl, ...restUrls] = imageUrls;
    const first = await sendImage({ to: recipient, text, imageUrl: firstUrl });
    for (const url of restUrls) {
      await sendImage({ to: recipient, imageUrl: url });
    }
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        status: STATUS_SENT,
        sentAt: new Date(),
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: imageUrls,
        providerMessageId: first.providerMessageId,
        lastError: null,
      },
    });
    emitStateUpdate(rowId, prisma);
    return 'sent';
  } catch (err: any) {
    // Media failures fall back to text-only (FR-007) on first image attempt;
    // any later failure still counts as a provider failure with retry.
    if (err instanceof WasenderRequestError && imageUrls.length > 0) {
      try {
        const result = await sendText({ to: recipient, text });
        await prisma.documentHandoffState.update({
          where: { id: rowId },
          data: {
            status: STATUS_SENT,
            sentAt: new Date(),
            recipientUsed: recipient,
            messageBodyUsed: text,
            imageUrlsUsed: [],
            providerMessageId: result.providerMessageId,
            lastError: `media failed: ${err.message}`,
          },
        });
        emitStateUpdate(rowId, prisma);
        return 'sent';
      } catch (textErr: any) {
        return await handleSendFailure(rowId, textErr, recipient, text, imageUrls, prisma);
      }
    }
    return await handleSendFailure(rowId, err, recipient, text, imageUrls, prisma);
  }
}

async function handleSendFailure(
  rowId: string,
  err: unknown,
  recipient: string,
  text: string,
  imageUrls: string[],
  prisma: PrismaClient
): Promise<'failed'> {
  if (err instanceof WasenderDisabledError) {
    await finalize(rowId, STATUS_SKIPPED_NO_PROVIDER, prisma);
    return 'failed';
  }
  const row = await prisma.documentHandoffState.findUnique({ where: { id: rowId } });
  if (!row) return 'failed';
  const newAttempt = row.attemptCount + 1;
  const errMsg = err instanceof Error ? err.message : String(err);
  if (newAttempt >= MAX_ATTEMPTS) {
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        status: STATUS_FAILED,
        attemptCount: newAttempt,
        lastError: errMsg,
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: imageUrls,
      },
    });
  } else {
    const backoff = BACKOFF_MS[newAttempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        attemptCount: newAttempt,
        scheduledFireAt: new Date(Date.now() + backoff),
        lastError: errMsg,
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: imageUrls,
      },
    });
  }
  emitStateUpdate(rowId, prisma);
  return 'failed';
}

async function finalize(rowId: string, status: string, prisma: PrismaClient): Promise<void> {
  await prisma.documentHandoffState.update({
    where: { id: rowId },
    data: { status },
  });
  emitStateUpdate(rowId, prisma);
}

function emitStateUpdate(rowId: string, prisma: PrismaClient): void {
  // Fire-and-forget Socket.IO emit.
  void (async () => {
    try {
      const row = await prisma.documentHandoffState.findUnique({ where: { id: rowId } });
      if (!row) return;
      broadcastToTenant(row.tenantId, 'doc_handoff_updated', {
        id: row.id,
        reservationId: row.reservationId,
        messageType: row.messageType,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
      });
    } catch {
      // ignore
    }
  })();
}

// ── Rendering ───────────────────────────────────────────────────────────────

export function renderReminderText(
  reservation: Reservation,
  property: Property,
  checklist: DocumentChecklist
): string {
  const unit = unitIdentifier(reservation, property);
  const missingPassports = checklist.passportsNeeded - checklist.passportsReceived;
  const marriageMissing = checklist.marriageCertNeeded && !checklist.marriageCertReceived;

  if (missingPassports <= 0 && !marriageMissing) {
    return `${unit}; all documents received`;
  }

  const parts: string[] = [];
  if (missingPassports === 1) parts.push('1 missing passport');
  else if (missingPassports > 1) parts.push(`${missingPassports} missing passports`);
  if (marriageMissing) parts.push('marriage cert missing');
  return `${unit}; ${parts.join(', ')}`;
}

export function renderHandoff(
  reservation: Reservation,
  property: Property,
  checklist: DocumentChecklist | null
): { text: string; imageUrls: string[] } {
  const unit = unitIdentifier(reservation, property);
  const text = `${unit}\n${formatDdMm(reservation.checkIn)} - ${formatDdMm(reservation.checkOut)}`;
  const imageUrls: string[] = [];
  if (checklist?.receivedDocs) {
    const seen = new Set<string>();
    for (const ref of checklist.receivedDocs as ReceivedDocRef[]) {
      for (const url of ref.imageUrls) {
        if (!seen.has(url)) {
          seen.add(url);
          imageUrls.push(url);
        }
      }
    }
  }
  return { text, imageUrls };
}

// ── Hot exports for tests ──────────────────────────────────────────────────

export const __test = {
  atLocalTime,
  isCheckinToday,
  isCheckinInPast,
  isChecklistComplete,
  unitIdentifier,
  formatDdMm,
};
