import { Request, Response, NextFunction } from 'express';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('[Error]', err);

  if (err instanceof Error) {
    const status = (err as { status?: number }).status || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
    });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
