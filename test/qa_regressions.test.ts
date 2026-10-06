import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { parseTurn } from '../src/ai/orchestrator/intents';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';

const f = fixtureIndex();
const names = (t: string) => parseTurn(t).calls.map((c) => c.name);

function orch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  return new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
}

describe('QA-010 no invented article codes', () => {
  it('every mapping / price line code exists on the site, in the DataTable, or is empty («артикул уточняется»)', () => {
    const site = new Set(f.index.products.map((p) => p.articleCode));
    const dt = new Set<string>();
    for (const p of f.ue.products) {
      Object.values(p.cabinetSkus ?? {}).forEach((x) => dt.add(x.trim()));
      Object.values(p.closetSkus ?? {}).forEach((x) => dt.add(x.trim()));
    }
    for (const r of f.ue.shared) for (const c of r.colours) if (c.sku) dt.add(c.sku.trim());
    const known = (code: string) => code === '' || site.has(code) || dt.has(code) || code.split('+').every((x) => site.has(x) || dt.has(x));
    for (const m of f.index.mappings) expect(known(m.articleCode), `${m.productId} ${m.component} ${m.articleCode}`).toBe(true);
    for (const b of f.index.bundles) for (const l of b.lines) expect(known(l.articleCode), l.articleCode).toBe(true);
    expect(f.index.mappings.filter((m) => m.productId === 'Terra' && m.component === 'cabinet').map((m) => m.articleCode).sort()).toEqual(['TER70R', 'TER80R']);
  });
});

describe('QA-011 finishes only when asked', () => {
  it('«дверь на короткой стене» does not paint; «Подбери отделку стен и пол» paints walls and tiles the floor', () => {
    expect(names('Ванная 1,2 на 1,2 метра, дверь на короткой стене, бюджет 3000 BYN')).not.toContain('finish_surface');
    const c = parseTurn('Подбери отделку стен и пол').calls;
    expect(c.map((x) => x.input.target)).toEqual(['all_walls', 'floor']);
    expect(c[1].input.tileId).toMatch(/^Tile_/);
    expect(names('Хочу светлую мебель')).toEqual(['propose_sets']);
  });
  it('a floor tile is applied through finish_surface with a DT_PlannerTiles id', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    const s = new AiSession('i:qa11', 'i', 'qa11', new DirectChannel(ue), { emit: () => undefined }, 'constructor');
    await o.handleTurn(s, 'Подбери отделку стен и пол');
    expect(ue.finishes.all_walls).toMatchObject({ type: 'paint' });
    expect(ue.finishes.floor).toMatchObject({ type: 'tile', tileId: 'Tile_Grey60' });
  });
});

describe('QA-012 reset and hand-off answers', () => {
  it('«Начнём сначала» resets; delivery/warranty questions hand off to the manager', async () => {
    for (const t of ['Начнём сначала', 'С начала', 'Сбрось всё']) expect(names(t)).toEqual(['reset_room']);
    for (const t of ['Когда вы сможете доставить?', 'Какая гарантия?', 'Сколько стоит доставка и монтаж?']) expect(parseTurn(t).reply).toBe('guard_delivery');
    const o = orch();
    const ue = new FakeUe(f.catalog);
    const said: string[] = [];
    const s = new AiSession('i:qa12', 'i', 'qa12', new DirectChannel(ue), { emit: (e, p) => e === 'ai.say' && said.push(p.text) }, 'constructor');
    await o.handleTurn(s, 'Ванная 2 на 2,5 метра');
    await o.handleTurn(s, 'Начнём сначала');
    expect(ue.log.some((l) => l.cmd === 'reset')).toBe(true);
    await o.handleTurn(s, 'Когда вы сможете доставить?');
    expect(said.pop()).toMatch(/менеджер/);
  });
});

