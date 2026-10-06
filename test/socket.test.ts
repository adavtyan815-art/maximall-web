import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as ioc, Socket } from 'socket.io-client';
import { AddressInfo } from 'net';
import { fixtureIndex } from './helpers/catalog';
import { socketEventValidator, validator, commandArgsValidator, expectValid } from './helpers/contracts';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { MockStreamingStt } from '../src/ai/providers/streamingStt';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { syntheticCapture } from './helpers/capture';
import { closeBrowser } from '../src/ai/dossier/service';

const f = fixtureIndex();
const reqV = validator('maximall/ai/envelope.schema.json#/$defs/request');
const resV = validator('maximall/ai/envelope.schema.json#/$defs/result');
const S2C = ['ai.session.ready', 'ai.message', 'ai.thinking', 'ai.transcript', 'ai.cards', 'ai.command', 'ai.say', 'ai.basket', 'ai.render', 'ai.dossier', 'ai.error', 'ai.command.wait', 'ai.mode', 'ai.offer'];

let server: http.Server;
let url: string;
let mod: AiModule;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aisock-'));

beforeAll(async () => {
  const app = express();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_BASE_URL = url;
  const ledger = new CostLedger({ file: path.join(tmp, 'spend.jsonl') });
  mod = createAiModule({
    catalog: f.catalog,
    logDir: path.join(tmp, 'logs'),
    clips: new ClipStore(path.join(tmp, 'clips')),
    renderDir: path.join(tmp, 'renders'),
    savesDir: path.join(tmp, 'saves'),
    dossierDir: path.join(tmp, 'dossiers'),
    providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), sttStream: new MockStreamingStt(), tts: new MockTts(), ledger, mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} },
  });
  app.use(mod.router);
  mod.attach(new SocketServer(server, { cors: { origin: true } }));
});
afterAll(async () => {
  await closeBrowser();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A fake player page: forwards ai.command to a simulated UE and answers with ai.command.result. */
/** saveAs = the login UE stores saves under (UE game login), which may differ from the page identity (QA-035). */
/** queueMs: the page holds every backend command that long (stream not ready): ai.command.status queued -> sent -> result (QA-044). */
/** inPlanner (default true, the v1 tests): the player is already in «Конструктор»; UE reports it with planner_mode. */
function fakePage(username: string, saveAs = username, opts: { queueMs?: number; inPlanner?: boolean } = {}) {
  const ue = new FakeUe(f.catalog, { inPlanner: opts.inPlanner ?? true });
  const events: [string, any][] = [];
  const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-1', username } });
  const schemaErrors: string[] = [];
  for (const ev of S2C) {
    const v = socketEventValidator('x-server-to-client', ev);
    sock.on(ev, (p: any) => {
      events.push([ev, p]);
      if (!v(p)) schemaErrors.push(`${ev}: ${JSON.stringify(v.errors)}`);
    });
  }
  const handle = (request: any) => {
    if (!reqV(request)) schemaErrors.push(`request ${request.cmd}: ${JSON.stringify(reqV.errors)}`);
    const av = commandArgsValidator(request.cmd);
    if (!av(request.args)) schemaErrors.push(`args ${request.cmd}: ${JSON.stringify(av.errors)}`);
    let result = ue.execute(request);
    if (request.cmd === 'save_project' && result.ok) {
      // What UE does on save_project: POST /api/saves with boothStates (+ plannerInstanceId) and the metrics block.
      fs.mkdirSync(path.join(tmp, 'saves'), { recursive: true });
      const saveId = 'save-' + request.id;
      const record = { saveId, saveName: 'Ванная', date: '2026-09-30', metrics: { plannerInstanceId: 'p-' + username, sets: ue.sets.map((x) => ({ setId: x.setId, config: x.config })), layoutJson: JSON.stringify({ version: 3, nodes: [], walls: [] }) } };
      fs.writeFileSync(path.join(tmp, 'saves', saveAs + '.json'), JSON.stringify([record]));
      result = { ...result, result: { saveId, username: saveAs } };
    }
    if (!resV(result)) schemaErrors.push(`result ${request.cmd}: ${JSON.stringify(resV.errors)}`);
    sock.emit('ai.command.result', result);
    // v2.0: UE events caused by the command (planner_mode on enter/exit) reach the backend through the page
    for (const e of ue.drainEvents()) sock.emit('ai.ue.event', e);
  };
  // v2.0: UE tells the page whether the player is in «Конструктор» (HUD); the v1 tests start there.
  sock.on('ai.session.ready', () => {
    if (ue.inPlanner) sock.emit('ai.ue.event', { type: 'event', event: 'planner_mode', data: { inPlanner: true, view: '3D' }, state_rev: ue.rev });
  });
  sock.on('ai.command', ({ request }: any) => {
    if (!opts.queueMs) return handle(request);
    sock.emit('ai.command.status', { id: request.id, state: 'queued' });
    setTimeout(() => {
      sock.emit('ai.command.status', { id: request.id, state: 'sent' });
      handle(request);
    }, opts.queueMs);
  });
  const waitFor = (pred: (e: [string, any]) => boolean, ms = 5000) =>
    new Promise<[string, any]>((resolve, reject) => {
      const start = events.length;
      const t0 = Date.now();
      const tick = () => {
        const hit = events.slice(start).find(pred) ?? events.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for event'));
        setTimeout(tick, 10);
      };
      tick();
    });
  /** Wait until the consultant has answered the n-th turn (ai.thinking off). */
  const turn = async (text: string) => {
    const before = events.filter(([e, p]) => e === 'ai.thinking' && p.on === false).length;
    sock.emit('ai.turn.text', { text });
    const t0 = Date.now();
    while (events.filter(([e, p]) => e === 'ai.thinking' && p.on === false).length <= before) {
      if (Date.now() - t0 > 8000) throw new Error(`turn timeout: ${text}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 30));
  };
  return { sock, ue, events, schemaErrors, waitFor, turn };
}

describe('Socket.io /ai end-to-end with a fake page and simulated UE (mock providers)', () => {
  it('runs the golden path; every event and command matches the contracts', async () => {
    const page = fakePage('anna');
    const ready = await page.waitFor(([e]) => e === 'ai.session.ready');
    expect(ready[1]).toMatchObject({ sessionId: 'inst-1:anna', consultantName: 'Ольга' });
    expect(ready[1].mock.llm).toBe(true);
    await page.waitFor(([e]) => e === 'ai.say'); // greeting

    await page.turn('У меня ванная 2,5 на 2 метра, есть дверь');
    expect(page.ue.walls).toHaveLength(4);
    await page.turn('Покажи варианты до 6000 BYN');
    const cardsEv = page.events.filter(([e]) => e === 'ai.cards').pop()!;
    const cards = cardsEv[1].cards;
    expect(cards.length).toBe(3);

    // Card tap: the page applies it directly in UE, then tells the backend.
    const tapReq = { type: 'MaxiMallAI', id: 'r-1700000000000-1', cmd: 'apply_config', args: { config: cards[0].config, placement: cards[0].placement, cardId: cards[0].cardId }, origin: 'card_tap' };
    expectValid(reqV, tapReq);
    const tapRes = page.ue.execute(tapReq);
    expect(tapRes.ok).toBe(true);
    const nSay = page.events.filter(([e]) => e === 'ai.say').length;
    page.sock.emit('ai.card.tap', { cardId: cards[0].cardId, requestId: tapReq.id, result: tapRes });
    await page.waitFor(([e, p]) => e === 'ai.basket' && p.items.length === 1);
    while (page.events.filter(([e]) => e === 'ai.say').length <= nSay) await new Promise((r) => setTimeout(r, 10));
    const lastSay = page.events.filter(([e]) => e === 'ai.say').pop()![1];
    expect(lastSay.text).toContain(cards[0].title);

    await page.turn('Добавь навесной шкаф');
    await page.turn('Покрась стены в бежевый');
    expect(page.ue.finishes.all_walls.code).toBe('RAL 1013');

    // Voice turn: push-to-talk audio -> STT (mock) -> transcript -> turn
    const before = page.events.filter(([e, p]) => e === 'ai.thinking' && p.on === false).length;
    page.sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    page.sock.emit('ai.audio.chunk', Buffer.from('MOCKTEXT:Сделай фото'));
    page.sock.emit('ai.audio.end', {});
    await page.waitFor(([e, p]) => e === 'ai.transcript' && p.final === true && p.text === 'Сделай фото');
    expect(page.events.some(([e, p]) => e === 'ai.transcript' && p.final === false)).toBe(true); // streaming partial
    while (page.events.filter(([e, p]) => e === 'ai.thinking' && p.on === false).length <= before) await new Promise((r) => setTimeout(r, 10));
    await page.waitFor(([e, p]) => e === 'ai.render' && p.stage === 'capturing');

    await page.turn('Отправь мне всё');
    await page.waitFor(([e, p]) => e === 'ai.dossier' && p.stage === 'building');

    // Guardrail phrase: no tool call, policy answer
    const cmdsBefore = page.ue.log.length;
    await page.turn('А скидку сделаете?');
    expect(page.ue.log.slice(cmdsBefore).every((l) => l.cmd === 'consultant_say')).toBe(true);

    // The basket equals the catalogue quote of what is in the room.
    const basket = page.events.filter(([e]) => e === 'ai.basket').pop()![1];
    const quoteTotal = page.ue.sets.reduce((a, s) => a + f.catalog.quote(s.config).total, 0);
    expect(basket.total).toBe(quoteTotal);

    // v2.0: the clip is a browser-playable WAV (ai.say.audioUrl), no consultant_say to UE.
    const audioUrl: string = page.events.filter(([e]) => e === 'ai.say').pop()![1].audioUrl;
    const res = await fetch(audioUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.readUInt32LE(24)).toBe(24000);
    expect(buf.length).toBeGreaterThan(24000);
    expect(page.ue.log.some((l) => l.cmd === 'consultant_say' || l.cmd === 'consultant_summon')).toBe(false);

    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });

  it('keeps sessions separate per username on the same instance and reports health', async () => {
    const a = fakePage('visitor-a');
    const b = fakePage('visitor-b');
    await a.waitFor(([e]) => e === 'ai.session.ready');
    await b.waitFor(([e]) => e === 'ai.session.ready');
    await a.turn('Комната 3 на 2 метра');
    expect(a.ue.walls).toHaveLength(4);
    expect(b.ue.walls).toHaveLength(0);
    expect(b.events.some(([e, p]) => e === 'ai.message' && p.role === 'visitor')).toBe(false);
    const h = await (await fetch(`${url}/api/ai/health`)).json();
    expect(h.mock.llm).toBe(true);
    expect(h.catalog.mappings).toBe(f.index.mappings.length);
    a.sock.close();
    b.sock.close();
  });

  it('times out a command the page never answers (TIMEOUT) without hanging the turn', async () => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-2', username: 'silent' } });
    const says: string[] = [];
    sock.on('ai.say', (p: any) => says.push(p.text));
    await new Promise((r) => sock.on('ai.session.ready', r));
    const s = mod.namespace!.sessionFor('inst-2:silent')!;
    // shrink the timeout for this test by sending a command directly through the channel
    const res = await s.channel.send({ type: 'MaxiMallAI', id: 'r-1-99', cmd: 'get_state', args: {} }, 100);
    expect(res.reasonCode).toBe('TIMEOUT');
    sock.close();
  });

  it('photo: take_photo -> UE capture -> POST /api/render (multipart) -> ai.render preview and final on the visitor socket', async () => {
    const page = fakePage('photo-user');
    await page.waitFor(([e]) => e === 'ai.session.ready');
    await page.turn('Комната 2 на 2 метра');
    await page.turn('Сделай фото');
    const cap = page.events.find(([e, p]) => e === 'ai.render' && p.stage === 'capturing')![1];
    const c = await syntheticCapture();
    const form = new FormData();
    for (const k of ['beauty', 'depth', 'mask', 'maskDepth'] as const) form.append(k, new Blob([new Uint8Array((c as any)[k])], { type: 'image/png' }), k + '.png');
    form.append('meta', new Blob([JSON.stringify({ renderId: cap.renderId, sessionId: 'inst-1:photo-user', width: 64, height: 48, preset: 'corner' })], { type: 'application/json' }), 'meta.json');
    const res = await fetch(url + '/api/render', { method: 'POST', body: form });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ renderId: cap.renderId, status: 'accepted' });
    const fin = await page.waitFor(([e, p]) => e === 'ai.render' && p.stage === 'final' && p.renderId === cap.renderId);
    expect(page.events.some(([e, p]) => e === 'ai.render' && p.stage === 'preview' && p.renderId === cap.renderId)).toBe(true);
    page.sock.emit('ai.ue.event', { type: 'event', event: 'capture_progress', data: { renderId: cap.renderId } }); // live UE also reports progress
    await new Promise((r) => setTimeout(r, 100));
    expect(page.events.filter(([e, p]) => e === 'ai.render' && p.stage === 'capturing' && p.renderId === cap.renderId)).toHaveLength(1); // QA-017
    const img = await fetch(fin[1].url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const bad = new FormData();
    bad.append('meta', JSON.stringify({ renderId: 'x', sessionId: 's', width: 1, height: 1 }));
    expect((await fetch(url + '/api/render', { method: 'POST', body: bad })).status).toBe(400);
    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });

  it('«отправь мне всё»: save_project -> dossier PDF -> ai.dossier ready with pdf, short link and QR', async () => {
    const page = fakePage('dossier-user');
    await page.waitFor(([e]) => e === 'ai.session.ready');
    await page.turn('Ванная 2,5 на 2 метра');
    await page.turn('Покажи варианты до 6000 BYN');
    await page.turn('Давай первый вариант');
    expect(page.ue.sets).toHaveLength(1);
    await page.turn('Отправь мне всё');
    const ready = await page.waitFor(([e, p]) => e === 'ai.dossier' && p.stage === 'ready', 30000);
    expect(ready[1].pdfUrl).toMatch(/\/api\/dossier\/d-[a-z0-9-]+\.pdf$/);
    const pdf = await fetch(ready[1].pdfUrl);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    const short = await fetch(ready[1].shortUrl);
    expect(short.status).toBe(200);
    expect(await short.text()).toContain('Скачать PDF');
    expect((await fetch(ready[1].qrPngUrl)).headers.get('content-type')).toBe('image/png');
    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });

  it("CR-WEB-01: a guest session merges into the named session when the page learns the login; basket lines carry price flags", async () => {
    const page = fakePage("guest-dev42");
    await page.waitFor(([e]) => e === "ai.session.ready");
    await page.turn("Ванная 2 на 2,5 метра");
    await page.turn("Покажи варианты до 6000 BYN");
    await page.turn("Давай первый вариант");
    expect(page.ue.sets).toHaveLength(1);
    expect(mod.namespace!.sessionFor("inst-1:guest-dev42")).toBeTruthy();
    const readyCount = page.events.filter(([e]) => e === "ai.session.ready").length;
    page.sock.emit("ai.session.start", { instanceUuid: "inst-1", username: "maria" });
    await page.waitFor(([e, p]) => e === "ai.session.ready" && p.sessionId === "inst-1:maria");
    expect(page.events.filter(([e]) => e === "ai.session.ready").length).toBe(readyCount + 1);
    expect(mod.namespace!.sessionFor("inst-1:guest-dev42")).toBeUndefined();
    const named = mod.namespace!.sessionFor("inst-1:maria")!;
    expect(named.sets.size).toBe(1);
    expect(named.stats.turns).toBeGreaterThanOrEqual(3);
    const basket = page.events.filter(([e]) => e === "ai.basket").pop()![1];
    expect(basket.items).toHaveLength(1);
    expect(basket.items[0].lines.some((l: any) => l.unpriced === true || l.estimated === true)).toBe(true);
    await page.turn("Добавь пенал");
    expect(page.events.some(([e, p]) => e === "ai.message" && p.role === "consultant" && /навесн|шкаф/.test(p.text))).toBe(true);
    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });

  it("v1.3: a named session is never merged into UE guest_tester; guest_tester stays a separate per-instance guest", async () => {
    const page = fakePage("olga-client");
    await page.waitFor(([e]) => e === "ai.session.ready");
    await page.turn("Ванная 2 на 2,5 метра");
    page.sock.emit("ai.session.start", { instanceUuid: "inst-1", username: "guest_tester" });
    await page.waitFor(([e, p]) => e === "ai.session.ready" && p.sessionId === "inst-1:guest_tester");
    const named = mod.namespace!.sessionFor("inst-1:olga-client")!;
    expect(named).toBeTruthy();
    expect(named.stats.turns).toBe(1);
    expect(mod.namespace!.sessionFor("inst-1:guest_tester")!.stats.turns).toBe(0);
    page.sock.close();
  });

  it("QA-035: the dossier uses saveId + username from the save_project result (UE login guest_tester), no lead for the guest", async () => {
    const page = fakePage("qa_gp_live", "guest_tester");
    await page.waitFor(([e]) => e === "ai.session.ready");
    await page.turn("Ванная 2,4 на 3 метра, бюджет 4000 BYN");
    await page.turn("Давай первый вариант");
    await page.turn("Отправить мне всё");
    const ready = await page.waitFor(([e, p]) => e === "ai.dossier" && (p.stage === "ready" || p.stage === "failed"), 30000);
    expect(ready[1].stage).toBe("ready");
    const leadsFile = path.join(tmp, "dossiers", "leads.jsonl");
    const leads = fs.existsSync(leadsFile) ? fs.readFileSync(leadsFile, "utf8") : "";
    expect(leads).not.toContain("guest_tester");
    page.sock.close();
  });

  it("CR-WEB-03: staff session view (transcript + basket + total) and «Написать от имени консультанта»", async () => {
    const page = fakePage("staff-view-user");
    await page.waitFor(([e]) => e === "ai.session.ready");
    await page.turn("Ванная 2 на 2,5 метра");
    await page.turn("Покажи варианты до 6000 BYN");
    await page.turn("Давай первый вариант");
    const v = await (await fetch(url + "/api/admin/ai/session/" + encodeURIComponent("inst-1:staff-view-user"))).json();
    expect(v.sessionId).toBe("inst-1:staff-view-user");
    expect(v.transcript.some((t: any) => t.role === "visitor" && /2 на 2,5/.test(t.text))).toBe(true);
    expect(v.transcript.some((t: any) => t.role === "consultant")).toBe(true);
    expect(v.basket.items).toHaveLength(1);
    expect(v.total).toBe(v.basket.total);
    const r = await fetch(url + "/api/admin/ai/session/" + encodeURIComponent("inst-1:staff-view-user") + "/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Я менеджер салона, подойду к вам через минуту." }) });
    expect(r.status).toBe(200);
    await page.waitFor(([e, p]) => e === "ai.message" && p.role === "consultant" && /менеджер салона/.test(p.text));
    await page.waitFor(([e, p]) => e === "ai.say" && /менеджер салона/.test(p.text) && /\.wav$/.test(p.audioUrl));
    expect((await fetch(url + "/api/admin/ai/session/nope")).status).toBe(404);
    page.sock.close();
  });
});

describe('QA-044: thinking indicator vs. waiting for the room', () => {
  /** The UI's indicator state after the events so far: thinking on/off per turn, and the open ai.command.wait ids. */
  const indicator = (events: [string, any][]) => {
    let thinking = false;
    const waits = new Set<string>();
    for (const [e, p] of events) {
      if (e === 'ai.thinking') thinking = !!p.on;
      if (e === 'ai.command.wait') p.on ? waits.add(p.id) : waits.delete(p.id);
    }
    return { thinking, waits: [...waits] };
  };
  it('a command waiting for the stream: a separate status that clears on sent; «думает» never sticks', async () => {
    const page = fakePage('qa44', 'qa44', { queueMs: 300 });
    await page.waitFor(([e]) => e === 'ai.message'); // greeting text delivered (v2.0: no command for speech)
    await page.waitFor(([e, p]) => e === 'ai.mode' && p.mode === 'constructor');
    page.sock.emit('ai.turn.text', { text: 'Покажи варианты' }); // propose_sets -> check_fit (queued)
    page.sock.emit('ai.turn.text', { text: 'Сделай фото' }); // capture (queued)
    const on = await page.waitFor(([e, p]) => e === 'ai.command.wait' && p.on === true);
    expect(on[1]).toMatchObject({ text: 'Подключаюсь к 3D-комнате…' });
    expect(['check_fit', 'capture']).toContain(on[1].cmd);
    // the old bug: a turnless ai.thinking on:true «Жду соединения с комнатой» that nothing switched off
    expect(page.events.some(([e, p]) => e === 'ai.thinking' && p.on === true && !p.turnId)).toBe(false);
    const off = await page.waitFor(([e, p]) => e === 'ai.command.wait' && p.on === false && p.id === on[1].id);
    expect(off[1].reason).toBe('sent');

    // A turn while the stream is slow: thinking stops with the reply, every wait status is cleared afterwards.
    await page.turn('Ванная 2 на 2,5 метра');
    await new Promise((r) => setTimeout(r, 900));
    const msgAt = page.events.findIndex(([e, p]) => e === 'ai.message' && p.role === 'consultant' && p.turnId === 't-3');
    const offAt = page.events.findIndex(([e, p]) => e === 'ai.thinking' && p.on === false && p.turnId === 't-3');
    expect(offAt).toBeGreaterThanOrEqual(0);
    expect(offAt).toBeLessThan(msgAt);
    await new Promise((r) => setTimeout(r, 700));
    expect(indicator(page.events)).toEqual({ thinking: false, waits: [] });
    expect(page.events.filter(([e]) => e === 'ai.thinking').every(([, p]) => typeof p.turnId === 'string')).toBe(true);
    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });
});

describe('QA-050: page buttons under PLANNER_BUSY', () => {
  it('«Досье» / «Фото» buttons get the consultant answer and no failed card', async () => {
    const page = fakePage('qa50');
    await page.waitFor(([e]) => e === 'ai.say'); // greeting
    page.ue.otherOwner = true;
    await page.turn('Ванная 3 на 3 метра'); // PLANNER_BUSY
    const n = page.events.filter(([e]) => e === 'ai.say').length;
    page.sock.emit('ai.dossier.request', {});
    page.sock.emit('ai.render.request', { preset: 'corner' });
    const t0 = Date.now();
    while (page.events.filter(([e]) => e === 'ai.say').length < n + 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    const says = page.events.filter(([e]) => e === 'ai.say').slice(n).map(([, p]) => p.text);
    expect(says).toHaveLength(2);
    for (const x of says) expect(x).toMatch(/фото и досье сделаю, когда он освободится/);
    expect(page.events.filter(([e]) => e === 'ai.dossier' || e === 'ai.render')).toEqual([]);
    expect(page.ue.log.some((l) => l.cmd === 'save_project' || l.cmd === 'capture')).toBe(false);
    expect(page.schemaErrors).toEqual([]);
    page.sock.close();
  });
});
