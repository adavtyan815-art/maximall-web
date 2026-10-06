import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { AddressInfo } from 'net';
import { fixtureIndex } from './helpers/catalog';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { RateLimiter } from '../src/ai/util/rateLimit';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { MockStreamingStt } from '../src/ai/providers/streamingStt';
import { MADISON_FACE_ID, SIMLI_TOKEN_URL, SimliAvatarService } from '../src/ai/avatar/simli';

/**
 * v2.3 Simli «Madison» avatar: POST /api/ai/avatar/session mints a Simli session token (key stays in the backend).
 * No network: fetch is a stub. The key below is a fake test value.
 */
const FAKE_KEY = 'test-simli-key-not-real';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-'));
let n = 0;
const ledger = (o: { capUsd?: number; perSessionCapUsd?: number } = {}) => new CostLedger({ file: path.join(tmp, `spend-${++n}.jsonl`), ...o });
const approved = (extra: Record<string, string> = {}) => ({ SIMLI_API_KEY: FAKE_KEY, AI_PAID_CALLS_APPROVED: '1', ...extra }) as NodeJS.ProcessEnv;

function stubFetch(status = 200, body: any = { session_token: 'tok-123' }) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('v2.3 Simli avatar session (SimliAvatarService)', () => {
  it('no key, paid calls not approved, forced mocks -> provider "none" and no call', async () => {
    const f = stubFetch();
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ AI_PAID_CALLS_APPROVED: '1' }, 'no_key'],
      [{ SIMLI_API_KEY: FAKE_KEY }, 'paid_calls_not_approved'],
      [{ SIMLI_API_KEY: FAKE_KEY, AI_PAID_CALLS_APPROVED: '0' }, 'paid_calls_not_approved'],
      [approved({ AI_FORCE_MOCK: '1' }), 'mock_mode'],
    ];
    for (const [env, reason] of cases) {
      const svc = new SimliAvatarService({ ledger: ledger(), env, fetch: f.fn });
      expect(svc.mode).toBe('none');
      expect(await svc.createSession('i:u')).toEqual({ provider: 'none', reason });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('success: Madison, documented request, token only; booked in the ledger at maxSessionLength/60 × $0.01; key never returned or logged', async () => {
    const f = stubFetch();
    const logs: any[] = [];
    const l = ledger();
    const svc = new SimliAvatarService({ ledger: l, env: approved(), fetch: f.fn, log: (o) => logs.push(o) });
    expect(svc.mode).toBe('simli');
    const out = await svc.createSession('inst:anna');
    expect(out).toEqual({ provider: 'simli', sessionToken: 'tok-123', faceId: MADISON_FACE_ID, maxSessionLength: 1800, maxIdleTime: 300 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(SIMLI_TOKEN_URL);
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers['x-simli-api-key']).toBe(FAKE_KEY);
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ faceId: MADISON_FACE_ID, handleSilence: true, maxSessionLength: 1800, maxIdleTime: 300 });
    const e = l.entries();
    expect(e.map((x) => x.status)).toEqual(['reserved', 'settled']);
    expect(e[1]).toMatchObject({ provider: 'simli', sessionId: 'avatar:inst:anna', actualUsd: 0.3 }); // own ledger id: not the visitor's conversation cap
    expect(JSON.stringify(out) + JSON.stringify(logs) + fs.readFileSync(l.file, 'utf8')).not.toContain(FAKE_KEY);
  });

  it('env overrides: SIMLI_FACE_ID, SIMLI_MAX_SESSION_LENGTH, SIMLI_MAX_IDLE_TIME, SIMLI_USD_PER_MIN (bad face id -> Madison)', async () => {
    const f = stubFetch();
    const l = ledger();
    const face = 'd2a5c7c6-fed9-4f55-bcb3-062f7cd20103';
    const svc = new SimliAvatarService({ ledger: l, env: approved({ SIMLI_FACE_ID: face, SIMLI_MAX_SESSION_LENGTH: '600', SIMLI_MAX_IDLE_TIME: '60', SIMLI_USD_PER_MIN: '0.02' }), fetch: f.fn });
    expect(await svc.createSession('s1')).toMatchObject({ provider: 'simli', faceId: face, maxSessionLength: 600, maxIdleTime: 60 });
    expect(l.entries()[1].actualUsd).toBeCloseTo(0.2, 6);
    expect(new SimliAvatarService({ ledger: l, env: approved({ SIMLI_FACE_ID: 'nope' }) }).faceId).toBe(MADISON_FACE_ID);
  });

  it('Simli HTTP error or unreachable -> "none" with a reason; nothing is booked', async () => {
    const l = ledger();
    const bad = stubFetch(401, { detail: 'Invalid API key' });
    expect(await new SimliAvatarService({ ledger: l, env: approved(), fetch: bad.fn }).createSession('s')).toEqual({ provider: 'none', reason: 'simli_http_401' });
    const empty = stubFetch(200, {});
    expect(await new SimliAvatarService({ ledger: l, env: approved(), fetch: empty.fn }).createSession('s')).toEqual({ provider: 'none', reason: 'simli_http_200' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await new SimliAvatarService({ ledger: l, env: approved(), fetch: down }).createSession('s')).toEqual({ provider: 'none', reason: 'simli_unreachable' });
    expect(l.totalUsd()).toBe(0);
    expect(l.entries().filter((x) => x.status === 'settled').every((x) => x.actualUsd === 0)).toBe(true);
  });

  it('caps: total and per-session budget refuse before any call', async () => {
    const f = stubFetch();
    expect(await new SimliAvatarService({ ledger: ledger({ capUsd: 0.1 }), env: approved(), fetch: f.fn }).createSession('s')).toEqual({ provider: 'none', reason: 'budget_cap' });
    const l = ledger({ perSessionCapUsd: 0.5 });
    const svc = new SimliAvatarService({ ledger: l, env: approved(), fetch: f.fn });
    expect((await svc.createSession('s')).provider).toBe('simli'); // $0.30
    expect(await svc.createSession('s')).toEqual({ provider: 'none', reason: 'budget_cap' }); // $0.60 > $0.50
    expect((await svc.createSession('other')).provider).toBe('simli');
    expect(f.calls).toHaveLength(2);
  });

  it('rate limit: 6 tokens per session per 10 min, then "rate_limited"', async () => {
    const f = stubFetch();
    const svc = new SimliAvatarService({ ledger: ledger({ perSessionCapUsd: 100 }), env: approved(), fetch: f.fn, limiter: new RateLimiter(6, 10 * 60_000) });
    for (let i = 0; i < 6; i++) expect((await svc.createSession('s')).provider).toBe('simli');
    expect(await svc.createSession('s')).toEqual({ provider: 'none', reason: 'rate_limited' });
    expect((await svc.createSession('s2')).provider).toBe('simli');
    expect(f.calls).toHaveLength(7);
  });
});

