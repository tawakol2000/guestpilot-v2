import * as apn from '@parse/node-apn';
import { PrismaClient } from '@prisma/client';

// Railway env vars required:
//   APNS_AUTH_KEY_BASE64 — .p8 file, base64-encoded (generate: `base64 -i AuthKey_XXX.p8 | pbcopy`)
//   APNS_KEY_ID           — 10-char key ID from Apple Developer
//   APNS_TEAM_ID          — 10-char team ID from Apple Developer
//   APNS_BUNDLE_ID        — defaults to com.tawakol.guestpilot
//   APNS_PRODUCTION       — "true" for App Store builds, else sandbox (TestFlight/dev)
const APNS_KEY = process.env.APNS_AUTH_KEY_BASE64 || '';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.tawakol.guestpilot';
const APNS_PRODUCTION = process.env.APNS_PRODUCTION === 'true';
const APNS_ENABLED = !!(APNS_KEY && APNS_KEY_ID && APNS_TEAM_ID);

let provider: apn.Provider | null = null;

function getProvider(): apn.Provider | null {
  if (!APNS_ENABLED) return null;
  if (provider) return provider;
  try {
    provider = new apn.Provider({
      token: {
        key: Buffer.from(APNS_KEY, 'base64'),
        keyId: APNS_KEY_ID,
        teamId: APNS_TEAM_ID,
      },
      production: APNS_PRODUCTION,
    });
    console.log(`[APNs] Provider initialized — env=${APNS_PRODUCTION ? 'production' : 'sandbox'}, bundle=${APNS_BUNDLE_ID}`);
  } catch (err: any) {
    console.warn('[APNs] Provider init failed — push disabled:', err.message);
    provider = null;
  }
  return provider;
}

if (APNS_ENABLED) {
  console.log('[APNs] Credentials detected — APNs push enabled');
} else {
  console.log('[APNs] APNS_* env vars not set — APNs push disabled');
}

export interface IosPushPayload {
  title: string;
  body: string;
  badge?: number;
  sound?: string;
  data?: Record<string, string>;
  silent?: boolean;
}

export async function sendApnsToTenant(
  tenantId: string,
  payload: IosPushPayload,
  prisma: PrismaClient
): Promise<void> {
  const prov = getProvider();
  if (!prov) return;

  try {
    const tokens = await prisma.iosPushToken.findMany({ where: { tenantId } });
    if (tokens.length === 0) return;

    const note = new apn.Notification();
    note.topic = APNS_BUNDLE_ID;

    if (payload.silent) {
      note.contentAvailable = true;
      note.priority = 5;
      note.pushType = 'background';
      note.payload = payload.data || {};
    } else {
      note.alert = { title: payload.title, body: payload.body };
      note.sound = payload.sound || 'default';
      note.pushType = 'alert';
      if (payload.badge !== undefined) note.badge = payload.badge;
      note.payload = payload.data || {};
    }

    const deviceTokens = tokens.map(t => t.deviceToken);
    console.log(`[APNs] Sending to ${deviceTokens.length} iOS device(s) for tenant ${tenantId}: ${payload.silent ? 'silent' : payload.title}`);
    const result = await prov.send(note, deviceTokens);

    if (result.sent.length > 0) {
      const sentTokens = result.sent.map(s => s.device);
      await prisma.iosPushToken.updateMany({
        where: { deviceToken: { in: sentTokens } },
        data: { lastUsedAt: new Date() },
      });
    }

    const invalidTokens: string[] = [];
    for (const failure of result.failed) {
      const reason = failure.response?.reason;
      if (reason === 'BadDeviceToken' || reason === 'Unregistered') {
        invalidTokens.push(failure.device);
      } else {
        console.warn(`[APNs] Send failed to ${failure.device.slice(0, 12)}…: ${reason || failure.error?.message || 'unknown'}`);
      }
    }
    if (invalidTokens.length > 0) {
      console.log(`[APNs] Removing ${invalidTokens.length} invalid token(s)`);
      await prisma.iosPushToken.deleteMany({ where: { deviceToken: { in: invalidTokens } } });
    }
  } catch (err) {
    console.warn('[APNs] sendApnsToTenant failed (non-fatal):', err);
  }
}

export async function shutdownApns(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    console.log('[APNs] Provider shut down');
  }
}
