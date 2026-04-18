/**
 * Hostaway Alteration Service
 * Calls platform.hostaway.com (internal dashboard API) for alteration fetch/accept/reject.
 *
 * Endpoints (confirmed via network intercept 2026-04-04):
 *   GET  /reservations/{id}/alterations                    — fetch pending alterations
 *   PUT  /reservations/{id}/alterations/{altId}  {"status":"ACCEPTED"}  — accept
 *   PUT  /reservations/{id}/alterations/{altId}  {"status":"DECLINED"}  — reject
 */

import axios, { AxiosError } from 'axios';

const PLATFORM_BASE_URL = 'https://platform.hostaway.com';

interface DashboardApiResult {
  success: boolean;
  data?: unknown;
  error?: string;
  httpStatus?: number;
}

export interface AlterationDetail {
  hostawayAlterationId: string;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  originalGuestCount: number | null;
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  proposedGuestCount: number | null;
}

function createClient(dashboardJwt: string) {
  return axios.create({
    baseURL: PLATFORM_BASE_URL,
    timeout: 20000,
    headers: {
      jwt: dashboardJwt,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Fetch the first pending alteration for a reservation.
 * Returns null if no pending alteration exists.
 * Returns an error string if the API call fails.
 */
export async function fetchAlteration(
  dashboardJwt: string,
  hostawayReservationId: string,
): Promise<{ alteration: AlterationDetail | null } | { error: string }> {
  console.log(`[HostawayAlterations] Fetching alterations for reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    const res = await client.get(`/reservations/${hostawayReservationId}/alterations`);
    const result = res.data?.result;

    if (!Array.isArray(result) || result.length === 0) {
      return { alteration: null };
    }

    // Take the first pending alteration, or the most recent one
    const pending = result.find((a: any) => a.status === 'pending' || a.status === 'PENDING') ?? result[0];

    // Real Hostaway field names (confirmed 2026-04-04):
    //   Original: reservationArrivalDate, reservationDepartureDate, reservationAdults + reservationChildren + reservationInfants
    //   Proposed: startDate, endDate, numberOfAdults + numberOfChildren + numberOfInfants
    const originalGuests = (pending.reservationAdults ?? 0) + (pending.reservationChildren ?? 0) + (pending.reservationInfants ?? 0);
    const proposedGuests = (pending.numberOfAdults ?? 0) + (pending.numberOfChildren ?? 0) + (pending.numberOfInfants ?? 0);

    return {
      alteration: {
        hostawayAlterationId: String(pending.id ?? ''),
        originalCheckIn: pending.reservationArrivalDate ?? null,
        originalCheckOut: pending.reservationDepartureDate ?? null,
        originalGuestCount: originalGuests || null,
        proposedCheckIn: pending.startDate ?? null,
        proposedCheckOut: pending.endDate ?? null,
        proposedGuestCount: proposedGuests || null,
      },
    };
  } catch (err) {
    const axiosErr = err as AxiosError<{ message?: string }>;
    const message = axiosErr?.response?.data?.message || axiosErr?.message || 'Unknown error';
    console.error(`[HostawayAlterations] fetch failed for ${hostawayReservationId}: ${axiosErr?.response?.status} — ${message}`);
    return { error: message };
  }
}

/**
 * Look up the current status of a specific alteration by id.
 * Used to reconcile local DB state when an alteration was actioned externally
 * (e.g. the host accepted it inside Hostaway's dashboard) and we need to flip
 * our PENDING row to ACCEPTED / REJECTED / EXPIRED.
 *
 * Hostaway status values observed: 'pending', 'ACCEPTED', 'DECLINED'. The list
 * endpoint eventually drops accepted rows entirely on some channels, so a
 * not-found result is equally a signal that the alteration is no longer pending.
 */
export async function getAlterationStatusById(
  dashboardJwt: string,
  hostawayReservationId: string,
  hostawayAlterationId: string,
): Promise<{ status: string } | { notFound: true } | { error: string }> {
  try {
    const client = createClient(dashboardJwt);
    const res = await client.get(`/reservations/${hostawayReservationId}/alterations`);
    const result = res.data?.result;
    if (!Array.isArray(result)) return { notFound: true };
    const match = result.find((a: any) => String(a.id) === String(hostawayAlterationId));
    if (!match) return { notFound: true };
    return { status: String(match.status ?? '') };
  } catch (err) {
    const axiosErr = err as AxiosError<{ message?: string }>;
    const message = axiosErr?.response?.data?.message || axiosErr?.message || 'Unknown error';
    return { error: message };
  }
}

/**
 * Accept a pending alteration.
 * Real endpoint: PUT /reservations/{id}/alterations/{altId} with body {"status":"ACCEPTED"}
 */
export async function acceptAlteration(
  dashboardJwt: string,
  hostawayReservationId: string,
  hostawayAlterationId: string,
): Promise<DashboardApiResult> {
  console.log(`[HostawayAlterations] Accepting alteration ${hostawayAlterationId} for reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    const res = await client.put(
      `/reservations/${hostawayReservationId}/alterations/${hostawayAlterationId}`,
      { status: 'ACCEPTED' },
    );
    console.log(`[HostawayAlterations] Accept success: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    return handleError(err, 'accept', hostawayAlterationId);
  }
}

/**
 * Reject a pending alteration.
 * Real endpoint: PUT /reservations/{id}/alterations/{altId} with body {"status":"DECLINED"}
 */
export async function rejectAlteration(
  dashboardJwt: string,
  hostawayReservationId: string,
  hostawayAlterationId: string,
): Promise<DashboardApiResult> {
  console.log(`[HostawayAlterations] Rejecting alteration ${hostawayAlterationId} for reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    const res = await client.put(
      `/reservations/${hostawayReservationId}/alterations/${hostawayAlterationId}`,
      { status: 'DECLINED' },
    );
    console.log(`[HostawayAlterations] Reject success: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    return handleError(err, 'reject', hostawayAlterationId);
  }
}

function handleError(err: unknown, action: string, id: string): DashboardApiResult {
  const axiosErr = err as AxiosError<{ status?: string; message?: string }>;
  const status = axiosErr?.response?.status;
  const message = axiosErr?.response?.data?.message || axiosErr?.message || 'Unknown error';
  console.error(`[HostawayAlterations] ${action} failed for ${id}: ${status} — ${message}`);
  return { success: false, error: message, httpStatus: status };
}
