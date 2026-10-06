import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as ioc, Socket } from 'socket.io-client';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { fixtureIndex } from './helpers/catalog';
import { socketEventValidator } from './helpers/contracts';
import { syntheticCapture } from './helpers/capture';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore, TtsProvider } from '../src/ai/providers/voice';
import { ElevenLabsRealtimeStt, MockStreamingStt } from '../src/ai/providers/streamingStt';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/ai/providers/llm';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { guardReply } from '../src/ai/orchestrator/guardrails';
import { spokenSummary, speechLength, estimateSpokenSeconds, SPOKEN_MAX_CHARS, SPOKEN_POINTER_RU } from '../src/ai/orchestrator/speech';
import { isBoothPhotoRequest } from '../src/ai/orchestrator/modes';
import { checkMeta, RenderService, RenderEvent } from '../src/ai/render/service';
import type { RenderProvider } from '../src/ai/render/providers';
import { DossierService } from '../src/ai/dossier/service';
import { PHRASES } from '../src/ai/harness/phrases';
import { runHarness } from '../src/ai/harness/run';

const f = fixtureIndex();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-'));

/** The two longest replies of the paid test 2026-10-01 (28 s and 54 s of audio when read out whole). */
const PAID_LONG_1 =
  'Здравствуйте! Стенд сейчас переключить не получилось: рядом с вами не открыт ни один стенд. Зато я могу рассказать о коллекции по каталогу. Milu выпускается в цвете «Орех». Тумба бывает шириной 80 см, цена от 3230 BYN, и шириной 100 см, цена от 3547 BYN. Навесной шкаф к ней есть. Подобрать для вас комплект или рассказать про другую коллекцию?';
const PAID_LONG_2 =
  'Я считаю в белорусских рублях (BYN). В пределах 4000 BYN есть три светлых варианта:\n1. Avenu 80, дуб: 2985 BYN, размер 80×50×40 см. 2. Urban 80, бежевый: 2040 BYN (цена уточняется), размер 80×46×40 см. 3. Urban 80, белый: 2040 BYN (цена уточняется), размер 80×46×40 см. Если хотите, подскажу, как они смотрятся на стенде.';