describe('QA-013 distinct tiers', () => {
  it('Terra proposal never repeats a configuration look (title + price)', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    let cards: any[] = [];
    const s = new AiSession('i:qa13', 'i', 'qa13', new DirectChannel(ue), { emit: (e, p) => e === 'ai.cards' && (cards = p.cards) }, 'constructor');
    await o.handleTurn(s, 'Покажи коллекцию Terra');
    expect(cards.length).toBeGreaterThan(0);
    const looks = cards.map((c) => `${c.title}|${c.price}`);
    expect(new Set(looks).size).toBe(looks.length);
    expect(new Set(cards.map((c) => c.title)).size).toBe(cards.length);
  });
});

describe('QA-014 card tap without result', () => {
  it('finds the new set with get_state, fills the basket, and «Добавь пенал» configures it', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    let cards: any[] = [];
    let basket: any = null;
    const s = new AiSession('i:qa14', 'i', 'qa14', new DirectChannel(ue), { emit: (e, p) => { if (e === 'ai.cards') cards = p.cards; if (e === 'ai.basket') basket = p; } }, 'constructor');
    await o.handleTurn(s, 'Покажи варианты до 6000 BYN');
    const card = cards.find((c) => f.catalog.getProduct(c.config.productId)!.closetModels.length > 0 && c.config.closetSizeIndex < 0) ?? cards[0];
    ue.execute({ id: 'r-1-1', cmd: 'apply_config', args: { config: card.config, placement: card.placement, cardId: card.cardId } });
    await o.handleCardTap(s, { cardId: card.cardId, requestId: 'r-1-1' }); // no result
    expect(s.sets.size).toBe(1);
    expect(basket.total).toBe(card.price);
    await o.handleTurn(s, 'Добавь пенал');
    if (f.catalog.getProduct(card.config.productId)!.closetModels.length) expect(ue.sets[0].config.closetSizeIndex).toBe(0);
  });
});

import { consultantNotes } from '../src/ai/dossier/template';
import { buildSpec } from '../src/ai/dossier/spec';
import { demoSave } from './helpers/save';
import { fullConfig } from '../src/ai/catalog/index';

describe('QA-016 dossier notes state only site facts', () => {
  it('Milu note uses the page features; Terra gets no material/warranty claim; dark walls get no «светлые» remark', () => {
    const milu = buildSpec(demoSave(f.catalog, { withMetrics: true }).save as any, f.catalog);
    const nm = consultantNotes(milu, f.index.products).join(' ');
    expect(nm).toMatch(/гарантия производителя 12 лет \(по данным oliveeka\.by\)/);
    const terraCfg = fullConfig({ productId: 'Terra', sizeIndex: 0, colourIndex: 0, ...f.catalog.defaultsFor('Terra', 0)! });
    const terra = buildSpec({ saveId: 's', metrics: { sets: [{ setId: 't', config: terraCfg }] } } as any, f.catalog);
    const nt = consultantNotes({ ...terra, finishes: [{ surface: 'стены', label: 'краска RAL 7016' }] }, f.index.products).join(' ');
    expect(nt).not.toMatch(/гарантия|фанер/);
    expect(nt).toContain('уточнит менеджер');
    expect(nt).not.toContain('Светлые стены');
  });
});

describe('QA-017 / QA-018', () => {
  it('announces capturing once per photo, and undo refreshes finishes in the basket', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    const ev: [string, any][] = [];
    const s = new AiSession('i:qa17', 'i', 'qa17', new DirectChannel(ue), { emit: (e, p) => ev.push([e, p]) }, 'constructor');
    await o.handleTurn(s, 'Сделай фото');
    const cap = ev.filter(([e, p]) => e === 'ai.render' && p.stage === 'capturing');
    expect(cap).toHaveLength(1);
    expect(s.announcedRenders.has(cap[0][1].renderId)).toBe(true);
    await o.handleTurn(s, 'Положи на пол серую плитку');
    expect(s.finishes.map((x) => x.surface)).toEqual(['пол']);
    await o.handleTurn(s, 'Отмени последнее');
    expect(s.finishes).toEqual([]);
    const basket = ev.filter(([e]) => e === 'ai.basket').pop()![1];
    expect(basket.finishes).toEqual([]);
  });
});

