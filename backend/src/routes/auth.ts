import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeAuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth';
import { loginLimiter, signupLimiter } from '../middleware/rate-limit';

export function authRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeAuthController(prisma);

  router.post('/signup', signupLimiter, (req, res) => ctrl.signup(req, res));
  router.post('/login', loginLimiter, (req, res) => ctrl.login(req, res));
  router.get('/settings', authMiddleware as any, (req, res) => ctrl.getSettings(req, res));
  router.post('/change-password', authMiddleware as any, (req, res) => ctrl.changePassword(req, res));

  return router;
}
