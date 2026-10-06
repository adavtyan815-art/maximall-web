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
import { socketEventValidator, validator, commandArgsValidator } from './helpers/contracts';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { MockStreamingStt } from '../src/ai/providers/streamingStt';
import { FakeUe } from '../src/ai/sim/fakeUe';

/**
 * PHASE 2 (contracts v2.0/v2.1): the full two-mode golden path over Socket.io with a fake page and the v2.0 fake UE.
 * Salon: greeting, booth focus -> «эту коллекцию или другие», options, size, «верни как было», another collection,
 * info cards, «Показать в комнате» -> consent offer, a non-answer, a fit question -> offer -> «да» -> Constructor with
 * the booth's configuration carried, room built and the set placed, back to the salon.
 */
const f = fixtureIndex();
const reqV = validator('maximall/ai/envelope.schema.json#/$defs/request');
const resV = validator('maximall/ai/envelope.schema.json#/$defs/result');
const S2C = ['ai.session.ready', 'ai.message', 'ai.thinking', 'ai.cards', 'ai.command', 'ai.say', 'ai.basket', 'ai.error', 'ai.mode', 'ai.offer'];
const ROOM = ['build_room', 'add_opening', 'check_fit', 'apply_config', 'configure_set', 'swap_set', 'remove_set', 'finish_surface', 'undo', 'reset', 'save_project', 'capture'];

let server: http.Server;
let url: string;
let mod: AiModule;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twomode-'));

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
    arDir: path.join(tmp, 'ar'),
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
  const schemaErrors: string[] = [];
  const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-2m', username }, reconnection: false });
  for (const ev of S2C) {
    const v = socketEventValidator('x-server-to-client', ev);
    sock.on(ev, (p: any) => {
      events.push([ev, p]);
      if (!v(p)) schemaErrors.push(`${ev}: ${JSON.stringify(v.errors)}`);
    });
  }
  sock.on('ai.command', ({ request }: any) => {
    if (!reqV(request)) schemaErrors.push(`request ${request.cmd}: ${JSON.stringify(reqV.errors)}`);
    const av = commandArgsValidator(request.cmd);
    if (!av(request.args)) schemaErrors.push(`args ${request.cmd}: ${JSON.stringify(av.errors)}`);
    const result = ue.execute(request);
    if (!resV(result)) schemaErrors.push(`result ${request.cmd}: ${JSON.stringify(resV.errors)}`);
    sock.emit('ai.command.result', result);
    for (const e of ue.drainEvents()) sock.emit('ai.ue.event', e);
  });
  const until = async (pred: (e: [string, any]) => boolean, from = 0, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for event');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** a visitor turn: resolves on the consultant's message for it */
  const turn = async (text: string) => {
    const from = events.length;
    sock.emit('ai.turn.text', { text });
    await until(([e, p]) => e === 'ai.message' && p.role === 'consultant', from);
    await new Promise((r) => setTimeout(r, 30));
    return events.slice(from);
  };
  /** a button under an offer: resolves on the next consultant message */
  const answer = async (offerId: string, optionId: string) => {
    const from = events.length;
    sock.emit('ai.offer.answer', { offerId, optionId });
    await until(([e, p]) => e === 'ai.message' && p.role === 'consultant', from);
    await new Promise((r) => setTimeout(r, 30));
    return events.slice(from);
  };
  const ueEvent = (e: any) => sock.emit('ai.ue.event', e);
  return { ue, events, schemaErrors, sock, until, turn, answer, ueEvent };
}

const msg = (evs: [string, any][]) => evs.filter(([e, p]) => e === 'ai.message' && p.role === 'consultant').map(([, p]) => p.text).join(' ');
const offerOf = (evs: [string, any][], kind: string) => evs.find(([e, p]) => e === 'ai.offer' && p.kind === kind)?.[1];

