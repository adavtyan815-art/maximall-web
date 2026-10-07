/**
 * Contracts v2.5 — English alongside Russian (Milestone 1, backend language core).
 * Russian stays byte-identical (the rest of the suite is the proof); these tests cover the English side and the new events.
 */
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
import { demoSave } from './helpers/save';
import { socketEventValidator } from './helpers/contracts';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm, CANNED_RU } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { MockStreamingStt } from '../src/ai/providers/streamingStt';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { AiSession, Orchestrator, systemPrompt, GREETING_SHOWROOM_RU, CONSULTANT_NAME } from '../src/ai/orchestrator/orchestrator';
import { DirectChannel, CommandChannel, EnvelopeRequest } from '../src/ai/orchestrator/channel';
import { closeBrowser, DossierService, VISIT_CONSENT_RU } from '../src/ai/dossier/service';
import { guardReply, moneyAmounts } from '../src/ai/orchestrator/guardrails';
import { isVerbalYes, isVerbalNo, isExitRequest, isExplicitConstructorRequest } from '../src/ai/orchestrator/modes';
import { normalizeLang, renderReason, reasonText, t, RU, EN, knownReasonCodes, knownReasonDetails } from '../src/ai/i18n';
import { articleName, colourLabel } from '../src/ai/i18n/names';
import { runHarness } from '../src/ai/harness/run';
import { PHRASES_EN } from '../src/ai/harness/phrasesEn';
import { PHRASES } from '../src/ai/harness/phrases';
import { buildReport } from '../src/ai/analytics/report';

const f = fixtureIndex();
const CYR = /[А-Яа-яЁё]/;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v25-'));

function orchSession(mode: 'showroom' | 'constructor', lang: 'ru' | 'en', channel?: CommandChannel) {
  const ue = new FakeUe(f.catalog, { inPlanner: mode === 'constructor' });
  const orch = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(tmp, 'clips')), logDir: path.join(tmp, 'logs') });
  const events: [string, any][] = [];
  const s = new AiSession(`t:${Math.random()}`, 'inst', 'u', channel ?? new DirectChannel(ue), { emit: (e, p) => events.push([e, p]) }, mode);
  s.lang = lang;
  s.greeted = true;
  const says = () => events.filter(([e]) => e === 'ai.say').map(([, p]) => p.text as string);
  return { ue, orch, s, events, says };
}

describe('v2.5 locale tables', () => {
  it('Russian constants are today\'s strings; English has every key; lang values normalise to ru/en', () => {
    expect(CONSULTANT_NAME).toBe('Ольга');
    expect(GREETING_SHOWROOM_RU).toMatch(/^Здравствуйте! Я Ольга/);
    expect(CANNED_RU.unknown).toMatch(/^Подскажите, пожалуйста, размер ванной/);
    expect(VISIT_CONSENT_RU).toBe('Согласен(на), чтобы салон связался со мной по этому проекту');
    expect(Object.keys(EN).sort()).toEqual(Object.keys(RU).sort());
    for (const k of Object.keys(EN)) {
      if (k.startsWith('note.') || k === 'dossier.htmlLang' || k === 'prompt.system') continue;
      const v = (EN as any)[k];
      const s = typeof v === 'function' ? v({ title: 'X', why: 'Y', collection: 'Milu', sizes: ['80'], names: ['white'], list: ['a'], others: [], openings: [], parts: [], variants: [], label: 'x', facts: ['a'], kind: 'door', part: 'basin', total: 1, n: 1 }) : v;
      expect(s, k).not.toMatch(CYR);
    }
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('EN')).toBe('en');
    expect(normalizeLang('de')).toBe('ru');
    expect(normalizeLang(undefined)).toBe('ru');
    expect(t('en', 'offer.yes')).toBe('Yes, open the room planner');
    expect(t('en', 'price.byn', { total: 410, estimated: true })).toBe('≈ 410 BYN (estimate)');
    expect(t('en', 'price.byn', { total: 2773 })).toBe('2,773 BYN');
  });

  it('English system prompt: «Always answer in English», same business rules, English catalogue summary', () => {
    const ru = systemPrompt(f.catalog, 'showroom', 'ru');
    const en = systemPrompt(f.catalog, 'showroom', 'en');
    expect(ru).toContain('Говори только по-русски');
    expect(en).toContain('Always answer in English');
    expect(en).toContain('Never invent prices, discounts');
    expect(en).toContain('The currency is BYN only');
    expect(en).toContain('room planner');
    expect(en).toMatch(/colours .*walnut/);
    expect(en).not.toMatch(CYR);
    expect(systemPrompt(f.catalog, 'constructor', 'en')).toContain('exit_constructor');
  });

  it('catalogue names in English: colours, articles (fallback to collection + size + colour)', () => {
    expect(colourLabel('en', 'Чёрный МДФ')).toBe('black MDF');
    expect(colourLabel('ru', 'Чёрный МДФ')).toBe('чёрный МДФ');
    expect(articleName('en', 'Смеситель для раковины Oliveeka OL-139003-CR, хром')).toBe('Basin tap Oliveeka OL-139003-CR, chrome');
    expect(articleName('en', 'Столешница Oliveeka Milu 18 мм CMA80W Белая, 2 выреза, 800х500 мм')).toBe('Worktop Oliveeka Milu 18 mm CMA80W white, 2 cut-outs, 800×500 mm');
    expect(articleName('en', 'Нечто непереводимое Urban 80', 'Urban 80, matt black')).toBe('Urban 80, matt black');
    expect(articleName('ru', 'Зеркало 79 × 57 см')).toBe('Зеркало 79 × 57 см');
    for (const m of f.index.mappings) expect(articleName('en', m.name, 'FALLBACK'), m.name).not.toMatch(CYR);
  });
});

