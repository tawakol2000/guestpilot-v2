/**
 * Hostaway Dashboard API Service
 * Calls platform.hostaway.com (internal dashboard API) for inquiry accept/reject/cancel.
 * Separate from hostaway.service.ts which uses the public API (api.hostaway.com).
 */

import axios, { AxiosError } from 'axios';

const PLATFORM_BASE_URL = 'https://platform.hostaway.com';

interface DashboardApiResult {
  success: boolean;
  data?: unknown;
  error?: string;
  httpStatus?: number;
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

export async function approveReservation(dashboardJwt: string, hostawayReservationId: string | number): Promise<DashboardApiResult> {
  console.log(`[HostawayDashboard] Approving reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    const res = await client.put(`/reservations/${hostawayReservationId}/status/approved`);
    console.log(`[HostawayDashboard] Approve success: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    return handleError(err, 'approve', hostawayReservationId);
  }
}

export async function rejectReservation(dashboardJwt: string, hostawayReservationId: string | number): Promise<DashboardApiResult> {
  console.log(`[HostawayDashboard] Rejecting reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    // Confirmed endpoint: PUT /reservations/{id}/status/declined
    // Only works for Airbnb, VRBO, Booking.com channels (not direct bookings)
    const res = await client.put(`/reservations/${hostawayReservationId}/status/declined`);
    console.log(`[HostawayDashboard] Reject success: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    return handleError(err, 'reject', hostawayReservationId);
  }
}

export async function cancelReservation(dashboardJwt: string, hostawayReservationId: string | number): Promise<DashboardApiResult> {
  console.log(`[HostawayDashboard] Cancelling reservation ${hostawayReservationId}`);
  try {
    const client = createClient(dashboardJwt);
    const res = await client.delete(`/reservations/${hostawayReservationId}/status`);
    console.log(`[HostawayDashboard] Cancel success: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    return handleError(err, 'cancel', hostawayReservationId);
  }
}

/**
 * Validate a dashboard JWT by decoding and checking expiry.
 * Returns decoded payload if valid, null if expired/invalid.
 */
export function validateDashboardJwt(jwt: string): { valid: boolean; payload?: any; error?: string } {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return { valid: false, error: 'Invalid JWT format' };
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token expired' };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, error: 'Failed to decode token' };
  }
}

function handleError(err: unknown, action: string, reservationId: string | number): DashboardApiResult {
  const axiosErr = err as AxiosError<{ status?: string; message?: string }>;
  const status = axiosErr?.response?.status;
  const message = axiosErr?.response?.data?.message || axiosErr?.message || 'Unknown error';
  console.error(`[HostawayDashboard] ${action} failed for ${reservationId}: ${status} — ${message}`);
  return {
    success: false,
    error: message,
    httpStatus: status,
  };
}
