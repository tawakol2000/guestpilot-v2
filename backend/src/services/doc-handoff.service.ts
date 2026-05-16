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
  WasenderServerError,
  WasenderTimeoutError,
} from './wasender.service';
import { broadcastToTenant } from './socket.service';
import { assertPublicHttpsUrl } from '../lib/url-safety';

// ── Timezone helpers ────────────────────────────────────────────────────────

/**
 * Build a Date representing a specific HH:MM on a specific calendar day in Africa/Cairo timezone,
 * returned as a UTC Date. The calendar day is derived from `referenceDate` in the target timezone.
 *
 * We use `Intl.DateTimeFormat` parts to read the TZ-local year/month/day of `referenceDate`,
 * then reconstruct the target UTC instant by subtracting the TZ's UTC offset at that date.
 */
function atLocalTime(referenceDate: Date, hhmm: string): Date {
  // Bugfix (2026-04-23): use `hourCycle: 'h23'` so midnight always
  // formats as "00", not "24". The previous `en-US` + `hour12: false`
  // configuration could yield "24" for midnight in some Node ICU
  // builds, which made `diffMinutes` skew by 1440 minutes (1 day).
  // A manager setting docHandoffReminderTime: "00:00" or
  // docHandoffTime: "00:00" would have their handoff queued for the
  // wrong calendar day. h23 (00-23) is unambiguous.
  const [h, m] = hhmm.split(':').map(Number);
  const tzFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(referenceDate);
  const part = (t: string) => Number(tzFormat.find((p) => p.type === t)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');

  // Build candidate UTC by naive construction then correct for tz offset.
  const naiveUtc = Date.UTC(year, month - 1, day, h, m, 0, 0);
  // Probe: what wall time does naiveUtc show when formatted in the target tz?
  const probed = new Intl.DateTimeFormat('en-GB', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
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
    // Only schedule for bookings that are confirmed (or already checked in,
    // for late-arrival handoffs). INQUIRY/PENDING are tentative and should
    // not consume a recipient quota or be visible in the operator panel
    // until the reservation is actually confirmed. If status later flips to
    // CONFIRMED, scheduleOnReservationUpsert is called again via webhook /
    // reservation-sync and rows are created at that point.
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'CHECKED_IN') {
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
  // 2026-05-15 (review pass): close the TOCTOU between the findUnique
  // "skip-if-terminal" check and the subsequent upsert. Two concurrent
  // calls (webhook fires twice, or messageSync racing reservationSync)
  // could BOTH read a STATUS_SENT row and bypass the guard, then BOTH
  // execute upsert.update — flipping SENT back to SCHEDULED and causing
  // a double send.
  //
  // Fix: split into create-or-update with the terminal-status filter on
  // the update path enforced atomically by Prisma. Strategy:
  //   1. Try `updateMany` scoped to ACTIVE_STATUSES — succeeds (count=1)
  //      only when the existing row is still active.
  //   2. If no row was updated, try to create — if a row already exists
  //      we get a P2002 unique-constraint error, which means the row
  //      reached terminal state between our two queries; treat as no-op.
  try {
    const updated = await prisma.documentHandoffState.updateMany({
      where: {
        reservationId,
        messageType,
        status: { in: ACTIVE_STATUSES as unknown as string[] },
      },
      data: { scheduledFireAt, status },
    });
    if (updated.count > 0) return;
    await prisma.documentHandoffState.create({
      data: { tenantId, reservationId, messageType, status, scheduledFireAt },
    });
  } catch (err: any) {
    // P2002 = unique-constraint violation; means another concurrent
    // upsert won the race (or the row is already terminal). Either way
    // we silently no-op.
    if (err?.code !== 'P2002') throw err;
  }
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
  // Non-confirmed (INQUIRY/PENDING) rows shouldn't fire. Push the fire time
  // forward 1h so the poller doesn't re-process the same row every tick,
  // but leave it active so it can fire if/when the reservation is later
  // confirmed (the scheduling pass will re-set the fire time on confirm).
  if (reservation.status !== 'CONFIRMED' && reservation.status !== 'CHECKED_IN') {
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: { scheduledFireAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return 'deferred';
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
  const rendered = renderHandoff(reservation, property, checklist);
  const { text } = rendered;
  // SECURITY (2026-05-15): screen image URLs for SSRF before passing to
  // WAsender. Attachments originate as guest-uploaded URLs and WAsender's
  // server-side fetch would otherwise proxy requests at internal IPs /
  // cloud metadata endpoints on our behalf. Rejected URLs are dropped
  // silently; a sustained drop pattern would land in the partial-delivery
  // path below as if those images had failed to send.
  const imageUrls = await filterSafeImageUrls(rendered.imageUrls);
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
    //
    // Bugfix (2026-04-23): track which images were ALREADY DELIVERED
    // before any failure. The previous version held DB writes until
    // ALL images succeeded, so a mid-loop failure on (say) image 3
    // of 5 fell into the outer catch → text-only fallback re-sent
    // the caption → if that ALSO failed → handleSendFailure
    // rescheduled the row → next tick re-sent images 1, 2, 3 to the
    // security recipient. Duplicate passport-photo delivery is a
    // privacy issue.
    //
    // New behaviour: if image 1 succeeds but a later image fails,
    // mark the row SENT with the partial delivery recorded in
    // lastError + imageUrlsUsed reflecting only what landed. The
    // operator gets a warning surface; we do NOT re-send already-
    // delivered images.
    const [firstUrl, ...restUrls] = imageUrls;
    const first = await sendImage({ to: recipient, text, imageUrl: firstUrl });
    const deliveredUrls: string[] = [firstUrl];
    let partialErr: Error | null = null;
    // 2026-05-15: throttle consecutive image sends. WAsender's per-account
    // rate limit kicks in around 1 send / 1.5s on standard plans; sending
    // 2-4 passport images back-to-back in a tight loop was reliably
    // tripping HTTP 429 on the second image. Pause briefly between sends
    // so the per-second bucket can refill.
    //
    // 2026-05-16: bumped 2s → 5500ms. Production handoff for Apartment 103
    // (row cmocmj7nv000f2ya2172gejf7) delivered 1/3 images because
    // WAsender's "account protection" mode for this tenant returned:
    //   "You can only send 1 message every 5 seconds."
    // The 2s delay was correct for the standard rate-limit but not for
    // account-protection. 5500ms covers the 5s floor plus a small safety
    // margin (jitter from server-side clocks + axios queue delay).
    const INTER_IMAGE_DELAY_MS = 5_500;
    for (const url of restUrls) {
      await new Promise<void>((resolve) => setTimeout(resolve, INTER_IMAGE_DELAY_MS));
      try {
        await sendImage({ to: recipient, imageUrl: url });
        deliveredUrls.push(url);
      } catch (imgErr: any) {
        partialErr = imgErr instanceof Error ? imgErr : new Error(String(imgErr));
        console.warn(
          `[DocHandoff] partial-image failure on row=${rowId}: delivered=${deliveredUrls.length}/${imageUrls.length} — marking SENT with shortfall recorded.`,
        );
        break;
      }
    }
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        status: STATUS_SENT,
        sentAt: new Date(),
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: deliveredUrls,
        providerMessageId: first.providerMessageId,
        lastError: partialErr
          ? `partial: ${deliveredUrls.length}/${imageUrls.length} images delivered. ${partialErr.message}`
          : null,
      },
    });
    emitStateUpdate(rowId, prisma);
    return 'sent';
  } catch (err: any) {
    // Media failure on the FIRST image attempt → fall back to
    // text-only (FR-007). The first image hasn't been delivered
    // yet so retry is safe.
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

  // 2026-05-15 M12: transient errors (WAsender 5xx / timeouts / 429
  // rate-limit) shouldn't burn the 3-attempt cap. Previously a 20-min
  // 5xx storm or a busy minute against WAsender's per-second cap would
  // permanently FAIL the row in 3 retries with no chance for the
  // operator to ever deliver the docs once WAsender recovered. Now:
  // on a transient error, bump scheduledFireAt with a longer backoff
  // (30 min) but DO NOT increment attemptCount. Cap on wall-clock age:
  // if the row's createdAt is more than 24h old, give up.
  const is429 = err instanceof WasenderRequestError && err.status === 429;
  const isTransient =
    err instanceof WasenderServerError || err instanceof WasenderTimeoutError || is429;
  if (isTransient) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const ageMs = Date.now() - row.createdAt.getTime();
    const TRANSIENT_AGE_CAP_MS = 24 * 60 * 60 * 1000;
    if (ageMs > TRANSIENT_AGE_CAP_MS) {
      console.warn(
        `[DocHandoff] row=${rowId} exceeded transient age cap (${ageMs}ms) — marking FAILED.`,
      );
      await prisma.documentHandoffState.update({
        where: { id: rowId },
        data: {
          status: STATUS_FAILED,
          attemptCount: row.attemptCount,
          lastError: `transient-aged-out: ${errMsg}`,
          recipientUsed: recipient,
          messageBodyUsed: text,
          imageUrlsUsed: imageUrls,
        },
      });
      emitStateUpdate(rowId, prisma);
      return 'failed';
    }
    const TRANSIENT_BACKOFF_MS = 30 * 60 * 1000;
    await prisma.documentHandoffState.update({
      where: { id: rowId },
      data: {
        scheduledFireAt: new Date(Date.now() + TRANSIENT_BACKOFF_MS),
        lastError: `transient: ${errMsg}`,
        recipientUsed: recipient,
        messageBodyUsed: text,
        imageUrlsUsed: imageUrls,
      },
    });
    emitStateUpdate(rowId, prisma);
    return 'failed';
  }

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
    } catch (err) {
      // 2026-05-15 (auto-review F5): log silent broadcast failures so a
      // DB connection blip is debuggable. Still non-fatal — the row
      // state is already persisted by the time we reach this fire-and-
      // forget broadcast.
      console.warn(
        `[DocHandoff] state-update broadcast failed (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
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

/**
 * SSRF guard for image URLs handed to WAsender.
 *
 * WAsender's server-side image fetch makes it a usable SSRF proxy if a
 * guest-uploaded attachment URL ever points at an internal IP / cloud
 * metadata endpoint. Resolve + screen each URL before passing to the
 * provider. Returns the subset of URLs that resolve to public HTTPS IPs;
 * rejected URLs are logged and dropped silently from the send.
 */
export async function filterSafeImageUrls(urls: string[]): Promise<string[]> {
  const safe: string[] = [];
  for (const url of urls) {
    try {
      await assertPublicHttpsUrl(url);
      safe.push(url);
    } catch (err) {
      console.warn(
        `[DocHandoff] dropping image URL (failed SSRF check): ${url.slice(0, 120)} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return safe;
}

// ── Operator override: force-fire ─────────────────────────────────────────

/**
 * Operator-driven "fire now" for a specific reservation. Bypasses the
 * scheduled fire time but runs the full evaluator (gates: feature enabled,
 * recipient configured, checklist presence, WAsender enabled) and renders
 * the real handoff/reminder text + images.
 *
 * If a row exists for (reservationId, messageType), it's reset to
 * SCHEDULED at now() and re-evaluated. If none exists, one is created.
 * Returns the post-evaluation row so the UI can show what happened.
 */
export async function forceFireDocHandoff(
  reservationId: string,
  messageType: 'REMINDER' | 'HANDOFF',
  prisma: PrismaClient,
): Promise<{
  rowId: string;
  result: 'sent' | 'deferred' | 'failed' | 'skipped' | 'noop';
  row: Awaited<ReturnType<typeof prisma.documentHandoffState.findUnique>>;
}> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, tenantId: true },
  });
  if (!reservation) {
    throw new Error('Reservation not found');
  }

  const existing = await prisma.documentHandoffState.findUnique({
    where: { reservationId_messageType: { reservationId, messageType } },
  });
  let rowId: string;
  if (existing) {
    await prisma.documentHandoffState.update({
      where: { id: existing.id },
      data: {
        status: STATUS_SCHEDULED,
        scheduledFireAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
    });
    rowId = existing.id;
  } else {
    const created = await prisma.documentHandoffState.create({
      data: {
        tenantId: reservation.tenantId,
        reservationId,
        messageType,
        status: STATUS_SCHEDULED,
        scheduledFireAt: new Date(),
      },
    });
    rowId = created.id;
  }

  const result = await evaluateSingleRow(rowId, prisma);
  const row = await prisma.documentHandoffState.findUnique({ where: { id: rowId } });
  return { rowId, result, row };
}

