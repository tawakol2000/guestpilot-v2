import webpush from 'web-push';
import { PrismaClient } from '@prisma/client';

// Initialize VAPID — silently disabled if env vars missing
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[Push] VAPID configured — push notifications enabled');
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

    const payloadStr = JSON.stringify({
      ...payload,
      icon: payload.icon || '/apple-icon.png',
      badge: payload.badge || '/icon-light-32x32.png',
    });

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
