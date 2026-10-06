import { describe, it, expect } from 'vitest';
import { fixtureIndex } from './helpers/catalog';
import { validator, expectValid } from './helpers/contracts';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { generateCandidates, rankTiers, buildCard, FitResult } from '../src/ai/orchestrator/propose';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import os from 'os';
import path from 'path';
import fs from 'fs';

const f = fixtureIndex();
const cardV = validator('maximall/ai/card.schema.json');

function fitAll(ue: FakeUe, cands: ReturnType<typeof generateCandidates>): FitResult[] {
  const r = ue.execute({ id: 'r-1-1', cmd: 'check_fit', args: { candidates: cands.map((c) => ({ key: c.key, config: c.config })) } });
  return r.result.results;
}

describe('propose_sets', () => {
  it('returns three distinct tiers, all fit-checked, within budget, priced only from the index', () => {
    const ue = new FakeUe(f.catalog, { widthCm: 250, depthCm: 200 });
    const args = { budgetBYN: 5000, style: 'light' };
    const cands = generateCandidates(f.catalog, args);
    expect(cands.length).toBeGreaterThan(3);
    expect(cands.length).toBeLessThanOrEqual(40);
    const fits = fitAll(ue, cands);
    const ranked = rankTiers(cands, fits, args);
    expect(ranked.map((r) => r.tier)).toEqual(['best_fit', 'best_value', 'premium']);
    expect(new Set(ranked.map((r) => r.cand.key)).size).toBe(3);
    for (const r of ranked) {
      expect(r.fit.fits).toBe(true);
      expect(r.cand.quote.total).toBeLessThanOrEqual(5000);
      const card = buildCard(r, args, f.index.syncedAt, `k-${r.tier}`);
      expectValid(cardV, card);
      // no invented prices: card price = index quote, item prices = index lines
      const q = f.catalog.quote(card.config);
      expect(card.price).toBe(q.total);
      expect(card.items.map((i) => i.price)).toEqual(q.lines.map((l) => l.price));
      expect(card.currency).toBe('BYN');
      expect(card.reason).toMatch(/на стене остаётся \d+ см/);
    }
    const prices = ranked.map((r) => r.cand.quote.total);
    expect(prices[1]).toBeLessThanOrEqual(Math.min(prices[0], prices[2]));
  });

  it('never proposes a configuration that failed the fit check', () => {
    const args = { budgetBYN: 99999 };
    const cands = generateCandidates(f.catalog, args);
    // Only one candidate "fits"; the rest fail.
    const fits: FitResult[] = cands.map((c, i) => (i === 5 ? { key: c.key, fits: true, placement: { segmentId: 1, side: 'left', offsetCm: 60, spareCm: 40 } } : { key: c.key, fits: false, reasonCode: 'NO_FIT' }));
    const ranked = rankTiers(cands, fits, args);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].cand.key).toBe(cands[5].key);
    const card = buildCard(ranked[0], args, f.index.syncedAt, 'k-1', true);
    expect(card.tier).toBe('single');
    expectValid(cardV, card);
  });

  it('returns no cards when nothing fits the budget (never exceeds it)', () => {
    const ue = new FakeUe(f.catalog, { widthCm: 250, depthCm: 200 });
    const args = { budgetBYN: 500 };
    const cands = generateCandidates(f.catalog, args);
    expect(rankTiers(cands, fitAll(ue, cands), args)).toHaveLength(0);
  });

  it('respects the wall: a 130 cm room with a door fits only the 80 cm sizes', () => {
    const ue = new FakeUe(f.catalog);
    ue.execute({ id: 'r-1-2', cmd: 'build_room', args: { widthCm: 130, depthCm: 130, openings: [{ kind: 'door', wallIndex: 0 }, { kind: 'door', wallIndex: 2 }] } });
    const cands = generateCandidates(f.catalog, { withCloset: false });
    const ranked = rankTiers(cands, fitAll(ue, cands), {});
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) expect(f.catalog.footprintWidthCm(r.cand.config)!).toBeLessThanOrEqual(126);
  });

  it('excludes hidden products (Tuma ShowInConstructor=false) and unknown collections', () => {
    const cands = generateCandidates(f.catalog, {}, 400);
    expect(cands.some((c) => c.config.productId === 'Tuma')).toBe(false);
    expect(generateCandidates(f.catalog, { collection: 'Milu' }).every((c) => c.config.productId === 'Milu')).toBe(true);
  });
});

