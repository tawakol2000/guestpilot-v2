import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeAuthController } from '../controllers/auth.controller';

export function authRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makeAuthController(prisma);

  router.post('/signup', (req, res) => ctrl.signup(req, res));
  router.post('/login', (req, res) => ctrl.login(req, res));

  return router;
}
