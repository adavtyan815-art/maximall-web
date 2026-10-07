import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as ioc, Socket, Manager } from 'socket.io-client';
import { AddressInfo } from 'net';
import { fixtureIndex } from './helpers/catalog';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { syntheticCapture } from './helpers/capture';
import { clientIp, randomId62, RateLimiter } from '../src/ai/util/rateLimit';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';

/** Security review (coordinator 23:50): the fixes that are safe locally. */
const f = fixtureIndex();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secrev-'));
const saved = { ...process.env };
let server: http.Server;
let url: string;
let mod: AiModule;
const tokens: Record<string, string> = { 'inst-s': 'tok-A' };

beforeAll(async () => {
  Object.assign(process.env, { LOCAL_MODE: '1', AI_RENDER_MAX_PER_SESSION_10MIN: '2', AI_AR_MAX_PER_IP_10MIN: '2', AI_DOSSIER_MAX_PER_SESSION_10MIN: '1', AI_TURNS_PER_SESSION_MIN: '2', AI_VISIT_MAX_PER_IP_10MIN: '4' });
  const app = express();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mod = createAiModule({
    catalog: f.catalog,
    logDir: path.join(tmp, 'logs'),
    clips: new ClipStore(path.join(tmp, 'clips')),
    renderDir: path.join(tmp, 'renders'),
    savesDir: path.join(tmp, 'saves'),
    dossierDir: path.join(tmp, 'dossiers'),
    arDir: path.join(tmp, 'ar'),
    providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), ledger: new CostLedger({ file: path.join(tmp, 'spend.jsonl') }), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} } as any,
    verifyHostToken: (inst, tok) => tokens[inst] === tok,
  });
  app.use(mod.router);
  mod.attach(new SocketServer(server));
});
afterAll(async () => {
  process.env = saved;
  await new Promise<void>((r) => server.close(() => r()));
});

async function renderForm(meta: any, over: Partial<Record<'beauty' | 'depth' | 'mask', Buffer>> = {}) {
  const c: any = { ...(await syntheticCapture()), ...over };
  const form = new FormData();
  for (const k of ['beauty', 'depth', 'mask'] as const) form.append(k, new Blob([new Uint8Array(c[k])], { type: 'image/png' }), k + '.png');
  form.append('meta', new Blob([JSON.stringify({ width: 64, height: 48, preset: 'corner', ...meta })], { type: 'application/json' }), 'meta.json');
  return fetch(url + '/api/render', { method: 'POST', body: form });
}
const devSession = (sessionId: string) => fetch(url + '/api/ai/dev/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text: 'Привет' }) });

describe('ids are unguessable', () => {
  it('short ids have >= 64 bits (12 base62 chars), no modulo bias in the alphabet', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomId62(70)));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(12 * Math.log2(62)).toBeGreaterThan(64);
  });
});