describe('P3-05 spoken summary (ai.say.spokenText)', () => {
  it('long replies with lists and prices become a 5–10 s summary; lists, sizes and several prices stay in the chat', () => {
    for (const t of [PAID_LONG_1, PAID_LONG_2]) {
      const s = spokenSummary(t).text;
      expect(speechLength(s), s).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
      expect(estimateSpokenSeconds(s)).toBeLessThanOrEqual(10);
      expect(s).not.toMatch(/\d\)|×|BYN|«|\(/);
    }
    expect(spokenSummary(PAID_LONG_1).text).toMatch(/^Здравствуйте! Стенд сейчас переключить не получилось/);
    expect(spokenSummary(PAID_LONG_2).text).toBe(`Я считаю в белорусских рублях. В пределах 4000 рублей есть три светлых варианта. ${SPOKEN_POINTER_RU}`);
  });

  it('a numbered list keeps only its lead-in; the closing question is spoken; short replies stay whole', () => {
    const t = 'Подобрала 3 варианта: 1) Milu 100, орех — 3588 BYN; 2) Urban 100, серый — 3127 BYN; 3) Milu 80, орех — 3963 BYN. Какой поставить?';
    expect(spokenSummary(t).text).toBe(`Подобрала 3 варианта. ${SPOKEN_POINTER_RU} Какой поставить?`);
    expect(spokenSummary('Вернула как было.').text).toBe('Вернула как было.');
    // a sentence that does not fit whole keeps its first clause (never cut inside an enumeration)
    expect(spokenSummary('Здравствуйте! Я Ольга, консультант Oliveeka. Расскажу о коллекциях и настрою любой стенд салона под вас — размер, цвет, навесной шкаф, покраска по RAL/NCS.').text).toBe(
      'Здравствуйте! Я Ольга, консультант Oliveeka. Расскажу о коллекциях и настрою любой стенд салона под вас.',
    );
    expect(spokenSummary('Построила комнату 200 на 300 см.').text).toBe('Построила комнату 200 на 300 см.');
  });

  it('one short price is said in words of the currency (agreement), several prices are not', () => {
    expect(spokenSummary('Поставила Avenu 80, дуб — 3718 BYN.').text).toBe('Поставила Avenu 80, дуб — 3718 рублей.');
    expect(spokenSummary('Сейчас на стенде Terra 70, орех, 2043 BYN.').text).toBe('Сейчас на стенде Terra 70, орех, 2043 рубля.');
    expect(spokenSummary('Скажите бюджет в BYN.').text).toBe('Скажите бюджет в рублях.');
    expect(spokenSummary('Urban: 80 — от 2040 BYN, 100 — от 2239 BYN.').text).not.toMatch(/\d/);
  });

  it('an over-long sentence is cut at a clause boundary, never before «что …»', () => {
    const t = 'Сроки, доставку, монтаж и условия гарантии уточните, пожалуйста, у менеджера салона — не хочу обещать то, что не могу гарантировать, и придумывать ничего не буду, честно.';
    const s = spokenSummary(t).text;
    expect(s).toBe('Сроки, доставку, монтаж и условия гарантии уточните, пожалуйста, у менеджера салона.');
    const t2 = 'Сроки и монтаж уточните у менеджера, я не хочу обещать то, что не могу гарантировать, поэтому придумывать даты не буду совсем.';
    expect(spokenSummary(t2).text).not.toMatch(/обещать то\.$/);
    expect(speechLength(s)).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
  });

  it('QA-094: list and question on one line, action confirmation, estimated prices (real Sonnet replies 2026-10-01)', () => {
    // budget-02: the numbered list and the closing question share one line
    const b2 =
      'Я подобрала три комплекта до 4000 BYN:\n1. Milu 100, орех, со столешницей: 3588 BYN. 2. Urban 100, серый, с раковиной: 3127 BYN. Это самый доступный вариант. 3. Milu 80, орех, с раковиной: 3963 BYN. Какой поставить?';
    expect(spokenSummary(b2).text).toBe(`Я подобрала три комплекта до 4000 рублей. ${SPOKEN_POINTER_RU} Какой поставить?`);
    // finish-04: the action is confirmed (sizes are not spoken)
    expect(spokenSummary('Положила на пол серый керамогранит 60×60. Сделать фото комнаты?').text).toBe('Положила на пол серый керамогранит. Подробности — на экране. Сделать фото комнаты?');
    // pick-03: a long confirmation keeps its head
    expect(spokenSummary('Поставила в комнату третий вариант: Avenu 80, дуб, с раковиной и навесным шкафом, 4976 BYN. Могу сделать цвет светлее, поменять отделку стен и пола или снять фото. Что выберете?').text).toMatch(
      /^Поставила в комнату третий вариант\..*Что выберете\?$/,
    );
    // sr-colour: an estimated price is said as «ориентировочно»
    expect(spokenSummary('Поменяла цвет на белый. Сейчас на стенде Urban 80, белый, 2040 BYN (цена уточняется).').text).toBe('Поменяла цвет на белый. Сейчас на стенде Urban 80, белый, ориентировочно 2040 рублей.');
    // room-02: the last question does not fit -> an earlier one; pick-01: the question gives up its tail
    expect(spokenSummary('Комнату 180 на 220 см с дверью я построила. Какой у вас примерно бюджет? И какой стиль вам ближе: светлый, тёмный или под дерево?').text).toBe(
      'Комнату 180 на 220 см с дверью я построила. Какой у вас примерно бюджет?',
    );
    expect(spokenSummary('Поставила в комнату Avenu 80 в дубе с раковиной. Она стоит 3718 BYN. Хотите добавить навесной шкаф, сделать отделку светлее или сделать фото?').text).toBe(
      'Поставила в комнату Avenu 80 в дубе с раковиной. Хотите добавить навесной шкаф?',
    );
  });

  it('the offer «… Конструктора. Перейдём?» stays together when it fits', () => {
    const t = 'По ширине помещается. Габариты: 100×46×85 см. Могу показать эту модель в реальных размерах в комнате нашего Конструктора. Перейдём?';
    expect(spokenSummary(t).text).toMatch(/Могу показать эту модель .* Конструктора\. Перейдём\?$/);
  });

  it('the orchestrator speaks only spokenText (TTS input), the chat keeps the full text, both pass the guard', async () => {
    const said: string[] = [];
    const tts: TtsProvider = { name: 'spy', mock: true, audioFormat: 'pcm_24000', synthesize: async (x: string) => (said.push(x), new MockTts().synthesize(x)) };
    const reply = `${PAID_LONG_2} Скидку 20% дам прямо сейчас. Доставим через 3 дня.`;
    const llm: LlmProvider = { name: 'fake', model: 'fake', mock: true, create: async (_r: LlmRequest): Promise<LlmResponse> => ({ content: [{ type: 'text', text: reply }], stopReason: 'end_turn', model: 'fake' }) };
    const o = new Orchestrator({ catalog: f.catalog, llm, fallbackLlm: new MockLlm(), stt: new MockStt(), tts, clips: new ClipStore(path.join(tmp, 'c1')), logDir: path.join(tmp, 'l1') });
    const ev: [string, any][] = [];
    const s = new AiSession('i:sp', 'i', 'sp', new DirectChannel(new FakeUe(f.catalog, { inPlanner: false })), { emit: (e, p) => ev.push([e, p]) });
    for (const a of [2985, 2040, 4000]) s.seenAmounts.add(a);
    await o.handleTurn(s, 'Что есть светлое до 4000?');
    const say = ev.filter(([e]) => e === 'ai.say').pop()![1];
    expect(say.text).toContain('1. Avenu 80, дуб: 2985 BYN');
    expect(say.text).not.toMatch(/Скидку|Доставим/); // the guard on the full text
    expect(say.spokenText).toBe(`Я считаю в белорусских рублях. В пределах 4000 рублей есть три светлых варианта. ${SPOKEN_POINTER_RU}`);
    expect(said).toEqual([say.spokenText]);
    expect(guardReply(say.spokenText, [...s.seenAmounts]).violations).toEqual([]);
    expect(guardReply(say.text, [...s.seenAmounts]).violations).toEqual([]);
    expect(socketEventValidator('x-server-to-client', 'ai.say')(say)).toBe(true);
  });

  it('spokenFor never says a figure or a promise the full text does not hold', () => {
    const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(tmp, 'c2')), logDir: path.join(tmp, 'l2') });
    expect(o.spokenFor('Скидка 15% на всё.')).toBe('Всё написала в чате на экране.');
    expect(o.spokenFor('Поставила Milu 80 — 3230 BYN.')).toBe('Поставила Milu 80 — 3230 рублей.');
  });

  it('all 112 harness phrases: spoken ≤ 10 s (13 chars/s), subset of the guarded chat text', async () => {
    const r = await runHarness(f.catalog, new MockLlm(), PHRASES);
    expect(r.passed).toBe(r.total);
    for (const x of r.results) {
      expect(estimateSpokenSeconds(x.spoken), `${x.id}: ${x.spoken}`).toBeLessThanOrEqual(10);
      expect(x.spoken.length, x.id).toBeGreaterThan(0);
      const allowed = [...x.reply.matchAll(/(\d[\d\s ]*(?:[.,]\d+)?)\s*BYN/g)].map((m) => Number(m[1].replace(/\s/g, '').replace(',', '.')));
      expect(guardReply(x.spoken, allowed).violations, x.id).toEqual([]);
    }
  });
});