describe('PHASE 2 two-mode golden path (Socket.io, fake page, fake UE v2.0)', () => {
  it('salon booth dialogue -> consent -> Constructor with the booth carried -> back to the salon', async () => {
    const pg = page('anna2m');
    const ready = await pg.until(([e]) => e === 'ai.session.ready');
    expect(ready[1].greeting).toMatch(/стенд/);
    expect((await pg.until(([e]) => e === 'ai.mode'))[1]).toMatchObject({ mode: 'showroom', reason: 'start' });
    const greet = await pg.until(([e]) => e === 'ai.say');
    expect(greet[1].audioUrl).toMatch(/\/api\/ai\/clips\/[a-f0-9]{16}\.wav$/); // browser audio, no consultant_say

    // booth focus -> «Обсудим эту коллекцию — Milu — или посмотрим другие?»
    let from = pg.events.length;
    pg.ueEvent(pg.ue.focusEvent('Booth_Milu_1'));
    const scope = (await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'booth_scope', from))[1];
    expect(scope.text).toBe('Обсудим эту коллекцию (Milu) или посмотрим другие?');
    expect(scope.options.map((o: any) => o.id)).toEqual(['this', 'other']);

    // «Эту коллекцию» -> this booth's options (booth_get), real prices
    let evs = await pg.answer(scope.offerId, 'this');
    expect(msg(evs)).toMatch(/^Milu: размеры 80 см — от \d+ BYN; 100 см — от \d+ BYN/);
    expect(pg.ue.log.some((l) => l.cmd === 'booth_get')).toBe(true);

    // size, then «верни как было»
    evs = await pg.turn('Сделай 100 см');
    expect(msg(evs)).toMatch(/Поменяла размер на 100 см/);
    expect(pg.ue.booths.find((b) => b.boothId === 'Booth_Milu_1')!.config.sizeIndex).toBe(1);
    evs = await pg.turn('Верни как было');
    expect(msg(evs)).toMatch(/Вернула стенд как было/);
    expect(pg.ue.booths.find((b) => b.boothId === 'Booth_Milu_1')!.config.sizeIndex).toBe(0);

    // another booth -> «Другие» -> collection pick (no Tuma) -> Avenu on the booth
    from = pg.events.length;
    pg.ueEvent(pg.ue.focusEvent('Booth_Urban_1'));
    await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'booth_scope' && /Urban/.test(p.text), from);
    evs = await pg.turn('Другие');
    const pick = offerOf(evs, 'collection_pick');
    expect(pick.text).toBe('Какую коллекцию поставить вместо Urban?');
    expect(pick.options.map((o: any) => o.id).sort()).toEqual(['Avenu', 'Milu', 'Terra']);
    evs = await pg.answer(pick.offerId, 'Avenu');
    expect(msg(evs)).toMatch(/Поставила на стенд Avenu/);
    expect(pg.ue.booths.find((b) => b.boothId === 'Booth_Urban_1')!.productId).toBe('Avenu');

    // info cards in the salon (no placement, no fit check)
    evs = await pg.turn('Покажи варианты до 3500 BYN');
    const cards = evs.find(([e]) => e === 'ai.cards')![1].cards;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((k: any) => Object.keys(k.placement).length === 0)).toBe(true);

    // «Показать в комнате» -> consent offer for that card (never entered directly); a non-answer is a no
    from = pg.events.length;
    pg.sock.emit('ai.card.show', { cardId: cards[0].cardId });
    const cardOffer = (await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'constructor', from))[1];
    expect(cardOffer.text).toContain(cards[0].title);
    expect(pg.ue.log.some((l) => l.cmd === 'enter_constructor')).toBe(false);
    evs = await pg.turn('Может быть');
    expect(pg.ue.log.some((l) => l.cmd === 'enter_constructor')).toBe(false);

    // a fit question about the booth in focus -> ONE offer; «да» in the very next turn -> Constructor, booth carried
    evs = await pg.turn('А влезет ли эта тумба в мою ванную?');
    const fitOffer = offerOf(evs, 'constructor');
    expect(fitOffer.text).toBe('Могу показать эту модель в реальных размерах в комнате нашего Конструктора. Перейдём?'); // a specific model (the booth in focus)
    expect(fitOffer.options).toEqual([
      { id: 'yes', label: 'Да, перейти' },
      { id: 'no', label: 'Нет, остаться' },
    ]);
    expect(pg.ue.log.filter((l) => ROOM.includes(l.cmd))).toEqual([]); // never a room command in the salon
    evs = await pg.turn('Да');
    const enter = pg.ue.log.find((l) => l.cmd === 'enter_constructor')!;
    expect(enter.args.carryConfig.productId).toBe('Avenu'); // the focused booth's configuration
    expect(evs.find(([e]) => e === 'ai.mode')![1]).toMatchObject({ mode: 'constructor', reason: 'consent' });
    expect(msg(evs)).toMatch(/Перешли в Конструктор.*поставлю Avenu/);

    // room -> the carried set is placed (CR-UE-03: no room at entry -> the AI places it after build_room)
    evs = await pg.turn('Ванная 2 на 2,5 метра');
    expect(msg(evs)).toMatch(/Построила комнату 200 на 250 см\. Поставила Avenu/);
    expect(pg.ue.sets.map((s) => s.config.productId)).toEqual(['Avenu']);
    const basket = [...pg.events].reverse().find(([e]) => e === 'ai.basket')![1];
    expect(basket.items).toHaveLength(1);

    // back to the salon
    evs = await pg.turn('Вернись в салон');
    expect(evs.find(([e]) => e === 'ai.mode')![1]).toMatchObject({ mode: 'showroom', reason: 'exit' });
    expect(pg.ue.inPlanner).toBe(false);

    expect(pg.ue.log.some((l) => l.cmd === 'consultant_say' || l.cmd === 'consultant_summon')).toBe(false);
    expect(pg.ue.log.filter((l) => !l.ok).map((l) => l.cmd)).toEqual([]); // UE never refused (no NOT_IN_PLANNER)
    expect(pg.schemaErrors).toEqual([]);
    pg.sock.close();
  }, 30000);

  it('a button «Да, перейти» moves; «Нет, остаться» stays; the same topic is not offered again', async () => {
    const pg = page('boris2m');
    await pg.until(([e]) => e === 'ai.mode');
    let from = pg.events.length;
    pg.ueEvent(pg.ue.focusEvent('Booth_Terra_1'));
    await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'booth_scope', from);
    let evs = await pg.turn('Какие размеры у этой тумбы?');
    const o1 = offerOf(evs, 'constructor');
    evs = await pg.answer(o1.offerId, 'no');
    expect(msg(evs)).toMatch(/остаёмся в салоне/);
    evs = await pg.turn('А по ширине она подойдёт?');
    expect(offerOf(evs, 'constructor')).toBeUndefined(); // no nagging on the same topic
    // QA pointer 2: a late «Да, перейти» on the first offer (after «нет» and a topic change) is still consent in the salon
    evs = await pg.answer(o1.offerId, 'yes');
    expect(evs.find(([e]) => e === 'ai.mode')![1]).toMatchObject({ mode: 'constructor', reason: 'consent' });
    expect(pg.ue.log.filter((l) => l.cmd === 'enter_constructor')).toHaveLength(1);
    // tapping it again in the Constructor answers clearly and does not enter twice
    evs = await pg.answer(o1.offerId, 'yes');
    expect(msg(evs)).toBe('Мы уже в Конструкторе.');
    expect(pg.ue.log.filter((l) => l.cmd === 'enter_constructor')).toHaveLength(1);
    // HUD exit (UE planner_mode) -> showroom
    from = pg.events.length;
    pg.ueEvent({ type: 'event', event: 'planner_mode', data: { inPlanner: false, view: null } });
    expect((await pg.until(([e]) => e === 'ai.mode', from))[1]).toMatchObject({ mode: 'showroom', reason: 'hud' });
    expect(pg.schemaErrors).toEqual([]);
    pg.sock.close();
  }, 30000);

  it('another collection at any time while a booth is in focus; a named one switches directly (WEB finding)', async () => {
    const pg = page('vera2m');
    await pg.until(([e]) => e === 'ai.mode');
    const from = pg.events.length;
    pg.ueEvent(pg.ue.focusEvent('Booth_Milu_1'));
    const scope = (await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'booth_scope', from))[1];
    await pg.answer(scope.offerId, 'this');
    await pg.turn('Сделай 100 см');
    let evs = await pg.turn('Посмотрим другие коллекции');
    const pick = offerOf(evs, 'collection_pick');
    expect(pick.text).toBe('Какую коллекцию поставить вместо Milu?');
    evs = await pg.turn('Поставьте сюда Urban'); // a named collection: no question, switched at once
    expect(offerOf(evs, 'collection_pick')).toBeUndefined();
    expect(msg(evs)).toMatch(/Поставила на стенд Urban/);
    expect(pg.ue.booths.find((b) => b.boothId === 'Booth_Milu_1')!.productId).toBe('Urban');
    evs = await pg.turn('Покажи другие коллекции'); // the salon chip
    expect(offerOf(evs, 'collection_pick').text).toBe('Какую коллекцию поставить вместо Urban?');
    pg.ueEvent({ type: 'event', event: 'booth_focus', data: { boothId: '' } }); // no booth in focus -> the catalogue list
    await new Promise((r) => setTimeout(r, 100));
    evs = await pg.turn('Покажи другие коллекции');
    expect(offerOf(evs, 'collection_pick')).toBeUndefined();
    expect(evs.some(([e]) => e === 'ai.cards')).toBe(true);
    expect(pg.schemaErrors).toEqual([]);
    pg.sock.close();
  }, 30000);

  it('QA-080: with a salon booth in focus, fit questions never change the booth; one offer, then facts + a hint', async () => {
    for (const decline of ['button', 'Нет', 'Может быть', 'Не знаю']) {
      const pg = page('fit-' + decline.length);
      await pg.until(([e]) => e === 'ai.mode');
      const from = pg.events.length;
      pg.ueEvent(pg.ue.focusEvent('Booth_Milu_1'));
      await pg.until(([e, p]) => e === 'ai.offer' && p.kind === 'booth_scope', from);
      const before = JSON.stringify(pg.ue.booths.find((b) => b.boothId === 'Booth_Milu_1'));
      let evs = await pg.turn('Хочу понять, поместится ли тумба 100 см в мою ванную 1,7 на 1,5 метра');
      const offer = offerOf(evs, 'constructor');
      expect(offer, decline).toBeDefined();
      expect(msg(evs)).toMatch(/Milu 100 занимает по ширине 100 см.*стена 170 см — по ширине комплект помещается/);
      if (decline === 'button') await pg.answer(offer.offerId, 'no');
      else await pg.turn(decline);
      const afterOffer = pg.events.length;
      for (const q of ['А 80 см поместится?', 'А если комната 2 на 2?', 'Какая глубина у Milu?']) {
        evs = await pg.turn(q);
        expect(msg(evs), q).toMatch(/(занимает по ширине|глубина)/);
        expect(msg(evs), q).toMatch(/Проверить точно можно в Конструкторе — скажите, если захотите./);
      }
      expect(pg.events.slice(afterOffer).filter(([e, p]) => e === 'ai.offer' && p.kind === 'constructor'), decline).toEqual([]);
      expect(pg.ue.log.filter((l) => l.cmd === 'booth_configure' || l.cmd === 'enter_constructor'), decline).toEqual([]);
      expect(JSON.stringify(pg.ue.booths.find((b) => b.boothId === 'Booth_Milu_1')), decline).toBe(before); // the shared booth is untouched
      // an explicit change still works
      evs = await pg.turn('Сделайте 100 см');
      expect(msg(evs)).toMatch(/Поменяла размер на 100 см/);
      expect(pg.schemaErrors).toEqual([]);
      pg.sock.close();
    }
  }, 60000);
});
