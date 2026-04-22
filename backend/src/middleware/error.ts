import { Request, Response, NextFunction } from 'express';

/**
 * Bugfix (2026-04-23): the previous error handler returned `err.message`
 * verbatim regardless of status — for any 500 (Prisma P2002, DB connection
 * errors with internal IPs, JWT-library internals, "connect ECONNREFUSED
 * 10.x.y.z:5432", etc.) the raw message leaked to unauthenticated callers.
 * This is the classic information-disclosure surface. Many controllers
 * `throw` without locally catching, so this handler is the one chance
 * to scrub.
 *
 * Policy:
 *   - status < 500: caller-actionable (validation, 404, 403, 409, etc.).
 *     The thrown message is intended for the client and is safe to surface.
 *   - status >= 500: internal failure. Return a generic message; the full
 *     error stays in the server log only.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('[Error]', err);

  if (err instanceof Error) {
    const status = (err as { status?: number }).status || 500;
    const isClientError = status >= 400 && status < 500;
    const safeMessage = isClientError
      ? err.message || 'Bad request'
      : 'Internal server error';
    res.status(status).json({ error: safeMessage });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