describe('v2.3 REST POST /api/ai/avatar/session and /api/ai/health', () => {
  const f = fixtureIndex();
  let server: http.Server;
  let url: string;
  const servers: http.Server[] = [];
  const start = async (avatar?: SimliAvatarService) => {
    const app = express();
    const mod: AiModule = createAiModule({
      catalog: f.catalog,
      logDir: path.join(tmp, 'logs'),
      clips: new ClipStore(path.join(tmp, 'clips')),
      renderDir: path.join(tmp, 'renders'),
      savesDir: path.join(tmp, 'saves'),
      dossierDir: path.join(tmp, 'dossiers'),
      providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), sttStream: new MockStreamingStt(), tts: new MockTts(), ledger: ledger(), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} } as any,
      ...(avatar ? { avatar } : {}),
    });
    app.use(mod.router);
    const s = http.createServer(app);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const post = (base: string, body: any) => fetch(`${base}/api/ai/avatar/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const stub = stubFetch(200, { session_token: 'tok-route' });
    url = await start(new SimliAvatarService({ ledger: ledger(), env: approved(), fetch: stub.fn }));
    server = servers[0];
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it('unknown session -> 404 "none"; a live session gets the token; health says avatar "simli"', async () => {
    const r0 = await post(url, { sessionId: 'nobody' });
    expect(r0.status).toBe(404);
    expect(await r0.json()).toEqual({ provider: 'none', reason: 'unknown_session' });
    await fetch(`${url}/api/ai/dev/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'dev:avatar', text: 'Здравствуйте', mode: 'showroom' }) });
    const r1 = await post(url, { sessionId: 'dev:avatar' });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ provider: 'simli', sessionToken: 'tok-route', faceId: MADISON_FACE_ID, maxSessionLength: 1800, maxIdleTime: 300 });
    expect((await (await fetch(`${url}/api/ai/health`)).json()).avatar).toBe('simli');
    void server;
  });

  it('the default service under vitest (AI_FORCE_MOCK=1): health "none", the endpoint answers "none" without a call', async () => {
    const base = await start();
    expect((await (await fetch(`${base}/api/ai/health`)).json()).avatar).toBe('none');
    await fetch(`${base}/api/ai/dev/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'dev:avatar2', text: 'Здравствуйте', mode: 'showroom' }) });
    const r = await post(base, { sessionId: 'dev:avatar2' });
    expect(await r.json()).toMatchObject({ provider: 'none' });
  });
});
