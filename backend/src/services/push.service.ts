import webpush from 'web-push';
import { PrismaClient } from '@prisma/client';
import { sendApnsToTenant } from './apns.service';

// Initialize VAPID — silently disabled if env vars missing
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';
let PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('[Push] VAPID configured — push notifications enabled');
  } catch (err: any) {
    console.warn('[Push] Invalid VAPID keys — push disabled:', err.message);
    PUSH_ENABLED = false;
  }
} else {
  console.log('[Push] VAPID keys not set — push notifications disabled');
}

export function getVapidPublicKey(): string | null {
  return PUSH_ENABLED ? VAPID_PUBLIC_KEY : null;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

export async function sendPushToTenant(
  tenantId: string,
  payload: PushPayload,
  prisma: PrismaClient
): Promise<void> {
  if (!PUSH_ENABLED) return;

  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { tenantId },
    });

    if (subscriptions.length === 0) return;

    let payloadStr = JSON.stringify({
      ...payload,
      icon: payload.icon || '/apple-icon.png',
      badge: payload.badge || '/icon-light-32x32.png',
    });

    // Bugfix (2026-04-23): Web Push limits payloads to ~4KB. Without
    // a guard, sending a long body (e.g. agent-generated escalation
    // message that ballooned past 4KB) caused webpush.sendNotification
    // to throw 413 — which was NOT handled by the 410/404 cleanup
    // branch below, so the push silently disappeared with only a
    // warn in the logs. Truncate the body field defensively before
    // serialising again. Caps at ~3500 bytes for headroom over the
    // surrounding metadata.
    if (payloadStr.length > 4000) {
      const truncBody = typeof payload.body === 'string'
        ? payload.body.slice(0, 600) + '…'
        : '';
      payloadStr = JSON.stringify({
        ...payload,
        body: truncBody,
        icon: payload.icon || '/apple-icon.png',
        badge: payload.badge || '/icon-light-32x32.png',
      });
      // If still too big (e.g. exotic data field), hard-cap by truncating
      // the serialized string itself with a closing brace approximation.
      if (payloadStr.length > 4000) {
        payloadStr = JSON.stringify({
          title: typeof payload.title === 'string' ? payload.title.slice(0, 80) : '',
          body: '…',
          icon: payload.icon || '/apple-icon.png',
          badge: payload.badge || '/icon-light-32x32.png',
        });
      }
    }

    console.log(`[Push] Sending to ${subscriptions.length} device(s) for tenant ${tenantId}: ${payload.title}`);

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payloadStr
          );
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired — clean up
            console.log(`[Push] Subscription expired (${err.statusCode}), removing: ${sub.endpoint.substring(0, 50)}...`);
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          } else {
            console.warn(`[Push] Send failed: ${err.message || err}`);
          }
        }
      })
    );
  } catch (err) {
    console.warn('[Push] sendPushToTenant failed (non-fatal):', err);
  }
}

// Fan-out wrapper: fires to both Web Push and APNs in parallel. Each
// channel already swallows its own errors, so this never throws.
//
// TODO: silent push for ai_suggestion and reservation_updated status-only
// events (Batch E.2 on iOS side must be ready to handle content-available
// before we flip any call sites to { silent: true }).
export async function sendPushToTenantAll(
  tenantId: string,
  payload: PushPayload,
  prisma: PrismaClient
): Promise<void> {
  const badge = await getUnreadBadgeCount(tenantId, prisma).catch(() => undefined);

  const stringifiedData: Record<string, string> = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      if (v !== null && v !== undefined) stringifiedData[k] = String(v);
    }
  }

  await Promise.allSettled([
    sendPushToTenant(tenantId, payload, prisma),
    sendApnsToTenant(
      tenantId,
      {
        title: payload.title,
        body: payload.body,
        data: stringifiedData,
        badge,
      },
      prisma
    ),
  ]);
}

async function getUnreadBadgeCount(tenantId: string, prisma: PrismaClient): Promise<number> {
  const result = await prisma.conversation.aggregate({
    where: { tenantId, status: 'OPEN' },
    _sum: { unreadCount: true },
  });
  return result._sum.unreadCount ?? 0;
}

export async function subscribe(
  tenantId: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent: string,
  prisma: PrismaClient
): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { tenantId_endpoint: { tenantId, endpoint: subscription.endpoint } },
    create: {
      tenantId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
    },
    update: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent,
    },
  });
  console.log(`[Push] Subscribed device for tenant ${tenantId}`);
}

export async function unsubscribe(
  tenantId: string,
  endpoint: string,
  prisma: PrismaClient
): Promise<void> {
  await prisma.pushSubscription.deleteMany({
    where: { tenantId, endpoint },
  });
  console.log(`[Push] Unsubscribed device for tenant ${tenantId}`);
}