import { analyseSession } from '../src/ai/analytics/report';
describe('QA-020 / QA-021', () => {
  it('kept sets are counted from basket snapshots, or from applied sets in older logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q21-'));
    const old = path.join(dir, 'old.jsonl');
    fs.writeFileSync(old, [
      { ts: '1', type: 'cards', cards: [{ cardId: 'k1', title: 'Milu 80, орех' }] },
      { ts: '2', type: 'card_tap', cardId: 'k1', ok: true },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const a = analyseSession(old);
    expect(a.kept).toEqual([{ title: 'Milu 80, орех', price: 0 }]);
    expect(a.keptSource).toBe('applied');
    const now = path.join(dir, 'now.jsonl');
    fs.writeFileSync(now, [{ ts: '1', type: 'card_tap', cardId: 'k1', ok: true }, { ts: '2', type: 'basket', items: [{ title: 'Avenu 80', price: 2985 }], total: 2985 }].map((x) => JSON.stringify(x)).join('\n'));
    expect(analyseSession(now).kept).toEqual([{ title: 'Avenu 80', price: 2985 }]);
  });
});

describe('QA-018 reset / QA-016 conversation notes', () => {
  it('start over rebuilds the basket from the restored UE state; notes come from what the visitor said', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    const ev: [string, any][] = [];
    const s = new AiSession('i:qa18', 'i', 'qa18', new DirectChannel(ue), { emit: (e, p) => ev.push([e, p]) }, 'constructor');
    await o.handleTurn(s, 'Покажи варианты до 6000 BYN');
    const notes = o.conversationNotes(s);
    expect(notes.join(' ')).toContain('до 6000 BYN');
    await o.handleTurn(s, 'Давай первый вариант');
    await o.handleTurn(s, 'Покрась стены в белый');
    expect(s.sets.size).toBe(1);
    await o.handleTurn(s, 'Начнём сначала');
    expect(s.sets.size).toBe(0);
    expect(s.finishes).toEqual([]);
    const basket = ev.filter(([e]) => e === 'ai.basket').pop()![1];
    expect(basket).toMatchObject({ items: [], finishes: [], total: 0 });
  });
});

import { floorPlanSvg } from '../src/ai/dossier/floorplan';
import { generateCandidates } from '../src/ai/orchestrator/propose';
import sharp from 'sharp';
import { MockRender } from '../src/ai/render/providers';
import { syntheticCapture } from './helpers/capture';

describe('QA-022 / QA-023 floor plan from the real UE layout (QA fixture 240×300)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa_layout_240x300.json'), 'utf8'));
  const layout = JSON.parse(real.layoutJson);
  const svg = floorPlanSvg(layout);
  it('draws the door gap from its near edge (layout dist = centre 60, width 80 -> 20..100 cm) and the window 100..200 cm', () => {
    // wall 1: node 1 (-10130,-160) -> node 2 (-9870,-160); get_state reports the same door at offsetCm 20
    expect(svg).toContain('x1="-10110" y1="-160" x2="-10030" y2="-160"');
    // wall 2: node 2 (-9870,-160) -> node 3 (-9870,160); window dist 150 (centre), width 100 -> 100..200
    expect(svg).toContain('x1="-9870" y1="-60" x2="-9870" y2="40"');
    const gs = JSON.parse(real.getState).result;
    expect(gs.walls[0].openings[0].offsetCm).toBe(20);
  });
  it('labels clear inner-face lengths (240 and 300 cm), not centrelines (260 / 320)', () => {
    expect(svg).toContain('>240 см<');
    expect(svg).toContain('>300 см<');
    expect(svg).not.toContain('>260 см<');
    expect(svg).not.toContain('>320 см<');
  });
});

