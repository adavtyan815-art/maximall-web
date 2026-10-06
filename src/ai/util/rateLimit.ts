import crypto from 'crypto';
import type { Request } from 'express';

/** Sliding-window limiter (in memory, per process): at most `max` hits per `windowMs` for a key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    public readonly max: number,
    public readonly windowMs: number,
    private now: () => number = () => Date.now(),
  ) {}
  /** Hits in the current window, without adding one. */
  count(key: string): number {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs).length;
  }
  take(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.|::ffff:172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i;

/**
 * Client address for rate limits. Behind nginx (a private/loopback peer) the last X-Forwarded-For entry is the one nginx
 * appended ($proxy_add_x_forwarded_for), i.e. the real client; a direct peer's own address is used otherwise, so a client
 * cannot pick its bucket by sending the header itself.
 */
export function clientIp(req: Pick<Request, 'headers' | 'socket'>): string {
  const peer = String(req.socket?.remoteAddress ?? '');
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (xff.length && PRIVATE.test(peer)) return xff[xff.length - 1];
  return peer || 'unknown';
}

/** base62 id with >= `bits` of entropy (rejection sampling, no modulo bias). */
export function randomId62(bits: number): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const len = Math.ceil(bits / Math.log2(62));
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += A[b % 62];
    }
  }
  return out;
}
