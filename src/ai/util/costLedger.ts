import fs from 'fs';
import path from 'path';

/**
 * Append-only spend ledger (JSON lines) shared by every paid provider call.
 * Default file: D:/awsTemplate_GameLift/docs/AI_Consultant_Expo/api_spend.jsonl (env AI_SPEND_LOG).
 * A call must reserve() its estimated cost first; the ledger refuses when total + estimate > cap.
 */
export interface SpendEntry {
  ts: string;
  provider: string; // anthropic | elevenlabs | fal | gemini
  call: string; // e.g. messages.create claude-sonnet-5-5
  sessionId?: string;
  estUsd: number;
  actualUsd?: number;
  runningTotalUsd: number;
  status: 'reserved' | 'settled' | 'failed';
  note?: string;
}

export class BudgetExceededError extends Error {
  code = 'BUDGET_EXCEEDED';
  constructor(msg: string) {
    super(msg);
  }
}

/** Local (Windows) default: the Expo docs folder. On a Linux host: <cwd>/data/api_spend.jsonl (a volume in docker-compose). */
export const DEFAULT_SPEND_LOG = process.platform === 'win32' ? 'D:/awsTemplate_GameLift/docs/AI_Consultant_Expo/api_spend.jsonl' : path.join(process.cwd(), 'data', 'api_spend.jsonl');

/**
 * A $ cap from the environment. Unset -> the default. Empty -> 0 (every paid call refused) with a loud warning.
 * Non-numeric / negative / infinite used to become NaN (NaN comparisons are false = no cap at all): now the default cap
 * applies instead, with a loud warning — a typo must never remove the budget limit.
 */
export function usdEnv(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined) return def;
  if (raw.trim() === '') {
    console.warn(`[AI][Budget] ${name} is set but empty: cap = $0, every paid AI call will be refused. Set a number (default ${def}).`);
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[AI][Budget] ${name}=${JSON.stringify(raw.slice(0, 40))} is not a non-negative number: using the default cap $${def}.`);
    return def;
  }
  return n;
}

export class CostLedger {
  readonly file: string;
  readonly capUsd: number;
  readonly perSessionCapUsd: number;
  constructor(opts: { file?: string; capUsd?: number; perSessionCapUsd?: number } = {}) {
    this.file = opts.file ?? process.env.AI_SPEND_LOG ?? DEFAULT_SPEND_LOG;
    this.capUsd = opts.capUsd ?? usdEnv('AI_BUDGET_USD', 50);
    this.perSessionCapUsd = opts.perSessionCapUsd ?? usdEnv('AI_SESSION_CAP_USD', 1.5);
  }

  entries(): SpendEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as SpendEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is SpendEntry => !!e);
  }

  /** Total = settled actuals + estimates of calls that never settled. Failed calls count their estimate (conservative). */
  totalUsd(filter?: (e: SpendEntry) => boolean): number {
    const byKey = new Map<string, number>();
    let anon = 0;
    for (const e of this.entries()) {
      if (filter && !filter(e)) continue;
      const key = e.note?.startsWith('id=') ? e.note : undefined;
      const v = e.status === 'settled' ? e.actualUsd ?? e.estUsd : e.estUsd;
      if (key) byKey.set(key, v); // later entry (settled) replaces the reservation
      else anon += v;
    }
    let t = anon;
    for (const v of byKey.values()) t += v;
    return Math.round(t * 1e6) / 1e6;
  }

  sessionTotalUsd(sessionId: string) {
    return this.totalUsd((e) => e.sessionId === sessionId);
  }

  /** Reserve an estimated cost. Throws BudgetExceededError when the global or per-session cap would be passed. */
  reserve(provider: string, call: string, estUsd: number, sessionId?: string): { id: string; settle: (actualUsd?: number, ok?: boolean) => void } {
    const total = this.totalUsd();
    if (total + estUsd > this.capUsd) {
      throw new BudgetExceededError(`API budget cap $${this.capUsd} would be passed (spent ~$${total.toFixed(4)}, next ~$${estUsd.toFixed(4)})`);
    }
    if (sessionId && this.sessionTotalUsd(sessionId) + estUsd > this.perSessionCapUsd) {
      throw new BudgetExceededError(`Per-session cap $${this.perSessionCapUsd} reached for ${sessionId}`);
    }
    const id = `id=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.append({ ts: new Date().toISOString(), provider, call, sessionId, estUsd, runningTotalUsd: total + estUsd, status: 'reserved', note: id });
    return {
      id,
      settle: (actualUsd?: number, ok = true) => {
        const t = this.totalUsd() - estUsd + (actualUsd ?? estUsd);
        this.append({
          ts: new Date().toISOString(),
          provider,
          call,
          sessionId,
          estUsd,
          actualUsd: actualUsd ?? estUsd,
          runningTotalUsd: Math.round(t * 1e6) / 1e6,
          status: ok ? 'settled' : 'failed',
          note: id,
        });
      },
    };
  }

  private append(e: SpendEntry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n', 'utf8');
  }
}

/** Anthropic list prices (USD per 1M tokens), read from the claude-api skill 2026-09-30. */
export const ANTHROPIC_PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function anthropicCostUsd(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const p = ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES['claude-sonnet-5-5'];
  return (
    ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6
  );
}