describe('QA-024 visitor-facing names', () => {
  it('no UE asset names in sink/mirror names', () => {
    for (const m of f.index.mappings.filter((x) => x.component === 'mirror' || x.component === 'sink')) {
      expect(m.name ?? '', m.name).not.toMatch(/Combined_|NewRow|SM_MERGED|Box\d|Parma\d|Cardona|umyvalnik/);
      expect(m.name ?? '').toMatch(/^(Зеркало|Раковина)/);
    }
  });
});

describe('QA-025 Tuma behind CATALOG_TUMA_ENABLED', () => {
  it('is never proposed or placed by default; an explicit request gets an honest answer and Terra', async () => {
    delete process.env.CATALOG_TUMA_ENABLED;
    expect(generateCandidates(f.catalog, { collection: 'Tuma' })).toHaveLength(0);
    expect(f.catalog.validate({ productId: 'Tuma', sizeIndex: 0, colourIndex: 0 })).toMatch(/готовим/);
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    let cards: any[] = [];
    const said: string[] = [];
    const s = new AiSession('i:qa25', 'i', 'qa25', new DirectChannel(ue), { emit: (e, p) => { if (e === 'ai.cards') cards = p.cards; if (e === 'ai.say') said.push(p.text); } }, 'constructor');
    await o.handleTurn(s, 'Покажи коллекцию Tuma');
    expect(said.pop()).toMatch(/Tuma мы ещё готовим для 3D-комнаты.*Terra/);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.collection === 'Terra')).toBe(true);
    expect(f.index.mappings.some((m) => m.productId === 'Tuma')).toBe(true); // still in the index / coverage
  });
  it('can be switched on with CATALOG_TUMA_ENABLED=1', () => {
    process.env.CATALOG_TUMA_ENABLED = '1';
    try {
      expect(generateCandidates(f.catalog, { collection: 'Tuma' }).length).toBeGreaterThan(0);
    } finally {
      delete process.env.CATALOG_TUMA_ENABLED;
    }
  });
});

describe('QA-026 mock photo is a light grade, never dark', () => {
  it('final and preview keep the mean brightness within 0.97–1.15 of the beauty frame', async () => {
    const c = await syntheticCapture();
    const mean = async (png: Buffer) => (await sharp(png).removeAlpha().stats()).channels.slice(0, 3).reduce((a, ch) => a + ch.mean, 0) / 3;
    const base = await mean(c.beauty);
    const m = new MockRender();
    const input = { beautyPng: c.beauty, depthPng: c.depth, editMaskPng: c.mask, prompt: '', width: 64, height: 48 };
    for (const img of [await m.preview(input), await m.final(input)]) {
      const r = (await mean(img)) / base;
      expect(r).toBeGreaterThan(0.97);
      expect(r).toBeLessThan(1.15);
    }
  });
});

describe('WEB defect: Russian colour names only', () => {
  it('no raw colour ids in UE colour names, card titles or reasons', async () => {
    for (const p of f.ue.products) {
      for (const c of [...p.cabinet.colours, ...p.closetModels.flatMap((m) => m.colours)]) expect(c.name, c.name).not.toMatch(/^[\x00-\x7F]+$|_/);
    }
    const urban = f.ue.products.find((p) => p.productId === 'Urban')!;
    expect(urban.cabinet.colours[0].name).toBe('Чёрный МДФ');
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    let cards: any[] = [];
    const s = new AiSession('i:col', 'i', 'col', new DirectChannel(ue), { emit: (e, p) => e === 'ai.cards' && (cards = p.cards) }, 'constructor');
    await o.handleTurn(s, 'Покажи коллекцию Urban, что-нибудь тёмное');
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.title).not.toMatch(/[A-Za-z]+_|black|mdf/i);
      expect(c.reason).not.toMatch(/black|mdf/i);
    }
  });
});

