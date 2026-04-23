import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, JwtPayload } from '../types';

// FR-002: JWT_SECRET MUST be explicitly set — no fallback
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

export const JWT_SECRET = process.env.JWT_SECRET;

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    // Bugfix (2026-04-23): was `jwt.verify(token, JWT_SECRET)` with no
    // options. Lock `algorithms: ['HS256']` so a forged token with
    // `alg: 'none'` or an asymmetric algorithm confusion attack (RS256
    // verified as HS256 with the public key as secret) can't slip
    // past. We always sign with HS256 (default of jsonwebtoken), so
    // restricting verify to HS256 is a tightening no-op.
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    }) as JwtPayload;
    req.tenantId = payload.tenantId;
    req.tenantPlan = payload.plan;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function signToken(payload: JwtPayload): string {
  // Bugfix (2026-04-23): explicit algorithm match the verify lock
  // above. jsonwebtoken defaults to HS256 already; stating it keeps
  // the pair explicit for the next reader.
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
}