describe('v2.5 deterministic English NLU', () => {
  it('consent words, exit, explicit room planner request (Russian lists unchanged)', () => {
    for (const y of ['Yes', 'yes please', "Sure, let's go", 'OK', 'of course', 'Yeah!']) expect(isVerbalYes(y, 'en'), y).toBe(true);
    for (const n of ['Yes, but not now', 'maybe', 'Is it big?', 'no']) expect(isVerbalYes(n, 'en'), n).toBe(false);
    expect(isVerbalYes('yes')).toBe(false); // a Russian session does not take English words
    expect(isVerbalNo('No, thanks', 'en')).toBe(true);
    expect(isVerbalNo('Not now', 'en')).toBe(true);
    expect(isExitRequest('Take me back to the showroom', 'en')).toBe(true);
    expect(isExitRequest("Don't leave the room planner", 'en')).toBe(false);
    expect(isExplicitConstructorRequest("Let's go to the room planner", 'en')).toBe(true);
    expect(isExplicitConstructorRequest('What is the room planner?', 'en')).toBe(false);
  });

  it('an English «yes» to the room planner offer enters it (preTurn), «no» stays', async () => {
    const a = orchSession('showroom', 'en');
    await a.orch.onUeEvent(a.s, a.ue.focusEvent('Booth_Milu_1'));
    await a.orch.handleTurn(a.s, 'Would this vanity unit fit in my bathroom?');
    expect(a.events.some(([e, p]) => e === 'ai.offer' && p.kind === 'constructor' && p.options[0].label === 'Yes, open the room planner')).toBe(true);
    await a.orch.handleTurn(a.s, 'Yes, please');
    expect(a.s.mode).toBe('constructor');
    expect(a.ue.log.some((l) => l.cmd === 'enter_constructor')).toBe(true);
    expect(a.says().pop()).toMatch(/^We're in the room planner/);
    const b = orchSession('showroom', 'en');
    await b.orch.onUeEvent(b.s, b.ue.focusEvent('Booth_Milu_1'));
    await b.orch.handleTurn(b.s, 'Would this vanity unit fit in my bathroom?');
    await b.orch.handleTurn(b.s, 'No, thanks');
    expect(b.s.mode).toBe('showroom');
    expect(b.says().pop()).toMatch(/stay in the showroom/);
  });
});

describe('v2.5 English guardrails', () => {
  it('drop invented amounts, discounts and dates in English; English number format is understood', () => {
    expect(guardReply('The set costs 2,773 BYN.', [2773], undefined, 'en').violations).toEqual([]);
    expect(guardReply('It costs ≈ 2,040 BYN (estimate).', [2040], undefined, 'en').violations).toEqual([]);
    const g = guardReply('The set costs 2,773 BYN. With a discount it is 2,500 BYN.', [2773], "I'll check that with the showroom manager.", 'en');
    expect(g.text).toBe('The set costs 2,773 BYN.');
    expect(g.violations).toContain('unknown_amount:2500');
    expect(guardReply('I can give you 10% off.', [], 'X', 'en')).toMatchObject({ text: 'X', violations: ['discount'] });
    expect(guardReply('We will deliver it by Friday.', [], 'X', 'en').violations).toContain('date');
    expect(guardReply('It will be ready in 3 days.', [], 'X', 'en').violations).toContain('date');
    expect(guardReply('That is $300.', [300], 'X', 'en').violations.length).toBe(1);
    expect(guardReply("I can't discuss discounts — the showroom manager decides that.", [], 'X', 'en').violations).toEqual([]);
    expect(guardReply('The preview will be ready in a few seconds.', [], 'X', 'en').violations).toEqual([]);
    expect(moneyAmounts('from 2,985 BYN and 3,279 BYN', 'en')).toEqual([2985, 3279]);
    // Russian unchanged
    expect(guardReply('Итого 3 484 BYN.', [3484]).violations).toHaveLength(0);
  });
});

describe('v2.5 §7 reason codes (UE_REASON_CODES_v2.5.md)', () => {
  const R = (reasonCode: string, reasonParams?: any, reason = 'РУССКИЙ ТЕКСТ UE') => ({ reasonCode, reason, reasonParams });
  it('renders (reasonCode, detail) + params in English; Russian keeps UE\'s reason', () => {
    expect(reasonText('en', R('NO_FIT', { detail: 'NO_FREE_SPAN', requiredCm: 160, availableCm: 120, obstacle: 'DOOR', obstacleId: 'o1', segmentId: 2, side: 'left' }))).toBe(
      'the set needs 160 cm along the wall, but the longest free stretch is 120 cm (a doorway is in the way)',
    );
    expect(reasonText('en', R('NO_FIT', { detail: 'BLOCKED_AT_POSITION', obstacle: 'WINDOW', setId: 'set-3', direction: 'right', distanceCm: 900, maxShiftCm: 103 }))).toBe(
      'a window is in the way at that spot; it can only move 103 cm',
    );
    expect(reasonText('en', R('PLANNER_BUSY', { detail: 'PLANNER_BUSY' }))).toMatch(/^another visitor is using the room planner/);
    expect(reasonText('en', R('OPENING_CONFLICT', { detail: 'OPENING_OVERLAP', kind: 'window', wallIndex: 1, openingIndex: 0 }))).toBe('Window: the opening overlaps the neighbouring opening');
    expect(reasonText('en', R('OPENING_CONFLICT', { detail: 'OPENING_BEYOND_WALL', widthCm: 120, wallLengthCm: 100, kind: 'door', segmentId: 1 }))).toBe("the opening (120 cm) doesn't fit on the wall (100 cm)");
    expect(reasonText('en', R('CATALOG_OPTION_INVALID', { detail: 'CUSTOM_COLOUR_NOT_ALLOWED', component: 'faucet', system: 'RAL', code: 'RAL 5012', target: 'booth', boothId: 'B1' }))).toBe(
      "a RAL / NCS colour can't be chosen for the tap of this display",
    );
    expect(reasonText('en', R('NO_OPENING', { detail: 'OPENING_NOT_FOUND', openingId: 'o9' }))).toBe('there is no opening "o9" in the plan');
    expect(reasonText('en', R('BAD_ARGS', { detail: 'OUT_OF_RANGE', field: 'distanceCm', value: 5000, min: 1, max: 1000 }))).toBe('distanceCm = 5000 is outside 1…1000');
    expect(reasonText('en', R('BAD_ARGS', { detail: 'UNKNOWN_FIELD', field: 'foo', where: 'envelope' }))).toBe('the command had an unknown field "foo" in the envelope');
    // PLANNER_REJECTED: no template by contract -> UE's reason
    expect(reasonText('en', R('NO_FIT', { detail: 'PLANNER_REJECTED' }, 'планировщик отказал'))).toBe('планировщик отказал');
    // unknown detail -> the reasonCode's generic English line, and the missing key is reported for the log
    expect(renderReason('en', R('NO_WALL', { detail: 'SOMETHING_NEW' }))).toEqual({ text: "there's no such wall", missing: 'NO_WALL.SOMETHING_NEW' });
    expect(renderReason('en', R('WEIRD_CODE', { detail: 'X' }))).toEqual({ text: "couldn't do that", missing: 'WEIRD_CODE.X' });
    // a result without reasonParams (older UE / the backend's own) -> the code line, else reason
    expect(reasonText('en', { reasonCode: 'TIMEOUT', reason: 'Нет ответа от комнаты' })).toBe('the room did not answer');
    // Russian: UE's own reason, unchanged; only without a reason the Russian template
    expect(reasonText('ru', R('NO_FIT', { detail: 'NO_FREE_SPAN', requiredCm: 160, availableCm: 120 }, 'Гарнитуру нужно 160 см'))).toBe('Гарнитуру нужно 160 см');
    expect(reasonText('ru', { reasonCode: 'NO_FIT', reasonParams: { detail: 'WALL_TOO_SHORT', requiredCm: 160, availableCm: 120 } })).toBe('Гарнитуру нужно 160 см вдоль стены, а стена в свету — 120 см');
    expect(reasonText('ru', { reasonCode: 'NO_FIT' }, 'NO_FIT')).toBe('NO_FIT');
    expect(knownReasonCodes()).toEqual(expect.arrayContaining(['NO_FIT', 'PLANNER_BUSY', 'NOT_IN_PLANNER', 'OPENING_CONFLICT', 'NO_SET', 'NO_WALL', 'NO_OPENING', 'BAD_ARGS', 'PAINT_NOT_ALLOWED']));
    expect(knownReasonDetails().length).toBeGreaterThanOrEqual(110);
  });

  it('a refused move_set with reasonParams is told in English (maxShiftCm), and an unknown detail is logged', async () => {
    const ue = new FakeUe(f.catalog, { inPlanner: true });
    let refuse: any = null;
    const ch: CommandChannel = {
      async send(req: EnvelopeRequest) {
        if (req.cmd === 'move_set' && refuse) return { type: 'result', id: req.id, cmd: req.cmd, ok: false, state_rev: 1, ...refuse };
        return ue.execute(req);
      },
    };
    const a = orchSession('constructor', 'en', ch);
    await a.orch.handleTurn(a.s, 'My bathroom is 2 by 2.5 metres, door on the short wall');
    await a.orch.handleTurn(a.s, 'Show me options up to 5000 BYN');
    await a.orch.handleTurn(a.s, "Let's take the first option");
    refuse = { reasonCode: 'NO_FIT', reason: 'В этом месте гарнитуру мешает окно', reasonParams: { detail: 'BLOCKED_AT_POSITION', obstacle: 'WINDOW', obstacleId: 'o1', setId: 's', direction: 'left', distanceCm: 90, maxShiftCm: 35 }, result: {} };
    await a.orch.handleTurn(a.s, 'Move the set 90 cm to the left');
    expect(a.says().pop()).toBe("90 cm won't work — an opening is in the way. I can move it by 35 cm. Shall I?");
    refuse = { reasonCode: 'NO_SET', reason: 'Гарнитура s нет в комнате', reasonParams: { detail: 'BRAND_NEW_DETAIL' }, result: {} };
    await a.orch.handleTurn(a.s, 'Move the set 20 cm to the left');
    expect(a.says().pop()).toBe("I couldn't move it: there's no such set in the room.");
    const log = fs.readFileSync(path.join(tmp, 'logs', `${a.s.sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`), 'utf8');
    expect(log).toContain('"type":"reason_key_missing","key":"NO_SET.BRAND_NEW_DETAIL"');
  });
});

describe('v2.5 English replies and ai.action (orchestrator)', () => {
  it('ai.lang applies from the NEXT turn: the reply in flight stays in the old language', async () => {
    const a = orchSession('constructor', 'ru');
    const p = a.orch.handleTurn(a.s, 'Привет');
    a.orch.setLang(a.s, 'en'); // during the turn
    await p;
    expect(a.says().pop()).toMatch(/^Здравствуйте/);
    expect(a.s.lang).toBe('en');
    await a.orch.handleTurn(a.s, 'Hello');
    expect(a.says().pop()).toMatch(/^Hello! I'm Olga/);
    // and back to Russian, history kept
    a.orch.setLang(a.s, 'ru');
    await a.orch.handleTurn(a.s, 'Привет');
    expect(a.says().pop()).toMatch(/^Здравствуйте/);
    expect(a.s.messages.length).toBeGreaterThan(4);
  });

  for (const lang of ['ru', 'en'] as const) {
    it(`ai.action undo / reset_room / other_collections / offer_answer run the chip logic (${lang})`, async () => {
      const a = orchSession('constructor', lang);
      await a.orch.handleTurn(a.s, lang === 'en' ? 'My bathroom is 2 by 2.5 metres' : 'Ванная 2 на 2,5 метра');
      await a.orch.handleTurn(a.s, lang === 'en' ? 'Show me options up to 5000 BYN' : 'Покажи варианты до 5000 BYN');
      await a.orch.handleTurn(a.s, lang === 'en' ? "Let's take the first option" : 'Давай первый вариант');
      await a.orch.handleAction(a.s, 'undo');
      expect(a.ue.log.at(-1)?.cmd === 'undo' || a.ue.log.some((l) => l.cmd === 'undo')).toBe(true);
      expect(a.says().pop()).toBe(lang === 'en' ? "I've put it back as it was." : 'Вернула как было.');
      expect(a.s.transcript.some((x) => x.text === (lang === 'en' ? 'Undo the last change' : 'Отмени последнее'))).toBe(true);
      await a.orch.handleAction(a.s, 'reset_room');
      expect(a.ue.log.some((l) => l.cmd === 'reset')).toBe(true);
      expect(a.says().pop()).toMatch(lang === 'en' ? /^Starting over/ : /^Начинаем сначала/);
      await a.orch.handleAction(a.s, 'other_collections'); // room planner: proposals
      expect(a.says().pop()).toMatch(lang === 'en' ? /room first|picked/ : /комнату|Подобрала/);

      const b = orchSession('showroom', lang);
      await b.orch.onUeEvent(b.s, b.ue.focusEvent('Booth_Milu_1'));
      await b.orch.handleAction(b.s, 'other_collections');
      const pick = b.events.filter(([e]) => e === 'ai.offer').map(([, p]) => p).pop();
      expect(pick.kind).toBe('collection_pick');
      expect(pick.text).toBe(lang === 'en' ? 'Which collection shall I put instead of Milu?' : 'Какую коллекцию поставить вместо Milu?');
      await b.orch.handleAction(b.s, 'offer_answer', 'Urban', pick.offerId);
      expect(b.ue.log.some((l) => l.cmd === 'booth_configure')).toBe(true);
      expect(b.says().pop()).toMatch(lang === 'en' ? /^I've put Urban on the display/ : /^Поставила на стенд Urban/);
      await b.orch.handleAction(b.s, 'undo'); // salon: the booth in focus
      expect(b.ue.log.some((l) => l.cmd === 'booth_undo')).toBe(true);
      // offer_answer without offerId: the open offer
      await b.orch.handleTurn(b.s, lang === 'en' ? 'Would this vanity unit fit in my bathroom?' : 'А влезет ли эта тумба в мою ванную?');
      await b.orch.handleAction(b.s, 'offer_answer', 'yes');
      expect(b.s.mode).toBe('constructor');
      const c = orchSession('showroom', lang);
      await c.orch.handleAction(c.s, 'other_collections'); // no booth in focus: the catalogue
      expect(c.says().pop()).toMatch(lang === 'en' ? /from the catalogue/ : /из каталога/);
    });
  }

  it('English cards, basket and booth texts: English names, English number format, no Russian', async () => {
    const a = orchSession('constructor', 'en');
    await a.orch.handleTurn(a.s, 'My bathroom is 2 by 2.5 metres');
    await a.orch.handleTurn(a.s, 'Show me options up to 5000 BYN');
    const cards = a.events.filter(([e]) => e === 'ai.cards').map(([, p]) => p.cards).pop();
    expect(cards.length).toBeGreaterThan(0);
    for (const k of cards) {
      expect(JSON.stringify([k.tierLabel, k.title, k.reason, k.items.map((i: any) => i.name)]), k.title).not.toMatch(CYR);
      expect(socketEventValidator('x-server-to-client', 'ai.cards')({ turnId: 't', cards: [k] })).toBe(true);
    }
    await a.orch.handleTurn(a.s, "Let's take the first option");
    const basket = a.events.filter(([e]) => e === 'ai.basket').map(([, p]) => p).pop();
    expect(JSON.stringify(basket.items)).not.toMatch(CYR);
    const st = a.events.filter(([e]) => e === 'ai.thinking' && e && (a as any)).map(([, p]) => p.step).filter(Boolean);
    expect(st.join(' ')).not.toMatch(CYR);
    for (const s of a.says()) expect(s).not.toMatch(CYR);
  });
});

describe('v2.5 dossier in English', () => {
  afterAll(async () => closeBrowser());
  it('PDF + QR page + leads in the session language; lang stored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-en-'));
    const savesDir = path.join(dir, 'saves');
    fs.mkdirSync(savesDir);
    fs.writeFileSync(path.join(savesDir, 'anna.json'), JSON.stringify([demoSave(f.catalog, { withMetrics: true }).save]));
    const svc = new DossierService(() => f.catalog, savesDir, path.join(dir, 'renders'), () => 'http://expo.local:3000', path.join(dir, 'dossiers'));
    const { response, record, spec } = await svc.build({ sessionId: 'inst-1:anna', username: 'anna', lang: 'en', conversationNotes: ['The budget you named: up to 4,000 BYN.'] });
    expect(record.lang).toBe('en');
    const html = fs.readFileSync(path.join(dir, 'dossiers', `${response.dossierId}.html`), 'utf8');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Specification');
    expect(html).toContain('Floor plan');
    expect(html).toContain(`Total: ${new Intl.NumberFormat('en-US').format(spec.total)} BYN`);
    const visible = html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');
    expect(visible.match(/.{0,60}[А-Яа-яЁё].{0,60}/s)?.[0]).toBeUndefined();
    const lead = JSON.parse(fs.readFileSync(path.join(dir, 'dossiers', 'leads.jsonl'), 'utf8').trim().split('\n')[0]);
    expect(lead).toMatchObject({ username: 'anna', dossierId: response.dossierId, lang: 'en' });
    const shortId = response.shortUrl.split('/d/')[1];
    const page = svc.shortPage(shortId)!;
    expect(page).toContain('Download PDF');
    expect(page).toContain('I agree that the showroom may contact me about this project');
    expect(page.replace('Ванная Анны', '').replace(/<[^>]+>/g, ' ')).not.toMatch(CYR); // the save name is the visitor's own text
    expect(svc.requestVisit(shortId, false)).toMatchObject({ ok: false, message: 'Please tick the consent so the showroom can contact you.' });
    expect(svc.requestVisit(shortId, true)).toMatchObject({ ok: true });
    const visit = JSON.parse(fs.readFileSync(path.join(dir, 'dossiers', 'leads.jsonl'), 'utf8').trim().split('\n')[1]);
    expect(visit).toMatchObject({ type: 'visit_request', lang: 'en', consentText: 'I agree that the showroom may contact me about this project' });
    expect(svc.langOf(shortId)).toBe('en');
    expect(svc.expiredPage('en')).toContain('This link has expired');
  });
});