describe('QA-036 / QA-038 dossier plan and finishes', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa_layout_240x300.json'), 'utf8'));
  const layout = JSON.parse(real.layoutJson);
  const gs = JSON.parse(real.getState).result;
  it('draws the set as its real footprint on the wall face (clear of the door swing), not around the pivot', () => {
    const set = gs.sets[0];
    const svg = floorPlanSvg(layout, { setSizes: { [set.setId]: { w: set.placement.footprintCm.width, d: set.placement.footprintCm.depth, label: 'Milu 80', placement: set.placement } } });
    const pts = svg.match(/<polygon points="([^"]+)"/)![1].split(' ').map((p) => p.split(',').map(Number));
    const ys = pts.map((p) => p[1]);
    const xs = pts.map((p) => p[0]);
    // wall 4 runs from (-10130,160) to (-10130,-160); inner face at x = -10120; footprint centred at y = 0
    expect(Math.min(...xs)).toBeCloseTo(-10120, 0);
    expect(Math.min(...ys)).toBeCloseTo(-set.placement.footprintCm.width / 2, 0);
    expect(Math.max(...ys)).toBeCloseTo(set.placement.footprintCm.width / 2, 0);
    // door swing on wall 1 reaches y = -160 + 10 + 80 = -70 (inner face + door width): the set stays clear of it
    expect(Math.min(...ys)).toBeGreaterThan(-70);
  });
  it('lists tiles by display name', () => {
    const spec = buildSpec({ saveId: 's', planner: { ...layout, rooms: [{ id: 1, finish: { type: 'tile', tileId: 'Tile_Grey60' } }] } } as any, f.catalog);
    expect(spec.finishes.map((x) => x.label)).toContain('плитка «Серый керамогранит 60×60»');
    expect(JSON.stringify(spec.finishes)).not.toContain('плитка Tile_');
  });
});

import { vi } from 'vitest';
import { SocketChannel } from '../src/ai/orchestrator/channel';

