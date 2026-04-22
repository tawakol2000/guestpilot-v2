/**
 * Document Checklist Service
 * CRUD operations for the document checklist stored in Reservation.screeningAnswers.
 * Created by the screening agent, updated by the coordinator and manager.
 */

import { PrismaClient } from '@prisma/client';

export interface DocumentChecklist {
  passportsNeeded: number;
  passportsReceived: number;
  marriageCertNeeded: boolean;
  marriageCertReceived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  // ─── Feature 044: captured image references for check-in handoff ───
  receivedDocs?: ReceivedDocRef[];
}

export interface ReceivedDocRef {
  slot: 'passport' | 'marriage_certificate';
  slotIndex?: number;
  hostawayMessageId: string;
  imageUrls: string[];
  capturedAt: string;
  source: 'ai_tool' | 'manual';
}

export interface CaptureContext {
  sourceMessageId?: string;
  imageUrls?: string[];
}

export async function getChecklist(
  reservationId: string,
  prisma: PrismaClient
): Promise<DocumentChecklist | null> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { screeningAnswers: true },
  });
  if (!reservation) return null;
  const sa = reservation.screeningAnswers as any;
  return sa?.documentChecklist ?? null;
}

export async function createChecklist(
  reservationId: string,
  data: { passportsNeeded: number; marriageCertNeeded: boolean; reason: string; createdBy?: string },
  prisma: PrismaClient
): Promise<DocumentChecklist> {
  if (data.passportsNeeded < 1) {
    throw new Error('passportsNeeded must be >= 1');
  }

  const now = new Date().toISOString();
  const checklist: DocumentChecklist = {
    passportsNeeded: data.passportsNeeded,
    passportsReceived: 0,
    marriageCertNeeded: data.marriageCertNeeded,
    marriageCertReceived: false,
    createdAt: now,
    updatedAt: now,
    createdBy: data.createdBy || 'screening-agent',
  };

  // Read existing screeningAnswers, merge with new checklist
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { screeningAnswers: true },
  });
  const existing = (reservation?.screeningAnswers as any) || {};

  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      screeningAnswers: { ...existing, documentChecklist: checklist },
    },
  });

  console.log(`[DocChecklist] Created for reservation ${reservationId}: ${data.passportsNeeded} passports, marriageCert=${data.marriageCertNeeded} (${data.reason})`);
  return checklist;
}

export async function updateChecklist(
  reservationId: string,
  updates: { documentType: 'passport' | 'marriage_certificate'; notes: string },
  prisma: PrismaClient,
  captureContext?: CaptureContext
): Promise<DocumentChecklist> {
  // Bugfix (2026-04-23): the previous implementation was a classic
  // read-modify-write race. Two concurrent passports arriving within
  // milliseconds (guest sends two photos back-to-back, or webhook +
  // manual mark race) each read the same passportsReceived value,
  // both incremented their local copy by +1, both wrote — counter
  // ended at N+1 instead of N+2 and one receivedDocs entry was lost.
  //
  // Fix: wrap read + mutate + write in $transaction so Postgres's
  // row-level lock serialises the writers. The second tx re-reads the
  // post-first-update state inside the lock and increments from there.
  let updated!: DocumentChecklist;
  let didIncrement = false;
  let slotIndex: number | undefined;

  await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: { screeningAnswers: true },
    });
    if (!reservation) throw new Error('Reservation not found');

    const sa = (reservation.screeningAnswers as any) || {};
    const checklist = sa.documentChecklist as DocumentChecklist | undefined;
    if (!checklist) throw new Error('No document checklist exists');

    updated = {
      ...checklist,
      updatedAt: new Date().toISOString(),
      receivedDocs: [...(checklist.receivedDocs ?? [])],
    };

    if (updates.documentType === 'passport') {
      if (updated.passportsReceived < updated.passportsNeeded) {
        updated.passportsReceived += 1;
        didIncrement = true;
        slotIndex = updated.passportsReceived;
        console.log(`[DocChecklist] Passport received for reservation ${reservationId}: ${updated.passportsReceived}/${updated.passportsNeeded} (${updates.notes})`);
      } else {
        console.log(`[DocChecklist] All passports already received for reservation ${reservationId} — ignoring extra`);
      }
    } else if (updates.documentType === 'marriage_certificate') {
      if (!updated.marriageCertReceived) {
        updated.marriageCertReceived = true;
        didIncrement = true;
        console.log(`[DocChecklist] Marriage certificate received for reservation ${reservationId} (${updates.notes})`);
      }
    }

    if (didIncrement && captureContext?.sourceMessageId && captureContext.imageUrls && captureContext.imageUrls.length > 0) {
      updated.receivedDocs!.push({
        slot: updates.documentType,
        slotIndex,
        hostawayMessageId: captureContext.sourceMessageId,
        imageUrls: [...captureContext.imageUrls],
        capturedAt: new Date().toISOString(),
        source: 'ai_tool',
      });
    }

    await tx.reservation.update({
      where: { id: reservationId },
      data: {
        screeningAnswers: { ...sa, documentChecklist: updated },
      },
    });
  });

  // Fire-and-forget: notify doc-handoff scheduler that a deferred handoff may now be eligible.
  try {
    const { onChecklistUpdated } = await import('./doc-handoff.service');
    void onChecklistUpdated(reservationId, prisma).catch(() => {});
  } catch {
    // Module may not be present during tests or initial load; ignore silently.
  }

  return updated;
}

