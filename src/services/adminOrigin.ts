import type { Request, Response, NextFunction } from 'express';

/**
 * Admin CSRF hardening (coordinator 23:45). The app-wide CORS reflects any origin with credentials (player pages come
 * from changing EC2 IPs and ngrok), so /api/admin/* adds its own check: a request that carries an Origin header must
 * come from the backend's own origin. Requests without Origin (same-origin navigation, curl) behave as before.
 *
 * Allowed = scheme://Host of the request (the scheme is X-Forwarded-Proto, which nginx sets, or the socket's protocol)
 * plus PUBLIC_ORIGIN from .env (comma-separated), e.g. "https://18-185-5-251.nip.io" in production, or
 * "http://localhost:8080" to let a local player page's staff view call the admin API during local testing.
 */
export function ownOrigins(req: Request, env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.PUBLIC_ORIGIN ?? '')
    .split(',')
    .map((x) => x.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return configured;
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  const proto = fwd === 'https' || fwd === 'http' ? fwd : (req.socket as any)?.encrypted ? 'https' : 'http';
  return [`${proto}://${host}`, ...configured];
}

/** Case-insensitive like Express routing (/API/Admin/... reaches the admin handlers). */
export function isAdminPath(path: string) {
  const p = path.toLowerCase();
  return p === '/api/admin' || p.startsWith('/api/admin/');
}

/** Mount BEFORE the cors middleware, so a refused request gets no CORS allow headers. */
export function adminOriginGuard(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isAdminPath(req.path)) return next();
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    const o = String(origin).trim().replace(/\/+$/, '').toLowerCase();
    if (o && o !== 'null' && ownOrigins(req, env).includes(o)) return next();
    console.warn(`[Auth] refused cross-origin admin request ${req.method} ${req.path} from ${String(origin).slice(0, 120)}`);
    res.status(403).json({ error: 'Forbidden origin' });
  };
}
