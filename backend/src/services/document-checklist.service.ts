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
  prisma: PrismaClient
): Promise<DocumentChecklist> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { screeningAnswers: true },
  });
  if (!reservation) throw new Error('Reservation not found');

  const sa = (reservation.screeningAnswers as any) || {};
  const checklist = sa.documentChecklist as DocumentChecklist | undefined;
  if (!checklist) throw new Error('No document checklist exists');

  const updated = { ...checklist, updatedAt: new Date().toISOString() };

  if (updates.documentType === 'passport') {
    if (updated.passportsReceived < updated.passportsNeeded) {
      updated.passportsReceived += 1;
      console.log(`[DocChecklist] Passport received for reservation ${reservationId}: ${updated.passportsReceived}/${updated.passportsNeeded} (${updates.notes})`);
    } else {
      console.log(`[DocChecklist] All passports already received for reservation ${reservationId} — ignoring extra`);
    }
  } else if (updates.documentType === 'marriage_certificate') {
    updated.marriageCertReceived = true;
    console.log(`[DocChecklist] Marriage certificate received for reservation ${reservationId} (${updates.notes})`);
  }

  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      screeningAnswers: { ...sa, documentChecklist: updated },
    },
  });

  return updated;
}

export async function manualUpdateChecklist(
  reservationId: string,
  data: { passportsReceived?: number; marriageCertReceived?: boolean },
  prisma: PrismaClient
): Promise<DocumentChecklist> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { screeningAnswers: true },
  });
  if (!reservation) throw new Error('Reservation not found');

  const sa = (reservation.screeningAnswers as any) || {};
  const checklist = sa.documentChecklist as DocumentChecklist | undefined;
  if (!checklist) throw new Error('No document checklist exists');

  const updated = { ...checklist, updatedAt: new Date().toISOString() };

  if (data.passportsReceived !== undefined) {
    updated.passportsReceived = Math.min(Math.max(0, data.passportsReceived), updated.passportsNeeded);
  }
  if (data.marriageCertReceived !== undefined) {
    updated.marriageCertReceived = data.marriageCertReceived;
  }

  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      screeningAnswers: { ...sa, documentChecklist: updated },
    },
  });

  console.log(`[DocChecklist] Manual update for reservation ${reservationId}: passports=${updated.passportsReceived}/${updated.passportsNeeded}, marriageCert=${updated.marriageCertReceived}`);
  return updated;
}

/** Check if a checklist has pending items */
export function hasPendingItems(checklist: DocumentChecklist | null): boolean {
  if (!checklist) return false;
  return checklist.passportsReceived < checklist.passportsNeeded
    || (checklist.marriageCertNeeded && !checklist.marriageCertReceived);
}