export async function manualUpdateChecklist(
  reservationId: string,
  data: { passportsReceived?: number; marriageCertReceived?: boolean },
  prisma: PrismaClient,
  captureContext?: CaptureContext
): Promise<DocumentChecklist> {
  // Bugfix (2026-04-23): same race protection as updateChecklist —
  // wrap read + mutate + write in $transaction so concurrent updates
  // (manual + AI tool, two simultaneous manager actions) serialise
  // via Postgres row lock instead of race-dropping each other's
  // increments / receivedDocs entries.
  let updated!: DocumentChecklist;
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: { screeningAnswers: true },
    });
    if (!reservation) throw new Error('Reservation not found');

    const sa = (reservation.screeningAnswers as any) || {};
    const checklist = sa.documentChecklist as DocumentChecklist | undefined;
    if (!checklist) throw new Error('No document checklist exists');

    updated = {
      ...checklist,
      updatedAt: new Date().toISOString(),
      receivedDocs: [...(checklist.receivedDocs ?? [])],
    };

    const prevPassports = updated.passportsReceived;
    const prevMarriage = updated.marriageCertReceived;

    if (data.passportsReceived !== undefined) {
      updated.passportsReceived = Math.min(Math.max(0, data.passportsReceived), updated.passportsNeeded);
    }
    if (data.marriageCertReceived !== undefined) {
      updated.marriageCertReceived = data.marriageCertReceived;
    }

    // Capture new image refs for any new increments.
    if (captureContext?.sourceMessageId && captureContext.imageUrls && captureContext.imageUrls.length > 0) {
      const passportDelta = updated.passportsReceived - prevPassports;
      const capturedAt = new Date().toISOString();
      if (passportDelta > 0) {
        for (let i = 0; i < passportDelta; i++) {
          updated.receivedDocs!.push({
            slot: 'passport',
            slotIndex: prevPassports + i + 1,
            hostawayMessageId: captureContext.sourceMessageId,
            imageUrls: [...captureContext.imageUrls],
            capturedAt,
            source: 'manual',
          });
        }
      }
      if (!prevMarriage && updated.marriageCertReceived) {
        updated.receivedDocs!.push({
          slot: 'marriage_certificate',
          hostawayMessageId: captureContext.sourceMessageId,
          imageUrls: [...captureContext.imageUrls],
          capturedAt,
          source: 'manual',
        });
      }
    }

    // Un-mark path: drop the most recent ref for any slot whose count decremented.
    if (data.passportsReceived !== undefined && updated.passportsReceived < prevPassports) {
      const dropCount = prevPassports - updated.passportsReceived;
      for (let i = 0; i < dropCount; i++) {
        const lastIdx = [...(updated.receivedDocs ?? [])].reverse().findIndex((r) => r.slot === 'passport');
        if (lastIdx >= 0) {
          const arr = updated.receivedDocs!;
          arr.splice(arr.length - 1 - lastIdx, 1);
        }
      }
    }
    if (data.marriageCertReceived === false && prevMarriage) {
      const arr = updated.receivedDocs!;
      const lastIdx = [...arr].reverse().findIndex((r) => r.slot === 'marriage_certificate');
      if (lastIdx >= 0) arr.splice(arr.length - 1 - lastIdx, 1);
    }

    await tx.reservation.update({
      where: { id: reservationId },
      data: {
        screeningAnswers: { ...sa, documentChecklist: updated },
      },
    });
  });

  console.log(`[DocChecklist] Manual update for reservation ${reservationId}: passports=${updated.passportsReceived}/${updated.passportsNeeded}, marriageCert=${updated.marriageCertReceived}`);

  // Fire-and-forget scheduler notification.
  try {
    const { onChecklistUpdated } = await import('./doc-handoff.service');
    void onChecklistUpdated(reservationId, prisma).catch(() => {});
  } catch {
    // ignore
  }

  return updated;
}

/** Check if a checklist has pending items */
export function hasPendingItems(checklist: DocumentChecklist | null): boolean {
  if (!checklist) return false;
  return checklist.passportsReceived < checklist.passportsNeeded
    || (checklist.marriageCertNeeded && !checklist.marriageCertReceived);
}
