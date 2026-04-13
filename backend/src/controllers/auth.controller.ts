import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../middleware/auth';
import crypto from 'crypto';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  hostawayApiKey: z.string().min(1),
  hostawayAccountId: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function webhookUrl(tenantId: string): string {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 3001}`;
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${protocol}://${domain}/webhooks/hostaway/${tenantId}`;
}

export function makeAuthController(prisma: PrismaClient) {
  return {
    async signup(req: Request, res: Response): Promise<void> {
      try {
        const parsed = signupSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const { email, password, hostawayApiKey, hostawayAccountId } = parsed.data;

        const existing = await prisma.tenant.findUnique({ where: { email } });
        if (existing) {
          res.status(409).json({ error: 'Email already registered' });
          return;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const webhookSecret = crypto.randomBytes(32).toString('hex');

        const tenant = await prisma.tenant.create({
          data: { email, passwordHash, hostawayApiKey, hostawayAccountId, webhookSecret },
        });

        const token = signToken({ tenantId: tenant.id, email: tenant.email, plan: tenant.plan });

        res.status(201).json({
          token,
          tenantId: tenant.id,
          email: tenant.email,
          plan: tenant.plan,
          webhookUrl: webhookUrl(tenant.id),
          webhookSecret,
        });
      } catch (err) {
        console.error('[Auth] signup error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async login(req: Request, res: Response): Promise<void> {
      try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }

        const { email, password } = parsed.data;

        const tenant = await prisma.tenant.findUnique({ where: { email } });
        if (!tenant) {
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        const valid = await bcrypt.compare(password, tenant.passwordHash);
        if (!valid) {
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        const token = signToken({ tenantId: tenant.id, email: tenant.email, plan: tenant.plan });

        res.json({
          token,
          tenantId: tenant.id,
          email: tenant.email,
          plan: tenant.plan,
          webhookUrl: webhookUrl(tenant.id),
        });
      } catch (err) {
        console.error('[Auth] login error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async changePassword(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = (req as any).tenantId as string | undefined;
        if (!tenantId) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
        if (!currentPassword) {
          res.status(400).json({ error: 'Current password is required' });
          return;
        }
        if (!newPassword || newPassword.length < 8) {
          res.status(400).json({ error: 'New password must be at least 8 characters' });
          return;
        }

        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }

        const valid = await bcrypt.compare(currentPassword, tenant.passwordHash);
        if (!valid) {
          res.status(401).json({ error: 'Current password incorrect' });
          return;
        }

        const passwordHash = await bcrypt.hash(newPassword, 12);
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { passwordHash },
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('[Auth] changePassword error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async getSettings(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = (req as any).tenantId;
        if (!tenantId) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }

        res.json({
          webhookUrl: webhookUrl(tenant.id),
          webhookSecret: tenant.webhookSecret,
        });
      } catch (err) {
        console.error('[Auth] getSettings error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