describe('POST /api/render', () => {
  /** A renderId issued by this dev session's own capture command («Сделай фото» -> take_photo). */
  const issue = async (sessionId: string) => {
    const r: any = await (await fetch(url + '/api/ai/dev/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text: 'Сделай фото' }) })).json();
    return r.events.find((x: any) => x.event === 'ai.render' && x.payload.stage === 'capturing').payload.renderId as string;
  };
  it('unknown session 404; non-PNG and size mismatch 400; issued id accepted once; per-session limit 429', async () => {
    expect((await renderForm({ renderId: 'rn-sec-0', sessionId: 'nobody:x' })).status).toBe(404);
    await devSession('dev:render');
    const id1 = await issue('dev:render');
    expect(id1).toMatch(/^rn-[0-9]+-[0-9a-f]{16}$/);
    expect((await renderForm({ renderId: id1, sessionId: 'dev:render' }, { beauty: Buffer.from('<html><script>alert(1)</script></html>') })).status).toBe(400);
    expect((await renderForm({ renderId: id1, sessionId: 'dev:render', width: 640, height: 480 })).status).toBe(400);
    expect((await renderForm({ renderId: id1, sessionId: 'dev:render' })).status).toBe(202); // a rejected upload does not use the id up
    expect((await renderForm({ renderId: id1, sessionId: 'dev:render' })).status).toBe(403); // single use
    expect((await renderForm({ renderId: await issue('dev:render'), sessionId: 'dev:render' })).status).toBe(202);
    expect((await renderForm({ renderId: await issue('dev:render'), sessionId: 'dev:render' })).status).toBe(429); // limit 2 per 10 min in this test
    await new Promise((r) => setTimeout(r, 300));
    const img = await fetch(url + `/api/render/${id1}/beauty.png`);
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('QA-051: a renderId never issued, issued for another session, or expired -> 403 and nothing reaches the visitor', async () => {
    await devSession('dev:victim');
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-v', username: 'vera' }, reconnection: false });
    const renders: any[] = [];
    sock.on('ai.render', (p: any) => renders.push(p));
    await new Promise<void>((r) => sock.on('ai.session.ready', () => r()));
    const s = mod.namespace!.sessionFor('inst-v:vera')!;
    expect((await renderForm({ renderId: `rn-${Date.now()}-forged`, sessionId: 'inst-v:vera' })).status).toBe(403);
    const other = await issue('dev:victim');
    expect((await renderForm({ renderId: other, sessionId: 'inst-v:vera' })).status).toBe(403);
    s.pendingRenders.set('rn-expired-1', Date.now() - 1);
    expect((await renderForm({ renderId: 'rn-expired-1', sessionId: 'inst-v:vera' })).status).toBe(403);
    expect(s.pendingRenders.has('rn-expired-1')).toBe(false);
    s.pendingRenders.set('rn-issued-1', Date.now() + 60_000); // what take_photo does for this session
    expect((await renderForm({ renderId: 'rn-issued-1', sessionId: 'inst-v:vera' })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    expect(renders.every((p) => p.renderId === 'rn-issued-1')).toBe(true);
    expect(renders.length).toBeGreaterThan(0);
    sock.close();
  });
});

describe('POST /api/ar/upload', () => {
  it('integration: the AI router does not handle it (production keeps the live app.ts handler for the UE client)', async () => {
    const glb = Buffer.alloc(20);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    const r = await fetch(url + '/api/ar/upload', { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: glb });
    expect(r.status).toBe(404); // module-only express app: no route
  });
});

describe('POST /api/dossier', () => {
  it('outside LOCAL_MODE: unknown session 404, a foreign username 403, then rate-limited', async () => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-d', username: 'dora' }, reconnection: false });
    await new Promise<void>((r) => sock.on('ai.session.ready', () => r()));
    delete process.env.LOCAL_MODE;
    try {
      const post = (b: any) => fetch(url + '/api/dossier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      expect((await post({ sessionId: 'inst-x:someone' })).status).toBe(404);
      expect((await post({ sessionId: 'inst-d:dora', username: 'anna' })).status).toBe(403);
      expect((await post({ sessionId: 'inst-d:dora' })).status).not.toBe(429); // 1st: allowed (no saves -> an error, but not refused)
      expect((await post({ sessionId: 'inst-d:dora' })).status).toBe(429);
    } finally {
      process.env.LOCAL_MODE = '1';
      sock.close();
    }
  });
});

describe('Socket.io /ai', () => {
  const connect = (auth: any) => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
    const ev: [string, any][] = [];
    sock.onAny((e, p) => ev.push([e, p]));
    const until = async (pred: (x: [string, any]) => boolean) => {
      const t0 = Date.now();
      while (!ev.some(pred)) {
        if (Date.now() - t0 > 3000) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
      return ev.find(pred)!;
    };
    return { sock, ev, until };
  };

  it('a session bound to a hostToken cannot be taken over by another socket with a different or no token', async () => {
    const a = connect({ instanceUuid: 'inst-h', username: 'hanna', hostToken: 'tok-1' });
    await a.until(([e]) => e === 'ai.session.ready');
    const b = connect({ instanceUuid: 'inst-h', username: 'hanna', hostToken: 'tok-evil' });
    expect((await b.until(([e]) => e === 'ai.error'))[1].code).toBe('SESSION_TAKEN');
    // the refused tab is disconnected by the server, so the page's own disconnect handler shows «нет связи» (no auto-reconnect)
    const reason = await new Promise<string>((r) => b.sock.on('disconnect', (why) => r(why)));
    expect(reason).toBe('io server disconnect');
    expect(b.sock.connected).toBe(false);
    const c = connect({ instanceUuid: 'inst-h', username: 'hanna' });
    expect((await c.until(([e]) => e === 'ai.error'))[1].code).toBe('SESSION_TAKEN');
    const d = connect({ instanceUuid: 'inst-h', username: 'hanna', hostToken: 'tok-1' }); // the same page reconnecting
    await d.until(([e]) => e === 'ai.session.ready');
    for (const x of [a, b, c, d]) x.sock.close();
  });

  it('2026-10-07: a recycled pool instance claimed again by the same login with a new token rebinds (no false SESSION_TAKEN)', async () => {
    tokens['inst-r'] = 'tok-old';
    const a = connect({ instanceUuid: 'inst-r', username: 'artur', hostToken: 'tok-old' });
    await a.until(([e]) => e === 'ai.session.ready');
    // while the old visit is still a live pool session, another token is a second device → refused as before
    const b = connect({ instanceUuid: 'inst-r', username: 'artur', hostToken: 'tok-intruder' });
    expect((await b.until(([e]) => e === 'ai.error'))[1].code).toBe('SESSION_TAKEN');
    a.sock.close();
    // the visit ended, the instance went back to the buffer and was claimed again: only the new token is live now
    tokens['inst-r'] = 'tok-new';
    const c = connect({ instanceUuid: 'inst-r', username: 'artur', hostToken: 'tok-new' });
    await c.until(([e]) => e === 'ai.session.ready');
    // the old (no longer live) token can not take the session back
    const d = connect({ instanceUuid: 'inst-r', username: 'artur', hostToken: 'tok-old' });
    expect((await d.until(([e]) => e === 'ai.error'))[1].code).toBe('SESSION_TAKEN');
    for (const x of [b, c, d]) x.sock.close();
  });

  it('QA-054: a refused tab loses only its /ai socket; its shared back-channel stays; the first tab keeps working', async () => {
    const a = connect({ instanceUuid: 'inst-m', username: 'mila', hostToken: 'tok-m' });
    await a.until(([e]) => e === 'ai.session.ready');
    // the refused tab: ONE engine connection shared by the default-namespace back-channel and /ai (as on the player page)
    const mgr = new Manager(url, { transports: ['websocket'], reconnection: false });
    const back = mgr.socket('/');
    await new Promise<void>((r) => back.on('connect', () => r()));
    const ai = mgr.socket('/ai', { auth: { instanceUuid: 'inst-m', username: 'mila', hostToken: 'tok-other' } });
    const err = await new Promise<any>((r) => ai.on('ai.error', r));
    expect(err.code).toBe('SESSION_TAKEN');
    const why = await new Promise<string>((r) => ai.on('disconnect', (x) => r(x)));
    expect(why).toBe('io server disconnect'); // the page's panel shows «нет связи»
    await new Promise((r) => setTimeout(r, 200));
    expect(back.connected).toBe(true); // no landing-page redirect: the idle back-channel is alive
    expect(mgr.engine.readyState).toBe('open');
    // the first tab still works
    const n = a.ev.filter(([e]) => e === 'ai.message').length;
    a.sock.emit('ai.turn.text', { text: 'Привет' });
    await a.until(() => a.ev.filter(([e]) => e === 'ai.message').length >= n + 2);
    back.close();
    a.sock.close();
  });

  it('AI_REQUIRE_HOST_TOKEN=1: only a live pool token of that instance starts a session', async () => {
    process.env.AI_REQUIRE_HOST_TOKEN = '1';
    try {
      const a = connect({ instanceUuid: 'inst-s', username: 'sam' });
      expect((await a.until(([e]) => e === 'ai.error'))[1].code).toBe('BAD_SESSION');
      const b = connect({ instanceUuid: 'inst-s', username: 'sam', hostToken: 'tok-B' });
      expect((await b.until(([e]) => e === 'ai.error'))[1].code).toBe('BAD_SESSION');
      const c = connect({ instanceUuid: 'inst-s', username: 'sam', hostToken: 'tok-A' });
      await c.until(([e]) => e === 'ai.session.ready');
      for (const x of [a, b, c]) x.sock.close();
    } finally {
      delete process.env.AI_REQUIRE_HOST_TOKEN;
    }
  });

  it('visitor turns are rate-limited per session', async () => {
    const a = connect({ instanceUuid: 'inst-r', username: 'rita' });
    await a.until(([e]) => e === 'ai.session.ready');
    for (let i = 0; i < 3; i++) a.sock.emit('ai.turn.text', { text: `Привет ${i}` });
    const err = await a.until(([e, p]) => e === 'ai.error' && p.code === 'RATE_LIMITED');
    expect(err[1].message).toMatch(/подождите/);
    a.sock.close();
  });
});

describe('QA-059: malformed incoming /ai payloads', () => {
  it('wrong types, missing fields, oversize and unknown events -> ai.error BAD_PAYLOAD in Russian; nothing crashes or hangs', async () => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-p', username: 'pavel' }, reconnection: false });
    const ev: [string, any][] = [];
    sock.onAny((e, p) => ev.push([e, p]));
    await new Promise<void>((r) => sock.on('ai.session.ready', () => r()));
    await new Promise((r) => setTimeout(r, 200));
    const bad = () => ev.filter(([e, p]) => e === 'ai.error' && p.code === 'BAD_PAYLOAD').length;
    const cases: [string, any][] = [
      ['ai.turn.text', { text: 42 }],
      ['ai.turn.text', {}],
      ['ai.turn.text', 'Привет'],
      ['ai.turn.text', { text: 'а'.repeat(1001) }],
      ['ai.card.tap', { cardId: 5 }],
      ['ai.render.request', { preset: 'top' }],
      ['ai.command.status', { id: 'x', state: 'done' }],
      ['ai.ue.event', { type: 'event', event: 'nope' }],
      ['ai.command.result', 'garbage'],
      ['ai.session.start', { instanceUuid: 1 }],
      ['ai.hack', { a: 1 }],
    ];
    for (const [e, p] of cases) sock.emit(e, p);
    const t0 = Date.now();
    while (bad() < cases.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(bad()).toBe(cases.length);
    expect(ev.find(([e, p]) => e === 'ai.error' && p.code === 'BAD_PAYLOAD')![1].message).toMatch(/Некорректный запрос/);
    expect(ev.some(([e, p]) => e === 'ai.message' && p.role === 'visitor')).toBe(false); // no malformed turn ran
    // the session still works afterwards
    sock.emit('ai.turn.text', { text: 'Привет' });
    const t1 = Date.now();
    while (!ev.some(([e, p]) => e === 'ai.message' && p.role === 'consultant' && p.turnId === 't-1') && Date.now() - t1 < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(ev.some(([e, p]) => e === 'ai.message' && p.role === 'consultant' && p.turnId === 't-1')).toBe(true);
    sock.close();
  });

  it('a malformed result for a pending command never hangs the turn: it is delivered normalised', async () => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-q', username: 'quinn' }, reconnection: false });
    const ev: [string, any][] = [];
    sock.onAny((e, p) => ev.push([e, p]));
    // the "page" answers every backend command with a malformed result (no type/state_rev, ok as a string)
    sock.on('ai.command', ({ request }: any) => sock.emit('ai.command.result', { id: request.id, ok: 'yes' }));
    await new Promise<void>((r) => sock.on('ai.session.ready', () => r()));
    sock.emit('ai.ue.event', { type: 'event', event: 'planner_mode', data: { inPlanner: true, view: '3D' } }); // v2.0: in «Конструктор»
    const t0 = Date.now();
    sock.emit('ai.turn.text', { text: 'Ванная 2 на 2,5 метра' });
    while (!ev.some(([e, p]) => e === 'ai.message' && p.role === 'consultant' && p.turnId === 't-1') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - t0).toBeLessThan(5000); // not the 38 s command deadline
    expect(ev.find(([e, p]) => e === 'ai.message' && p.role === 'consultant' && p.turnId === 't-1')![1].text).toMatch(/Не получилось построить комнату/);
    sock.close();
  });
});

describe('QA-060 POST /d/:shortId/visit', () => {
  it('404 unknown, 400 without consent, 200 with consent (Russian confirmation), then rate-limited', async () => {
    fs.writeFileSync(path.join(mod.dossier.dir, 'index.json'), JSON.stringify([{ dossierId: 'd-' + 'c'.repeat(32), shortId: 'VisitShort12', sessionId: 's', username: 'vika', saveId: 's1', renderIds: [], createdAt: new Date().toISOString(), total: 1, sets: [], hasFlags: false, lead: true }]));
    fs.writeFileSync(path.join(mod.dossier.dir, 'd-' + 'c'.repeat(32) + '.pdf'), '%PDF-1.4');
    const post = (id: string, body: any) => fetch(`${url}/d/${id}/visit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('NoSuchShort1', { consent: true })).status).toBe(404);
    const noConsent = await post('VisitShort12', {});
    expect(noConsent.status).toBe(400);
    expect((await noConsent.json()).message).toMatch(/Отметьте согласие/);
    const ok = await post('VisitShort12', { consent: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).message).toBe('Заявка на визит отправлена — салон свяжется с вами по этому проекту.');
    expect((await post('VisitShort12', { consent: true })).status).toBe(200); // idempotent
    expect((await post('VisitShort12', { consent: true })).status).toBe(429); // limit 4 per 10 min here
  });
});

describe('orchestrator backlog', () => {
  it('at most 3 queued turns while busy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-'));
    const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
    const errs: any[] = [];
    const s = new AiSession('i:q', 'i', 'q', new DirectChannel(new FakeUe(f.catalog)), { emit: (e, p) => e === 'ai.error' && errs.push(p) }, 'constructor');
    s.busy = true;
    for (let i = 0; i < 5; i++) await o.handleTurn(s, `t${i}`);
    expect(s.queue.length).toBe(3);
    expect(errs.map((e) => e.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
  });
});

describe('rate-limit helpers', () => {
  it('sliding window', () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a'), l.take('b')]).toEqual([true, true, false, true]);
    t = 1001;
    expect(l.take('a')).toBe(true);
  });
  it('client address: X-Forwarded-For only from a private peer (nginx), last entry', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '172.18.0.3' } } as any)).toBe('1.2.3.4');
    expect(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '8.8.8.8' } } as any)).toBe('8.8.8.8');
  });
});
