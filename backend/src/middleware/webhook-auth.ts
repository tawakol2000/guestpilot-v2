import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';

/**
 * Webhook Basic Auth middleware (FR-001).
 * Hostaway supports optional HTTP Basic Auth on webhooks.
 *
 * 2026-05-15 hardening:
 *   - Constant-time secret comparison via `crypto.timingSafeEqual` (prevents
 *     side-channel byte-by-byte secret recovery).
 *   - Tenants without a configured `webhookSecret` no longer fall through
 *     open: any POST without a credential is rejected with 401. Previously
 *     unauthenticated POSTs to /webhooks/hostaway/:tenantId for unconfigured
 *     tenants could inject fake reservations / guest messages.
 */
function safeEquals(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; check length first.
  // Length difference is the one inequality side-channel we accept —
  // the secret length is a much weaker leak than the secret bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

export function makeWebhookAuthMiddleware(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.params.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: 'Missing tenantId' });
      return;
    }

    let tenant;
    try {
      tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, webhookSecret: true },
      });
    } catch {
      res.status(500).json({ error: 'Database error' });
      return;
    }

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    if (!tenant.webhookSecret) {
      // Unconfigured tenant: refuse to accept the webhook rather than
      // accept everything. Operators see a clear setup gap; attackers
      // can't inject fake guest messages by knowing the tenantId.
      console.warn(
        `[Webhook] [${tenantId}] REJECTED — tenant has no webhookSecret configured. Set webhookSecret on the tenant row before accepting webhooks.`,
      );
      res.status(401).json({ error: 'Webhook authentication not configured for this tenant' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      console.warn(
        `[Webhook] [${tenantId}] REJECTED — no Basic Auth header provided.`,
      );
      res.status(401).json({ error: 'Webhook authentication required' });
      return;
    }

    // Decode "Basic base64(user:pass)".
    let password: string;
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;
    } catch {
      res.status(401).json({ error: 'Malformed Basic Auth header' });
      return;
    }

    if (!safeEquals(password, tenant.webhookSecret)) {
      console.warn(`[Webhook] [${tenantId}] Basic Auth REJECTED — wrong secret`);
      res.status(401).json({ error: 'Invalid webhook credentials' });
      return;
    }

    next();
  };
}
