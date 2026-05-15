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
  // 2026-05-15 (auto-review F8): apply loginLimiter to dev-login as
  // defence-in-depth. The handler self-disables outside dev, but on a
  // dev box with DEV_AUTH_BYPASS=1 it issues prod-equivalent JWTs.
  router.post('/dev-login', loginLimiter, (req, res) => ctrl.devLogin(req, res));
  router.get('/settings', authMiddleware as any, (req, res) => ctrl.getSettings(req, res));
  // 2026-05-15 (auto-review F5): apply loginLimiter so an attacker with
  // a valid (possibly stolen) session token can't brute-force
  // `currentPassword` guesses without rate cost.
  router.post('/change-password', loginLimiter, authMiddleware as any, (req, res) => ctrl.changePassword(req, res));

  return router;
}