describe('v2.5 analytics', () => {
  it('chosen sets come from the structured tool log (any language)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-'));
    fs.writeFileSync(
      path.join(dir, 'inst_en.jsonl'),
      [
        { ts: '2026-10-07T10:00:00Z', sid: 'inst:en', type: 'turn', turnId: 't-1', source: 'text' },
        { ts: '2026-10-07T10:00:01Z', sid: 'inst:en', type: 'tool', name: 'apply_card', ok: true, say: "I've placed Milu 80, walnut — 3,230 BYN.", title: 'Milu 80, walnut' },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    const r = buildReport(dir, {});
    expect(r.topTapped).toEqual([['Milu 80, walnut', 1]]);
  });
});

describe('v2.5 English phrase harness (mock policy)', () => {
  it('passes ~60 English phrases, and the Russian set still passes', async () => {
    expect(PHRASES_EN.length).toBeGreaterThanOrEqual(50);
    expect(new Set(PHRASES_EN.map((p) => p.id)).size).toBe(PHRASES_EN.length);
    const en = await runHarness(f.catalog, new MockLlm(), PHRASES_EN, 'en');
    expect(en.results.filter((x) => !x.pass).map((x) => `${x.id}: ${x.why.join('; ')}`)).toEqual([]);
    for (const x of en.results) expect(x.reply, x.id).not.toMatch(CYR);
    const ru = await runHarness(f.catalog, new MockLlm(), PHRASES.slice(0, 10), 'ru');
    expect(ru.passed).toBe(10);
  }, 120000);
});

