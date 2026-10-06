import { BudgetExceededError, CostLedger } from '../util/costLedger';
import { RateLimiter, envInt } from '../util/rateLimit';

/**
 * Contracts v2.3 (Artur 2026-10-02): the kiosk avatar is Simli's stock face «Madison». The page renders the Simli live
 * video (simli-client, LiveKit); the backend only mints a short-lived session token so the API key never leaves it.
 *
 *   POST https://api.simli.ai/compose/token   header x-simli-api-key
 *        {faceId, handleSilence:true, maxSessionLength, maxIdleTime} -> {session_token}
 * (as in the working reference D:\AI_Consultant_Workspace\simli_test\server.mjs, 2026-10-02 16:26).
 *
 * Simli is used only when SIMLI_API_KEY is present AND paid calls are approved (AI_PAID_CALLS_APPROVED=1) AND mocks are not
 * forced (AI_FORCE_MOCK) — the same rule as every other provider; otherwise {provider:"none"} and the page keeps the 2D
 * avatar. Each session is booked in the spend ledger (rendering is billed per connected minute: estimate =
 * maxSessionLength/60 × SIMLI_USD_PER_MIN), refused beyond the total / per-session caps, and rate-limited per session.
 * The key is never returned or logged.
 */
export const MADISON_FACE_ID = '5fc23ea5-8175-4a82-aaaf-cdd8c88543dc';
export const SIMLI_TOKEN_URL = 'https://api.simli.ai/compose/token';

export type AvatarSession =
  | { provider: 'simli'; sessionToken: string; faceId: string; maxSessionLength: number; maxIdleTime: number }
  | { provider: 'none'; reason: string };

export interface SimliOptions {
  ledger: CostLedger;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** tokens per session id per window (default 6 per 10 min) */
  limiter?: RateLimiter;
  log?: (o: Record<string, unknown>) => void;
  timeoutMs?: number;
}

export class SimliAvatarService {
  private env: NodeJS.ProcessEnv;
  private fetchFn: typeof fetch;
  readonly limiter: RateLimiter;
  constructor(private opts: SimliOptions) {
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.limiter = opts.limiter ?? new RateLimiter(envInt('AI_AVATAR_TOKENS_PER_SESSION_10MIN', 6), 10 * 60_000);
  }

  private flagOf(name: string) {
    const v = this.env[name];
    return v === '1' || v?.toLowerCase() === 'true';
  }
  private num(name: string, dflt: number) {
    const v = Number(this.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  }

  /** Why Simli is not available (null = available). */
  unavailable(): string | null {
    if (!this.env.SIMLI_API_KEY) return 'no_key';
    if (this.flagOf('AI_FORCE_MOCK')) return 'mock_mode';
    if (!this.flagOf('AI_PAID_CALLS_APPROVED')) return 'paid_calls_not_approved';
    return null;
  }
  get mode(): 'simli' | 'none' {
    return this.unavailable() ? 'none' : 'simli';
  }
  get faceId(): string {
    const f = (this.env.SIMLI_FACE_ID ?? '').trim();
    return /^[0-9a-f-]{36}$/i.test(f) ? f : MADISON_FACE_ID;
  }

  async createSession(sessionId: string): Promise<AvatarSession> {
    const log = this.opts.log ?? (() => undefined);
    const why = this.unavailable();
    if (why) return { provider: 'none', reason: why };
    if (!this.limiter.take(sessionId)) {
      log({ event: 'avatar_token', ok: false, reason: 'rate_limited' });
      return { provider: 'none', reason: 'rate_limited' };
    }
    const faceId = this.faceId;
    const maxSessionLength = Math.round(this.num('SIMLI_MAX_SESSION_LENGTH', 1800));
    const maxIdleTime = Math.round(this.num('SIMLI_MAX_IDLE_TIME', 300));
    const estUsd = (maxSessionLength / 60) * this.num('SIMLI_USD_PER_MIN', 0.01);
    let booking: ReturnType<CostLedger['reserve']>;
    try {
      // Booked under its own ledger session id: counts toward the total cap, but avatar rendering does not consume the
      // visitor's conversation (Claude/voice) per-session cap (kiosk test 2026-10-02: 4 avatar tokens exhausted it).
      booking = this.opts.ledger.reserve('simli', `avatar session ${faceId} ≤${maxSessionLength}s`, estUsd, `avatar:${sessionId}`);
    } catch (e: any) {
      const reason = e instanceof BudgetExceededError ? 'budget_cap' : 'ledger_error';
      log({ event: 'avatar_token', ok: false, reason });
      return { provider: 'none', reason };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const r = await this.fetchFn(SIMLI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-simli-api-key': String(this.env.SIMLI_API_KEY) },
        body: JSON.stringify({ faceId, handleSilence: true, maxSessionLength, maxIdleTime }),
        signal: ctl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      const token = typeof j?.session_token === 'string' ? j.session_token : '';
      if (!r.ok || !token) {
        booking.settle(0, true); // no session was minted: nothing billed
        const reason = `simli_http_${r.status}`;
        log({ event: 'avatar_token', ok: false, reason, http: r.status });
        return { provider: 'none', reason };
      }
      booking.settle(estUsd, true); // booked at the estimate (billed per connected minute, ≤ maxSessionLength)
      log({ event: 'avatar_token', ok: true, faceId, maxSessionLength, maxIdleTime, estUsd });
      return { provider: 'simli', sessionToken: token, faceId, maxSessionLength, maxIdleTime };
    } catch (e: any) {
      booking.settle(0, true);
      const reason = e?.name === 'AbortError' ? 'simli_timeout' : 'simli_unreachable';
      log({ event: 'avatar_token', ok: false, reason });
      return { provider: 'none', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The process-wide service: env decides (key + AI_PAID_CALLS_APPROVED + not AI_FORCE_MOCK). */
export function createAvatarService(ledger: CostLedger): SimliAvatarService {
  return new SimliAvatarService({ ledger });
}
