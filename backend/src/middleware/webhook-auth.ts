import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

/**
 * Webhook Basic Auth middleware (FR-001).
 * Hostaway supports optional HTTP Basic Auth on webhooks.
 * - Header present + secret matches: proceed
 * - Header present + secret wrong: reject 401
 * - Header absent + tenant has secret: log warning, proceed (grace period)
 * - Header absent + tenant has no secret: proceed (unconfigured)
 */
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

    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Basic ')) {
      // Decode Basic Auth: "Basic base64(user:pass)"
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      const password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;

      if (tenant.webhookSecret && password !== tenant.webhookSecret) {
        console.warn(`[Webhook] [${tenantId}] Basic Auth REJECTED — wrong secret`);
        res.status(401).json({ error: 'Invalid webhook credentials' });
        return;
      }
      // Credentials match (or tenant has no secret configured) — proceed
    } else if (tenant.webhookSecret) {
      // No auth header but tenant has a secret configured — grace period
      console.warn(
        `[Webhook] [${tenantId}] No Basic Auth header — processing with grace period. ` +
        `Configure webhook credentials in Hostaway dashboard for full security.`
      );
    }
    // No auth header and no secret configured — proceed (unconfigured tenant)

    next();
  };
}