describe('P3-02 showroom photo = the clean UE capture of a booth', () => {
  const mk = (llm: LlmProvider = new MockLlm()) => new Orchestrator({ catalog: f.catalog, llm, fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(tmp, 'c3')), logDir: path.join(tmp, 'l3') });
  const salon = () => {
    const ue = new FakeUe(f.catalog, { inPlanner: false });
    const ev: [string, any][] = [];
    const s = new AiSession(`i:bp-${Math.random()}`, 'i', 'bp', new DirectChannel(ue), { emit: (e, p) => ev.push([e, p]) });
    s.greeted = true;
    const last = (e: string) => ev.filter(([x]) => x === e).pop()?.[1];
    return { ue, ev, s, last };
  };

  it('phrases', () => {
    for (const t of ['Сфотографируй', 'Сделай фото', 'Сделай снимок этого стенда', 'Сфотографируй стенд Urban', 'Можно рендер?']) expect(isBoothPhotoRequest(t), t).toBe(true);
    for (const t of ['Сделай фото комнаты', 'Пришли мне всё', 'Сфотографируй мою ванную', 'Фото в конструкторе', 'Покажи варианты']) expect(isBoothPhotoRequest(t), t).toBe(false);
  });

  it('booth in focus: capture {preset:"booth", boothId} is sent in the salon, the renderId is issued, no room command, no offer', async () => {
    const o = mk();
    const { ue, ev, s, last } = salon();
    await o.onUeEvent(s, ue.focusEvent('Booth_Milu_1'));
    await o.handleTurn(s, 'Сфотографируй этот стенд');
    const cap = ue.log.filter((l) => l.cmd === 'capture');
    expect(cap).toHaveLength(1);
    expect(cap[0].args).toMatchObject({ preset: 'booth', boothId: 'Booth_Milu_1' });
    expect(cap[0].ok).toBe(true);
    expect(s.pendingRenders.has(cap[0].args.renderId)).toBe(true);
    expect(s.renders).toContain(cap[0].args.renderId);
    expect(ev.some(([e, p]) => e === 'ai.render' && p.stage === 'capturing' && p.renderId === cap[0].args.renderId)).toBe(true);
    expect(last('ai.say').text).toMatch(/^Фотографирую стенд Milu/);
    expect(ev.filter(([e, p]) => e === 'ai.offer' && p.kind === 'constructor')).toHaveLength(0);
    expect(s.mode).toBe('showroom');
    expect(ue.log.some((l) => !l.ok)).toBe(false);
  });

  it('a named booth the visitor has been at is photographed; an unknown one gets an honest answer; none -> offer', async () => {
    const o = mk();
    const { ue, ev, s, last } = salon();
    await o.onUeEvent(s, ue.focusEvent('Booth_Urban_1'));
    await o.onUeEvent(s, ue.focusEvent('Booth_Milu_1'));
    await o.handleTurn(s, 'Сфотографируй стенд Urban');
    expect(ue.log.filter((l) => l.cmd === 'capture').map((l) => l.args.boothId)).toEqual(['Booth_Urban_1']);
    await o.handleTurn(s, 'Сделай снимок Terra');
    expect(ue.log.filter((l) => l.cmd === 'capture')).toHaveLength(1);
    expect(last('ai.say').text).toMatch(/Стенд Terra сейчас не рядом/);
    // no booth in focus at all: honest + the Constructor offer, nothing sent
    const b = salon();
    await o.handleTurn(b.s, 'Сделай фото');
    expect(b.ue.log).toEqual([]);
    expect(b.last('ai.say').text).toMatch(/стенд салона.*Перейдём в Конструктор\?$/);
    expect(b.last('ai.offer')).toMatchObject({ kind: 'constructor' });
    void ev;
  });

  it('the model path (take_photo tool in the salon) and the page button (ai.render.request) use the same flow', async () => {
    const llm: LlmProvider = {
      name: 'fake',
      model: 'fake',
      mock: true,
      create: async (r: LlmRequest): Promise<LlmResponse> => {
        expect(r.tools.some((t) => t.name === 'take_photo')).toBe(true);
        const last = r.messages[r.messages.length - 1];
        const res = Array.isArray(last.content) ? (last.content as any[]).find((x) => x.type === 'tool_result') : undefined;
        if (res) return { content: [{ type: 'text', text: JSON.parse(res.content).say }], stopReason: 'end_turn', model: 'fake' };
        return { content: [{ type: 'tool_use', id: 'tu1', name: 'take_photo', input: {} }], stopReason: 'tool_use', model: 'fake' };
      },
    };
    const o = mk(llm);
    const { ue, s, last } = salon();
    await o.onUeEvent(s, ue.focusEvent('Booth_Avenu_1'));
    await o.handleTurn(s, 'А можно на память этот вид?');
    expect(ue.log.filter((l) => l.cmd === 'capture').map((l) => l.args)).toMatchObject([{ preset: 'booth', boothId: 'Booth_Avenu_1' }]);
    expect(last('ai.say').text).toMatch(/Фотографирую стенд Avenu/);
    const out = await o.runTool(s, 'take_photo', { preset: 'corner' }, 'ui', 'ui-1');
    expect(out).toMatchObject({ ok: true, boothId: 'Booth_Avenu_1' });
  });

  it('a busy planner never holds a booth photo; in the Constructor the photo stays the room photo', async () => {
    const o = mk();
    const { ue, s } = salon();
    await o.onUeEvent(s, ue.focusEvent('Booth_Milu_1'));
    s.plannerBusy = true;
    await o.runTool(s, 'take_photo', {}, 'model', 't-9');
    expect(ue.log.map((l) => l.cmd)).toEqual(['capture']);
    const ue2 = new FakeUe(f.catalog, { inPlanner: true, widthCm: 200, depthCm: 250 });
    const s2 = new AiSession('i:bp-cr', 'i', 'bp', new DirectChannel(ue2), { emit: () => undefined }, 'constructor');
    await o.runTool(s2, 'take_photo', { preset: 'booth' }, 'model', 't-1');
    expect(ue2.log.filter((l) => l.cmd === 'capture').map((l) => l.args.preset)).toEqual(['corner']);
    // FakeUe (like UE): preset booth inside the planner -> BAD_ARGS, unknown booth -> NO_BOOTH
    expect(ue2.execute({ type: 'MaxiMallAI', id: 'x', cmd: 'capture', args: { renderId: 'r1', preset: 'booth', boothId: 'Booth_Milu_1' }, sessionId: 's', origin: 'model' } as any)).toMatchObject({ ok: false, reasonCode: 'BAD_ARGS' });
    expect(ue.execute({ type: 'MaxiMallAI', id: 'y', cmd: 'capture', args: { renderId: 'r2', preset: 'booth', boothId: 'Nope' }, sessionId: 's', origin: 'model' } as any)).toMatchObject({ ok: false, reasonCode: 'NO_BOOTH' });
  });

  it('render service: preset booth -> final = the beauty image, source capture, no provider call (even a paid one)', async () => {
    let calls = 0;
    const paid: RenderProvider = { name: 'fal', mock: false, preview: async () => (calls++, Buffer.alloc(0)), final: async () => (calls++, Buffer.alloc(0)), estimateUsd: () => 0.12 } as any;
    const events: RenderEvent[] = [];
    const svc = new RenderService(paid, paid, (_s, e) => events.push(e), path.join(tmp, 'renders-svc'), () => 'http://x');
    const c = await syntheticCapture();
    expect(checkMeta({ renderId: 'rn-b1', sessionId: 's', width: 64, height: 48, preset: 'booth', boothId: 'Booth_Milu_1' })).toBeNull();
    expect(checkMeta({ renderId: 'rn-b1', sessionId: 's', width: 64, height: 48, preset: 'booth', boothId: '../x' })).toMatch(/boothId/);
    await svc.accept({ renderId: 'rn-b1', sessionId: 's', width: 64, height: 48, preset: 'booth', boothId: 'Booth_Milu_1' }, c);
    expect(calls).toBe(0);
    expect(events).toEqual([{ renderId: 'rn-b1', stage: 'final', url: 'http://x/api/render/rn-b1/beauty.png', beautyUrl: 'http://x/api/render/rn-b1/beauty.png', source: 'capture' }]);
    expect(socketEventValidator('x-server-to-client', 'ai.render')(events[0])).toBe(true);
    expect(svc.filePath('rn-b1', 'beauty')).toBeTruthy();
    // the dossier lists it among the photos, captioned as a booth photo
    const d = new DossierService(() => f.catalog, path.join(tmp, 'saves-x'), svc.dir, () => 'http://x', path.join(tmp, 'dossiers-x'));
    expect((d as any).images(['rn-b1'], {})).toMatchObject([{ caption: 'Фото стенда в салоне (кадр из 3D)' }]);
  });
});