/**
 * Operator-driven listing of upcoming reservations (today through ~14 days
 * out, plus today's check-ins regardless of past check-in time). Used by
 * the settings page to offer "fire now" buttons per reservation.
 */
export async function listTodayCheckIns(
  tenantId: string,
  prisma: PrismaClient,
): Promise<
  Array<{
    reservationId: string;
    hostawayReservationId: string | null;
    guestName: string | null;
    propertyName: string | null;
    checkIn: string;
    checkOut: string;
    status: string;
    isToday: boolean;
    checklist: DocumentChecklist | null;
    checklistComplete: boolean;
    reminderRow: { status: string; sentAt: string | null; lastError: string | null } | null;
    handoffRow: { status: string; sentAt: string | null; lastError: string | null } | null;
  }>
> {
  const tzFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DOC_HANDOFF_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = tzFmt.format(new Date());

  // Pull from ~12h ago through 14 days out so today + upcoming all surface.
  const now = Date.now();
  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      status: 'CONFIRMED',
      checkIn: {
        gte: new Date(now - 12 * 60 * 60 * 1000),
        lte: new Date(now + 14 * 24 * 60 * 60 * 1000),
      },
    },
    include: {
      property: { select: { name: true } },
      guest: { select: { name: true } },
    },
    orderBy: { checkIn: 'asc' },
    take: 50,
  });

  if (reservations.length === 0) return [];

  // Lazy backfill: any upcoming reservation without scheduled rows (e.g.
  // synced before the doc-handoff feature was deployed) gets them now.
  // scheduleOnReservationUpsert is idempotent — terminal rows are not
  // resurrected, active rows have their fire time refreshed only when
  // appropriate. Fire-and-forget so a single bad reservation can't break
  // the listing.
  await Promise.all(
    reservations.map((r) =>
      scheduleOnReservationUpsert(r.id, prisma).catch((err) => {
        console.warn(
          `[DocHandoff] backfill schedule failed for ${r.id} (non-fatal):`,
          err?.message ?? err,
        );
      }),
    ),
  );

  const handoffRows = await prisma.documentHandoffState.findMany({
    where: { reservationId: { in: reservations.map((r) => r.id) } },
    select: {
      reservationId: true,
      messageType: true,
      status: true,
      sentAt: true,
      lastError: true,
    },
  });
  const byRes = new Map<string, { reminder?: typeof handoffRows[number]; handoff?: typeof handoffRows[number] }>();
  for (const row of handoffRows) {
    const bucket = byRes.get(row.reservationId) ?? {};
    if (row.messageType === MESSAGE_TYPE_REMINDER) bucket.reminder = row;
    else if (row.messageType === MESSAGE_TYPE_HANDOFF) bucket.handoff = row;
    byRes.set(row.reservationId, bucket);
  }

  return reservations.map((r) => {
    const checklist = getChecklistFromReservation(r);
    const rows = byRes.get(r.id);
    return {
      reservationId: r.id,
      hostawayReservationId: r.hostawayReservationId ?? null,
      guestName: r.guest?.name?.trim() || null,
      propertyName: r.property?.name ?? null,
      checkIn: r.checkIn.toISOString(),
      checkOut: r.checkOut.toISOString(),
      status: r.status,
      isToday: tzFmt.format(r.checkIn) === todayStr,
      checklist,
      checklistComplete: isChecklistComplete(checklist),
      reminderRow: rows?.reminder
        ? {
            status: rows.reminder.status,
            sentAt: rows.reminder.sentAt?.toISOString() ?? null,
            lastError: rows.reminder.lastError ?? null,
          }
        : null,
      handoffRow: rows?.handoff
        ? {
            status: rows.handoff.status,
            sentAt: rows.handoff.sentAt?.toISOString() ?? null,
            lastError: rows.handoff.lastError ?? null,
          }
        : null,
    };
  });
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