describe('orchestrator golden path (mock LLM, simulated UE)', () => {
  it('builds the room, proposes, applies by voice, refines, finishes, photo and dossier; basket totals come from the index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
    const orch = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'clips')), logDir: path.join(dir, 'logs') });
    const ue = new FakeUe(f.catalog);
    const ev: [string, any][] = [];
    const s = new AiSession('i1:anna', 'i1', 'anna', new DirectChannel(ue), { emit: (e, p) => ev.push([e, p]) }, 'constructor');
    const say = async (t: string) => {
      const from = ev.length;
      await orch.handleTurn(s, t);
      return ev.slice(from);
    };
    await say('Ванная 2 на 2,5 метра, есть дверь');
    expect(ue.walls).toHaveLength(4);
    const e2 = await say('Бюджет до 5000 рублей, хочу светлое');
    const cards = e2.find(([e]) => e === 'ai.cards')![1].cards;
    expect(cards).toHaveLength(3);
    await say('Давай второй вариант');
    expect(ue.sets).toHaveLength(1);
    expect(ue.sets[0].config.productId).toBe(cards[1].config.productId);
    const e4 = await say('Добавь пенал');
    const hasCloset = f.catalog.getProduct(cards[1].config.productId)!.closetModels.length > 0;
    if (hasCloset) expect(ue.sets[0].config.closetSizeIndex).toBe(0);
    expect(e4.some(([e]) => e === 'ai.basket')).toBe(true);
    await say('Покрась стены в белый');
    expect(ue.finishes.all_walls).toEqual({ type: 'paint', system: 'RAL', code: 'RAL 9010' });
    const e6 = await say('Сделай фото');
    expect(e6.some(([e, p]) => e === 'ai.render' && p.stage === 'capturing')).toBe(true);
    const e7 = await say('Можно скидку?');
    expect(e7.filter(([e]) => e === 'ai.say')[0][1].text).toMatch(/менеджер/);
    const e8 = await say('Отправь мне всё');
    expect(e8.some(([e, p]) => e === 'ai.dossier' && p.stage === 'building')).toBe(true);
    const b = orch.basket(s);
    expect(b.total).toBe(f.catalog.quote(ue.sets[0].config).total);
    expect(b.currency).toBe('BYN');
    // v2.0: every consultant line comes with a browser clip (WAV); no consultant_say is sent to UE any more
    const says = ev.filter(([e]) => e === 'ai.say').map(([, p]) => p);
    expect(says.every((p) => /\/api\/ai\/clips\/[a-f0-9]{16}\.wav$/.test(p.audioUrl) && p.durationMs > 0)).toBe(true);
    expect(ue.log.filter((l) => l.cmd === 'consultant_say' || l.cmd === 'consultant_summon').length).toBe(0);
  });

  it('falls back to the scripted policy when the LLM times out', async () => {
    const slow = { name: 'slow', model: 'x', mock: false, create: () => new Promise<any>(() => undefined) };
    const orch = new Orchestrator({ catalog: f.catalog, llm: slow as any, fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), llmTimeoutMs: 50, logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orch-')) });
    const ue = new FakeUe(f.catalog);
    const s = new AiSession('i1:bob', 'i1', 'bob', new DirectChannel(ue), { emit: () => undefined }, 'constructor');
    await orch.handleTurn(s, 'Комната 3 на 2 метра');
    expect(ue.walls).toHaveLength(4);
    expect(s.stats.fallbacks).toBe(1);
  });
});