// ── Socket.io end to end: booth photo upload and the P3-04 STT timing log ─────────────────────────────────────────────
let server: http.Server;
let url: string;
let mod: AiModule;
beforeAll(async () => {
  const app = express();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_BASE_URL = url;
  mod = createAiModule({
    catalog: f.catalog,
    logDir: path.join(tmp, 'logs'),
    clips: new ClipStore(path.join(tmp, 'clips')),
    renderDir: path.join(tmp, 'renders'),
    savesDir: path.join(tmp, 'saves'),
    dossierDir: path.join(tmp, 'dossiers'),
    providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), sttStream: new MockStreamingStt(), tts: new MockTts(), ledger: new CostLedger({ file: path.join(tmp, 'spend.jsonl') }), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} } as any,
  });
  app.use(mod.router);
  mod.attach(new SocketServer(server));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function page(username: string) {
  const ue = new FakeUe(f.catalog, { inPlanner: false });
  const events: [string, any][] = [];
  const errors: string[] = [];
  const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-p3', username }, reconnection: false });
  for (const ev of ['ai.session.ready', 'ai.say', 'ai.render', 'ai.transcript', 'ai.offer', 'ai.thinking', 'ai.error']) {
    const v = socketEventValidator('x-server-to-client', ev);
    sock.on(ev, (p: any) => {
      events.push([ev, p]);
      if (!v(p)) errors.push(`${ev}: ${JSON.stringify(v.errors)}`);
    });
  }
  sock.on('ai.command', ({ request }: any) => sock.emit('ai.command.result', ue.execute(request)));
  const waitFor = async (pred: (e: [string, any]) => boolean, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ue, events, errors, sock, waitFor };
}
const logOf = (sid: string) =>
  fs
    .readFileSync(path.join(tmp, 'logs', `${sid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('P3-02 / P3-04 over Socket.io', () => {
  it('booth photo: «Сделай фото» at a booth -> capture booth -> POST /api/render (meta preset booth) -> ai.render final = beauty, source capture', async () => {
    const p = page('booth-photo');
    await p.waitFor(([e]) => e === 'ai.session.ready');
    p.sock.emit('ai.ue.event', p.ue.focusEvent('Booth_Urban_1'));
    await p.waitFor(([e, x]) => e === 'ai.offer' && x.kind === 'booth_scope');
    p.sock.emit('ai.turn.text', { text: 'Сфотографируй стенд' });
    const cap = (await p.waitFor(([e, x]) => e === 'ai.render' && x.stage === 'capturing'))[1];
    const c = await syntheticCapture();
    const form = new FormData();
    for (const k of ['beauty', 'depth', 'mask'] as const) form.append(k, new Blob([new Uint8Array((c as any)[k])], { type: 'image/png' }), k + '.png');
    form.append('meta', new Blob([JSON.stringify({ renderId: cap.renderId, sessionId: 'inst-p3:booth-photo', width: 64, height: 48, preset: 'booth', boothId: 'Booth_Urban_1' })], { type: 'application/json' }), 'meta.json');
    const res = await fetch(url + '/api/render', { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const fin = (await p.waitFor(([e, x]) => e === 'ai.render' && x.stage === 'final'))[1];
    expect(fin).toMatchObject({ renderId: cap.renderId, source: 'capture', url: `${url}/api/render/${cap.renderId}/beauty.png`, beautyUrl: `${url}/api/render/${cap.renderId}/beauty.png` });
    expect(p.events.some(([e, x]) => e === 'ai.render' && x.stage === 'preview')).toBe(false);
    const img = await fetch(fin.url);
    expect(Buffer.from(await img.arrayBuffer()).equals(c.beauty)).toBe(true);
    expect(p.ue.log.filter((l) => l.cmd === 'capture').map((l) => l.args)).toMatchObject([{ preset: 'booth', boothId: 'Booth_Urban_1' }]);
    expect(mod.namespace!.sessionFor('inst-p3:booth-photo')!.renders).toContain(cap.renderId);
    const say = p.events.filter(([e]) => e === 'ai.say').pop()![1];
    expect(say.spokenText).toMatch(/^Фотографирую стенд Urban/);
    expect(p.errors).toEqual([]);
    p.sock.close();
  });

  it('salon photo button without a booth: honest answer + the Constructor offer, nothing sent to UE', async () => {
    const p = page('booth-photo-none');
    await p.waitFor(([e]) => e === 'ai.session.ready');
    p.sock.emit('ai.render.request', {});
    const say = (await p.waitFor(([e, x]) => e === 'ai.say' && /Сфотографировать могу/.test(x.text)))[1];
    expect(say.text).toMatch(/Перейдём в Конструктор\?$/);
    await p.waitFor(([e, x]) => e === 'ai.offer' && x.kind === 'constructor');
    expect(p.ue.log).toEqual([]);
    p.sock.close();
  });

  it('P3-04: chunks streamed while held are forwarded at once; the stt log measures from ai.audio.end and proves the streaming', async () => {
    const p = page('ptt-timing');
    await p.waitFor(([e]) => e === 'ai.session.ready');
    p.sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    const head = Buffer.from('MOCKTEXT:Сделай тумбу 100 см');
    const audio = Buffer.concat([head, Buffer.alloc(6400 * 4 - head.length, 0x20)]);
    for (let o = 0; o < audio.length; o += 6400) {
      p.sock.emit('ai.audio.chunk', audio.subarray(o, o + 6400));
      await sleep(100);
    }
    await p.waitFor(([e, x]) => e === 'ai.transcript' && x.final === false); // partials while the button is held
    p.sock.emit('ai.audio.end', {});
    p.sock.emit('ai.audio.chunk', Buffer.alloc(320)); // a late chunk (after release) is dropped and counted
    await p.waitFor(([e, x]) => e === 'ai.transcript' && x.final === true);
    await sleep(100);
    const stt = logOf('inst-p3:ptt-timing').find((x) => x.type === 'stt');
    expect(stt).toMatchObject({ streaming: true, chunks: 4, chunksAfterEnd: 1, bytes: audio.length, text: 'Сделай тумбу 100 см' });
    expect(stt.msAfterRelease).toBeLessThan(200);
    expect(stt.holdMs).toBeGreaterThanOrEqual(350);
    expect(stt.chunkSpanMs).toBeGreaterThanOrEqual(250); // streamed during the hold (≈ holdMs), not a burst at release
    expect(stt.msFromStart).toBeGreaterThanOrEqual(stt.holdMs);
    expect(stt.provider).toMatchObject({ forwardedLive: 4, heldBeforeOpen: 0 });
    p.sock.close();
  });

  it('QA-096: a chunk that arrives after the final transcript (30 ms after release) is reported in a follow-up line', async () => {
    const p = page('ptt-late');
    await p.waitFor(([e]) => e === 'ai.session.ready');
    p.sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    p.sock.emit('ai.audio.chunk', Buffer.concat([Buffer.from('MOCKTEXT:Сделай фото'), Buffer.alloc(3000, 0x20)]));
    await sleep(50);
    p.sock.emit('ai.audio.end', {});
    await p.waitFor(([e, x]) => e === 'ai.transcript' && x.final === true);
    await sleep(30);
    p.sock.emit('ai.audio.chunk', Buffer.alloc(320)); // after the stt line was written
    await sleep(2300); // grace window 2 s
    p.sock.emit('ai.audio.chunk', Buffer.alloc(320)); // after the window: not counted
    await sleep(100);
    const log = logOf('inst-p3:ptt-late');
    expect(log.find((x) => x.type === 'stt')).toMatchObject({ chunksAfterEnd: 0, lateGraceMs: 2000 });
    const late = log.filter((x) => x.type === 'stt_late_chunks');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ chunksAfterEnd: 1, notInSttLine: 1, graceMs: 2000 });
    expect(late[0].maxMsAfterEnd).toBeGreaterThanOrEqual(20);
    p.sock.close();
  });

  it('STT post-correction: the final transcript, the visitor turn and the log carry the corrected text; the raw text is logged', async () => {
    const p = page('ptt-fix');
    await p.waitFor(([e]) => e === 'ai.session.ready');
    p.sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    p.sock.emit('ai.audio.chunk', Buffer.concat([Buffer.from('MOCKTEXT:Целый тумбу Милу восемьдесят сантиметров'), Buffer.alloc(3000, 0x20)]));
    await sleep(50);
    p.sock.emit('ai.audio.end', {});
    const [, tr] = await p.waitFor(([e, x]) => e === 'ai.transcript' && x.final === true);
    expect(tr.text).toBe('Сделай тумбу Milu 80 сантиметров');
    await sleep(100);
    const log = logOf('inst-p3:ptt-fix');
    expect(log.find((x) => x.type === 'stt')).toMatchObject({
      text: 'Сделай тумбу Milu 80 сантиметров',
      rawText: 'Целый тумбу Милу восемьдесят сантиметров',
      corrections: [
        { rule: 'collection', from: 'Милу', to: 'Milu' },
        { rule: 'verb', from: 'Целый', to: 'Сделай' },
        { rule: 'number', from: 'восемьдесят', to: '80' },
      ],
    });
    expect(log.find((x) => x.type === 'turn' && x.source === 'voice')?.text).toBe('Сделай тумбу Milu 80 сантиметров');
    p.sock.close();
  });
});

describe('P3-04 ElevenLabs realtime socket: buffer only until open, then forward each chunk as it comes; commit only at end', () => {
  it('chunks before open are held and sent in order on open; later ones go out immediately; stats in the log shape', async () => {
    const wss = new WebSocketServer({ port: 0, verifyClient: (_i: any, cb: (ok: boolean) => void) => setTimeout(() => cb(true), 250) });
    const got: { m: any; at: number }[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        got.push({ m, at: Date.now() });
        if (m.commit) setTimeout(() => ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'сделай тумбу' })), 30);
      });
    });
    const el = new ElevenLabsRealtimeStt(new CostLedger({ file: path.join(tmp, 'stt-ledger.jsonl') }), 'test-key', `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/speech-to-text/realtime`);
    const st = el.start({ sessionId: 'i:u', mimeType: 'audio/pcm;rate=16000', onPartial: () => undefined })!;
    for (let i = 0; i < 2; i++) st.push(Buffer.alloc(3200, i + 1)); // before open
    await sleep(400);
    expect(got.map((g) => g.m.commit)).toEqual([false, false]); // flushed on open, nothing committed yet
    const t = Date.now();
    st.push(Buffer.alloc(3200, 3));
    await sleep(80);
    expect(got).toHaveLength(3);
    expect(got[2].at - t).toBeLessThan(80); // forwarded as it arrived, not at release
    const res = await st.end();
    wss.close();
    expect(res.text).toBe('сделай тумбу');
    expect(got.map((g) => Buffer.from(g.m.audio_base_64, 'base64')[0] ?? 0)).toEqual([1, 2, 3, 0]);
    expect(got[3].m.commit).toBe(true);
    const stats = st.stats!();
    expect(stats).toMatchObject({ heldBeforeOpen: 2, forwardedLive: 1, finalBy: 'committed' });
    expect(stats.openMs!).toBeGreaterThanOrEqual(200);
    expect(stats.commitToFinalMs!).toBeLessThan(500);
  });
});
