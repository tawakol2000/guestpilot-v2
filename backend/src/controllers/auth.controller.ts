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
  };
}