describe('QA-043 / CR-AI-04: command timeout covers the page queue', () => {
  it('no TIMEOUT while the page may still send; the execution timeout starts at "sent"', async () => {
    vi.useFakeTimers();
    try {
      const ch = new SocketChannel(() => undefined);
      let res: any = null;
      ch.send({ type: 'MaxiMallAI', id: 'r-1-1', cmd: 'get_state', args: {} }, 8000).then((r) => (res = r));
      expect(ch.status('r-1-1', 'queued')).toBe('queued');
      await vi.advanceTimersByTimeAsync(20000); // stream down: queued for 20 s -> still pending (old code: TIMEOUT at 8 s)
      expect(res).toBeNull();
      expect(ch.status('r-1-1', 'sent')).toBe('sent');
      await vi.advanceTimersByTimeAsync(7900);
      expect(res).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(res.reasonCode).toBe('TIMEOUT');
      // legacy page without status events: deadline = queue wait (30 s) + execution
      let res2: any = null;
      ch.send({ type: 'MaxiMallAI', id: 'r-1-2', cmd: 'get_state', args: {} }, 8000).then((r) => (res2 = r));
      await vi.advanceTimersByTimeAsync(37000);
      expect(res2).toBeNull();
      await vi.advanceTimersByTimeAsync(1100);
      expect(res2.reasonCode).toBe('TIMEOUT');
      expect(ch.status('unknown', 'sent')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QA-018 with the real UE get_state shape', () => {
  /** Wraps the simulator so get_state/undo look like the real dispatcher: finishes {walls[], floors[], ceilings[]} with
   * finish strings ("RAL 9010", "tile:Tile_Grey60"), and the undo result carries no finishes. */
  class RealShapeChannel extends DirectChannel {
    async send(req: any) {
      const r: any = await super.send(req);
      const toReal = (st: any) => {
        const f = this.ue.finishes;
        return {
          walls: f.all_walls ? [0, 1, 2, 3].map((i) => ({ segmentId: i, side: 'left', finish: f.all_walls.code })) : [],
          floors: f.floor ? [{ roomId: 1, finish: `tile:${f.floor.tileId}` }] : [],
          ceilings: [],
        };
      };
      if (req.cmd === 'get_state' && r.ok) r.result = { ...r.result, finishes: toReal(r.result) };
      if (req.cmd === 'undo' && r.ok) {
        const { finishes, ...rest } = r.result;
        r.result = rest;
      }
      return r;
    }
  }
  it('undo of a floor tile removes it from the basket (refreshed via get_state), walls stay', async () => {
    const o = orch();
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    const ev: [string, any][] = [];
    const s = new AiSession('i:qa18r', 'i', 'qa18r', new RealShapeChannel(ue), { emit: (e, p) => ev.push([e, p]) }, 'constructor');
    await o.handleTurn(s, 'Покрась стены в белый');
    await o.handleTurn(s, 'Положи на пол серую плитку');
    expect(s.finishes.map((x) => x.surface).sort()).toEqual(['пол', 'стены']);
    await o.handleTurn(s, 'Отмени последнее');
    expect(ue.log.some((l) => l.cmd === 'get_state')).toBe(true);
    const basket = ev.filter(([e]) => e === 'ai.basket').pop()![1];
    expect(basket.finishes).toEqual([{ surface: 'стены', label: 'краска RAL 9010' }]);
  });
});

describe('QA-038: no rectangle at the pivot', () => {
  it('a set without a known footprint is not drawn', () => {
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa_layout_240x300.json'), 'utf8'));
    const svg = floorPlanSvg(JSON.parse(real.layoutJson), { setSizes: { other: { w: 80, d: 50, label: 'Milu 80' } } });
    expect(svg).not.toContain('<polygon');
    expect(svg).not.toContain('<g transform="translate'); // the old pivot rectangle
    expect(svg).not.toContain('Milu 80');
  });
});

describe('QA-044: ai.command.wait clears on sent, result, timeout and close', () => {
  it('only queued commands get the status, and every one is switched off', async () => {
    vi.useFakeTimers();
    try {
      const ev: [string, any][] = [];
      const ch = new SocketChannel((e, p) => ev.push([e, p]));
      const waits = () => ev.filter(([e]) => e === 'ai.command.wait').map(([, p]) => `${p.id}:${p.on}${p.reason ? ':' + p.reason : ''}`);
      const req = (id: string) => ({ type: 'MaxiMallAI' as const, id, cmd: 'consultant_say', args: { text: 'x' } });
      void ch.send(req('a'), 8000);
      ch.deliver({ type: 'result', id: 'a', cmd: 'consultant_say', ok: true, state_rev: 0 } as any); // never queued -> no status
      void ch.send(req('b'), 8000);
      ch.status('b', 'queued');
      ch.status('b', 'queued'); // repeated queued: shown once
      ch.status('b', 'sent');
      void ch.send(req('c'), 8000);
      ch.status('c', 'queued');
      ch.deliver({ type: 'result', id: 'c', cmd: 'consultant_say', ok: true, state_rev: 0 } as any);
      void ch.send(req('d'), 8000);
      ch.status('d', 'queued');
      await vi.advanceTimersByTimeAsync(38100);
      void ch.send(req('e'), 8000);
      ch.status('e', 'queued');
      ch.cancelAll();
      expect(waits()).toEqual(['b:true', 'b:false:sent', 'c:true', 'c:false:result', 'd:true', 'd:false:timeout', 'e:true', 'e:false:closed']);
      expect(ev.some(([e]) => e === 'ai.thinking')).toBe(false);
      expect(ev.find(([e, p]) => e === 'ai.command.wait' && p.on)![1].text).toBe('Подключаюсь к 3D-комнате…');
    } finally {
      vi.useRealTimers();
    }
  });
});