// ── socket: ai.session.start lang, ai.lang, ai.action ──────────────────────
describe('v2.5 socket events', () => {
  let server: http.Server;
  let url: string;
  let mod: AiModule;
  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ledger = new CostLedger({ file: path.join(tmp, 'spend.jsonl') });
    mod = createAiModule({
      catalog: f.catalog,
      logDir: path.join(tmp, 'slogs'),
      clips: new ClipStore(path.join(tmp, 'sclips')),
      renderDir: path.join(tmp, 'renders'),
      savesDir: path.join(tmp, 'saves'),
      dossierDir: path.join(tmp, 'dossiers'),
      providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), sttStream: new MockStreamingStt(), tts: new MockTts(), ledger, mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} },
    });
    app.use(mod.router);
    mod.attach(new SocketServer(server, { cors: { origin: true } }));
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  const client = (auth: any) => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth, forceNew: true });
    const events: [string, any][] = [];
    sock.onAny((e, p) => events.push([e, p]));
    const waitFor = (pred: (e: [string, any]) => boolean, ms = 5000) =>
      new Promise<[string, any]>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = events.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > ms) return reject(new Error('timeout'));
          setTimeout(tick, 10);
        };
        tick();
      });
    return { sock, events, waitFor };
  };
  const vReady = socketEventValidator('x-server-to-client', 'ai.session.ready');
  const vChanged = socketEventValidator('x-server-to-client', 'ai.lang.changed');

  it('ai.session.start lang -> ai.session.ready {lang, greeting in it}; survives reconnect; absent = ru', async () => {
    const a = client({});
    a.sock.emit('ai.session.start', { instanceUuid: 'inst-v25', username: 'eva', lang: 'en' });
    const [, ready] = await a.waitFor(([e]) => e === 'ai.session.ready');
    expect(vReady(ready)).toBe(true);
    expect(ready).toMatchObject({ lang: 'en', consultantName: 'Olga' });
    expect(ready.greeting).toMatch(/^Hello! I'm Olga/);
    const [, greet] = await a.waitFor(([e]) => e === 'ai.say');
    expect(greet.text).toMatch(/^Hello!/);
    a.sock.disconnect();
    // reconnect / F5 without lang: the session keeps English
    const b = client({ instanceUuid: 'inst-v25', username: 'eva' });
    const [, ready2] = await b.waitFor(([e]) => e === 'ai.session.ready');
    expect(ready2.lang).toBe('en');
    b.sock.disconnect();
    const c = client({ instanceUuid: 'inst-v25', username: 'ivan' });
    const [, ready3] = await c.waitFor(([e]) => e === 'ai.session.ready');
    expect(ready3).toMatchObject({ lang: 'ru', greeting: GREETING_SHOWROOM_RU, consultantName: 'Ольга' });
    c.sock.disconnect();
  });

  it('ai.lang -> ai.lang.changed and the next reply is English; invalid payloads are refused', async () => {
    const a = client({ instanceUuid: 'inst-v25', username: 'petr' });
    await a.waitFor(([e]) => e === 'ai.session.ready');
    a.sock.emit('ai.lang', { lang: 'en' });
    const [, ch] = await a.waitFor(([e]) => e === 'ai.lang.changed');
    expect(vChanged(ch)).toBe(true);
    expect(ch).toEqual({ lang: 'en' });
    expect(mod.namespace!.sessionFor('inst-v25:petr')!.lang).toBe('en');
    a.sock.emit('ai.turn.text', { text: 'Hello' });
    await a.waitFor(([e, p]) => e === 'ai.say' && /^Hello! I'm Olga/.test(p.text));
    a.sock.emit('ai.action', { action: 'dance' });
    const [, err] = await a.waitFor(([e]) => e === 'ai.error');
    expect(err).toEqual({ code: 'BAD_PAYLOAD', message: 'Invalid request — please reload the page.' });
    a.sock.emit('ai.action', { action: 'other_collections' });
    await a.waitFor(([e, p]) => e === 'ai.say' && /from the catalogue/.test(p.text));
    a.sock.disconnect();
  });
});
