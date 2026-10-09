import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { AddressInfo } from 'net';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { CatalogIndex } from '../src/ai/catalog/index';
import { CatalogLinks, PARTNER_HOST } from '../src/ai/estimate/catalogLinks';
import { buildEstimate, loadFinishPrices, validateEstimateRequest, type EstimateRequest, type EstimateResponse } from '../src/ai/estimate/estimate';
import { createAiModule } from '../src/ai';
import { ClipStore } from '../src/ai/providers/voice';

/**
 * MONTH2_SPEC m2.2 §11.3–§11.4 / M6 (REQ-31, REQ-32): POST /api/ai/estimate against the committed catalog index (2026-09-30).
 * Pricing = CatalogIndex.quote() of the same config; unpriced lines out of the total; estimated lines counted and approximate; links only
 * to own products[] articles on https oliveeka.by; request limits (400 / 413 / 429); response hygiene; the schema.
 */

const catalog = CatalogIndex.load();
const links = CatalogLinks.fromIndex(catalog.data);
const deps = { catalog, links, finishPrices: new Map() };

const contracts = path.join(__dirname, '..', 'contracts');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of fs.readdirSync(contracts).filter((x) => x.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(contracts, f), 'utf8')));
const E = 'maximall/ai/estimate-api.schema.json';
const valid = (ref: string, data: unknown) => {
  const fn = ajv.getSchema(`${E}#/$defs/${ref}`)!;
  const ok = fn(data);
  if (!ok) throw new Error(`${ref}: ${JSON.stringify(fn.errors?.slice(0, 3))}`);
  return true;
};

/** The default config of a product as the backend proposes it (as UE's SetConfigToJson writes it). */
function defaults(productId: string) {
  const p = catalog.getProduct(productId)!;
  const s0 = p.cabinet.sizes[0]?.index ?? 0;
  return { productId, sizeIndex: s0, colourIndex: catalog.colourIndicesForSize(p, s0)[0] ?? 0, closetSizeIndex: -1, closetColourIndex: 0, ...(catalog.defaultsFor(productId, s0) ?? {}) } as any;
}
const MILU = defaults('Milu');
const URBAN = defaults('Urban');
const AVENU = defaults('Avenu');

function req(over: Partial<EstimateRequest> = {}): EstimateRequest {
  return { lang: 'ru', sets: [], objects: [], surfaces: [], baseboards: [], ...over };
}
const lines = (r: EstimateResponse) => r.sections.flatMap((s) => s.lines);
const line = (r: EstimateResponse, key: string) => lines(r).find((l) => l.key === key);
const quoteTotal = (cfg: any) => {
  const q = catalog.quote(cfg);
  return Math.round(q.lines.filter((l) => !l.unpriced && l.price > 0).reduce((s, l) => s + l.price, 0) * 100) / 100;
};

describe('M6 estimate pricing (§11.4)', () => {
  it('Milu 80 default: 3230 BYN = quote(); bundle MIL80A+CMA80W linked; sink and mirror unpriced, out of the total', () => {
    const r = buildEstimate(req({ sets: [{ setIds: ['AB12CD34'], qty: 1, config: MILU }] }), deps);
    expect(r.totalBYN).toBe(3230);
    expect(r.totalBYN).toBe(quoteTotal(MILU));
    expect(r.currency).toBe('BYN');
    expect(r.vatIncluded).toBe(true);
    const bundle = line(r, 'art:MIL80A+CMA80W')!;
    expect(bundle).toMatchObject({ kind: 'article', status: 'priced', approximate: false, qty: 1, unitPriceBYN: 2872, amountBYN: 2872, setIds: ['AB12CD34'] });
    expect(bundle.includes).toEqual(['cabinet', 'countertop']);
    expect(bundle.url).toBe(links.ownArticleUrl('MIL80A+CMA80W'));
    expect(bundle.dimensionsMm).toEqual({ width: 795, depth: 500, height: 418 }); // the bundle line's dimensionsCm × 10
    const sink = line(r, 'art:OL-20A')!;
    expect(sink).toMatchObject({ status: 'unpriced', unitPriceBYN: null, amountBYN: 0 });
    expect(sink.url).toBeUndefined(); // not a products[] article
    const mirror = lines(r).find((l) => l.component === 'mirror')!;
    expect(mirror).toMatchObject({ kind: 'part', status: 'unpriced', amountBYN: 0 });
    expect(mirror.key).toMatch(/^part:mirror:/);
    expect(r.pricedCount).toBe(2);
    expect(r.unpricedCount).toBe(2);
    expect(r.estimatedCount).toBe(0);
    expect(r.sections.map((s) => s.id)).toEqual(['sanitary', 'finishing']);
    expect(r.sections[0].title).toBe('Сантехника и мебель');
    expect(r.sections[0].subtotalBYN).toBe(3230);
    expect(r.partner.items.map((i) => i.articleCode).sort()).toEqual(['MIL80A+CMA80W', 'OL-139003-CR']);
    valid('okResponse', r);
  });

  it('Urban and Avenu default configs match quote(); Urban 80 is an estimate: counted, approximate on the line and in partner.items', () => {
    for (const cfg of [URBAN, AVENU]) {
      const r = buildEstimate(req({ sets: [{ setIds: ['S1'], qty: 1, config: cfg }] }), deps);
      expect(r.totalBYN, cfg.productId).toBe(quoteTotal(cfg));
      valid('okResponse', r);
    }
    expect(buildEstimate(req({ sets: [{ setIds: ['S1'], qty: 1, config: AVENU }] }), deps).totalBYN).toBe(2985);
    const u = buildEstimate(req({ sets: [{ setIds: ['S1'], qty: 1, config: URBAN }] }), deps);
    expect(u.totalBYN).toBe(2040);
    const urb = line(u, 'art:URB80M')!;
    expect(urb).toMatchObject({ status: 'estimated', approximate: true, unitPriceBYN: 1297, amountBYN: 1297 });
    expect(urb.url).toMatch(/^https:\/\/oliveeka\.by\//); // URB80M is a products[] article (a similar item: «≈ похожая позиция»)
    const top = line(u, 'art:T795C2')!;
    expect(top).toMatchObject({ status: 'estimated', approximate: true });
    expect(top.url).toBeUndefined(); // borrowed price, not on the site
    expect(u.estimatedCount).toBe(2);
    const item = u.partner.items.find((i) => i.articleCode === 'URB80M')!;
    expect(item).toMatchObject({ approximate: true, priceBYN: 1297, qty: 1 });
    expect(u.partner.items.some((i) => i.articleCode === 'T795C2')).toBe(false);
  });

  it('the same article in two sets (or one entry with qty 2) → one line, qty 2, setIds united', () => {
    const a = buildEstimate(req({ sets: [{ setIds: ['A'], qty: 1, config: MILU }, { setIds: ['B'], qty: 1, config: MILU }] }), deps);
    const b = buildEstimate(req({ sets: [{ setIds: ['A', 'B'], qty: 2, config: MILU }] }), deps);
    for (const r of [a, b]) {
      expect(line(r, 'art:MIL80A+CMA80W')).toMatchObject({ qty: 2, amountBYN: 5744, setIds: ['A', 'B'] });
      expect(lines(r).filter((l) => l.component === 'mirror')).toHaveLength(1);
      expect(lines(r).find((l) => l.component === 'mirror')!.qty).toBe(2);
      expect(r.totalBYN).toBe(6460);
    }
    // Milu and Avenu share the faucet: merged across the two products.
    const m = buildEstimate(req({ sets: [{ setIds: ['M'], qty: 1, config: MILU }, { setIds: ['V'], qty: 1, config: AVENU }] }), deps);
    expect(line(m, 'art:OL-139003-CR')).toMatchObject({ qty: 2, setIds: ['M', 'V'], amountBYN: 716 });
    expect(m.totalBYN).toBe(3230 + 2985);
  });

  it('M7: an article exact in one colour and estimated in another stays two purchases (status, ≈ flag and name per line), in both orders', () => {
    const p = catalog.getProduct('Urban')!;
    const colours = catalog.colourIndicesForSize(p, URBAN.sizeIndex);
    const exactColour = colours.find((ci) => catalog.quote({ ...URBAN, colourIndex: ci }).lines.some((l) => l.articleCode === 'URB80M' && !l.estimated && l.price > 0));
    expect(exactColour, 'a colour whose URB80M is an exact purchase').toBeDefined();
    const GREY = { ...URBAN, colourIndex: exactColour };
    expect(catalog.quote(URBAN).lines.find((l) => l.articleCode === 'URB80M')?.estimated).toBe(true); // the default colour: an estimate
    for (const order of [[GREY, URBAN], [URBAN, GREY]]) {
      const r = buildEstimate(req({ sets: order.map((c, i) => ({ setIds: [`S${i}`], qty: 1, config: c })) }), deps);
      const urb = lines(r).filter((l) => l.articleCode === 'URB80M');
      expect(urb).toHaveLength(2);
      const exact = urb.find((l) => l.status === 'priced')!;
      const approx = urb.find((l) => l.status === 'estimated')!;
      expect(exact).toMatchObject({ qty: 1, approximate: false, unitPriceBYN: 1297 });
      expect(approx).toMatchObject({ qty: 1, approximate: true, unitPriceBYN: 1297 });
      expect(approx.name).not.toBe(exact.name); // the estimate names the colour it stands in for
      expect(new Set(urb.map((l) => l.key)).size).toBe(2);
      expect(r.totalBYN).toBe(quoteTotal(GREY) + quoteTotal(URBAN));
      const items = r.partner.items.filter((i) => i.articleCode === 'URB80M');
      expect(items.map((i) => i.approximate).sort()).toEqual([false, true]);
      expect(items.every((i) => i.qty === 1)).toBe(true);
      valid('okResponse', r);
    }
    // The same variant twice still merges into one line.
    const twice = buildEstimate(req({ sets: [{ setIds: ['A'], qty: 1, config: URBAN }, { setIds: ['B'], qty: 1, config: URBAN }] }), deps);
    expect(lines(twice).filter((l) => l.articleCode === 'URB80M')).toHaveLength(1);
    expect(line(twice, 'art:URB80M')).toMatchObject({ qty: 2, status: 'estimated', approximate: true, setIds: ['A', 'B'] });
  });

  it('a component quote() cannot map becomes one unpriced line named by componentLabel', () => {
    const r = buildEstimate(req({ sets: [{ setIds: ['X'], qty: 1, config: { ...MILU, mirrorSizeIndex: 42 } }] }), deps);
    const m = lines(r).find((l) => l.component === 'mirror')!;
    expect(m).toMatchObject({ kind: 'part', name: 'Зеркало', status: 'unpriced', amountBYN: 0 });
    const en = buildEstimate(req({ lang: 'en', sets: [{ setIds: ['X'], qty: 1, config: { ...MILU, mirrorSizeIndex: 42 } }] }), deps);
    expect(lines(en).find((l) => l.component === 'mirror')!.name).toBe('Mirror');
    const unknown = buildEstimate(req({ sets: [{ setIds: ['X'], qty: 1, config: { ...MILU, productId: 'NoSuchProduct' } }] }), deps);
    expect(lines(unknown)).toHaveLength(1);
    expect(lines(unknown)[0]).toMatchObject({ kind: 'part', name: 'NoSuchProduct', status: 'unpriced' });
    expect(unknown.totalBYN).toBe(0);
    valid('okResponse', unknown);
  });

  it('objects are unpriced lines per assetId (qty summed), without a link; finishing grouped by (finish, surface) and unpriced; an info line for unfinished', () => {
    const r = buildEstimate(
      req({
        objects: [{ assetId: 'Chair_Dining02', name: 'Стул', qty: 1 }, { assetId: 'Chair_Dining02', name: 'Стул', qty: 2 }, { assetId: 'Lamp_Floor01', qty: 1 }],
        surfaces: [
          { kind: 'wall', areaM2: 6.21, finish: 'tile:Tile_Grey60' },
          { kind: 'wall', areaM2: 6.66, finish: 'tile:Tile_Grey60' },
          { kind: 'floor', areaM2: 7.5, finish: 'RAL 9010' },
          { kind: 'wall', areaM2: 13.5, finish: '' },
          { kind: 'ceiling', areaM2: 7.5, finish: '' },
        ],
        baseboards: [{ lengthM: 10.1, finish: 'RAL 9010' }, { lengthM: 3, finish: '' }],
      }),
      deps,
    );
    expect(line(r, 'obj:Chair_Dining02')).toMatchObject({ kind: 'object', name: 'Стул', qty: 3, status: 'unpriced', unitPriceBYN: null, amountBYN: 0 });
    expect(line(r, 'obj:Chair_Dining02')!.url).toBeUndefined();
    expect(line(r, 'obj:Lamp_Floor01')).toMatchObject({ name: 'Lamp_Floor01', qty: 1 });
    expect(r.sections[0].lines.map((l) => l.key)).toEqual(['obj:Chair_Dining02', 'obj:Lamp_Floor01']);
    const tile = line(r, 'fin:tile:Tile_Grey60:wall')!;
    expect(tile).toMatchObject({ kind: 'finish', surface: 'wall', unit: 'm2', quantity: 12.87, status: 'unpriced', unitPriceBYN: null, amountBYN: 0 });
    expect(tile.label).toBe('Плитка «Серый керамогранит 60×60»');
    expect(line(r, 'fin:RAL 9010:floor')).toMatchObject({ unit: 'm2', quantity: 7.5, status: 'unpriced', label: 'Краска RAL 9010' });
    expect(line(r, 'fin:RAL 9010:baseboard')).toMatchObject({ surface: 'baseboard', unit: 'm', quantity: 10.1, status: 'unpriced' });
    expect(line(r, 'info:unfinished')).toMatchObject({ kind: 'info', status: 'info', quantity: 21, amountBYN: 0, label: 'Без отделки: 21 м²' });
    expect(r.totalBYN).toBe(0);
    expect(r.unpricedCount).toBe(2 + 3); // 2 objects + 3 finishes; the info line is not counted
    expect(r.sections[1].title).toBe('Отделочные материалы');
    const en = buildEstimate(req({ lang: 'en', surfaces: [{ kind: 'wall', areaM2: 6.21, finish: 'tile:Tile_Grey60' }, { kind: 'floor', areaM2: 2.5, finish: '' }] }), deps);
    expect(en.sections.map((s) => s.title)).toEqual(['Sanitary ware & furniture', 'Finishing materials']);
    expect(line(en, 'info:unfinished')!.label).toBe('No finish: 2.5 m²');
    expect(line(en, 'fin:tile:Tile_Grey60:wall')!.label).toMatch(/^Tile "/);
    valid('okResponse', r);
    valid('okResponse', en);
  });

  it('finish prices come only from the optional finish_prices.json (absent: none); priced lines then count', () => {
    expect(loadFinishPrices(path.join(os.tmpdir(), 'no-such-finish-prices.json')).size).toBe(0);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finprices-')), 'finish_prices.json');
    fs.writeFileSync(f, JSON.stringify({ 'tile:Tile_Grey60': { priceBYNPerM2: 50, url: 'https://oliveeka.by/plitka/x/' }, 'RAL 9010': { priceBYNPerM: 12, url: 'javascript://oliveeka.by/%0a' }, bad: { priceBYNPerM2: -1 } }));
    const prices = loadFinishPrices(f);
    expect([...prices.keys()].sort()).toEqual(['RAL 9010', 'tile:Tile_Grey60']);
    expect(prices.get('RAL 9010')!.url).toBeUndefined();
    const r = buildEstimate(req({ surfaces: [{ kind: 'wall', areaM2: 6.21, finish: 'tile:Tile_Grey60' }], baseboards: [{ lengthM: 10.1, finish: 'RAL 9010' }] }), { ...deps, finishPrices: prices });
    expect(line(r, 'fin:tile:Tile_Grey60:wall')).toMatchObject({ status: 'priced', unitPriceBYN: 50, amountBYN: 310.5, url: 'https://oliveeka.by/plitka/x/' });
    expect(line(r, 'fin:RAL 9010:baseboard')).toMatchObject({ status: 'priced', unitPriceBYN: 12, amountBYN: 121.2 });
    expect(line(r, 'fin:RAL 9010:baseboard')!.url).toBeUndefined();
    expect(r.totalBYN).toBe(431.7);
    // The committed catalog has no such file tonight: every finishing line is unpriced (never invented).
    expect(fs.existsSync(path.join(__dirname, '..', 'data', 'catalog', 'finish_prices.json'))).toBe(false);
  });

  it('an empty room: both sections with no lines, total 0', () => {
    const r = buildEstimate(req({ rev: '9b1e44d2', truncated: false }), deps);
    expect(r.sections.map((s) => s.lines.length)).toEqual([0, 0]);
    expect(r).toMatchObject({ totalBYN: 0, pricedCount: 0, unpricedCount: 0, estimatedCount: 0, rev: '9b1e44d2', truncated: false });
    expect(r.partner).toEqual({ name: 'oliveeka.by', url: 'https://oliveeka.by/', items: [] });
    valid('okResponse', r);
  });

  it('response hygiene: no note / estimatedFrom / unmapped / match / image; every url is https on oliveeka.by', () => {
    const r = buildEstimate(
      req({ sets: [MILU, URBAN, AVENU, defaults('Terra')].map((c, i) => ({ setIds: [`S${i}`], qty: 1, config: c })), objects: [{ assetId: 'Chair_Dining02', qty: 1 }] }),
      deps,
    );
    const s = JSON.stringify(r);
    for (const k of ['note', 'estimatedFrom', 'unmapped', 'match', 'image']) expect(s.includes(`"${k}"`), k).toBe(false);
    const urls = [...lines(r).map((l) => l.url), ...r.partner.items.map((i) => i.url)].filter(Boolean) as string[];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const x = new URL(u);
      expect(x.protocol).toBe('https:');
      expect(x.hostname).toBe(PARTNER_HOST);
    }
    valid('okResponse', r);
  });
});

describe('M6 the real UE room_estimate_state (real run 2026-10-09, dedicated server + client, the §11.1 room built by the AI commands)', () => {
  // Client A's event data, verbatim from its log ([M2] estimate=…): 300 × 250 × 270, a centred door and window, Milu 80, tiled walls,
  // a RAL 9010 floor. Client B built the same rev from the replicated layout and booths.
  const UE_STATE = {"rev":"e95f1161","plannerInstanceId":"planner","units":{"area":"m2","length":"m","height":"cm"},"sets":[{"instanceIds":["MLBggkqA834c-qeX9rzQtQ"],"qty":1,"productId":"Milu","config":{"productId":"Milu","sizeIndex":0,"colourIndex":0,"countertopSizeIndex":0,"countertopColourIndex":0,"closetSizeIndex":-1,"closetColourIndex":0,"sinkSizeIndex":0,"sinkColourIndex":0,"faucetSizeIndex":0,"faucetColourIndex":0,"mirrorSizeIndex":3,"mirrorColourIndex":0},"productName":"Тумба под раковину Oliveeka Milu Орех 80","sku":"MIL80A","customColours":[]}],"objects":[],"surfaces":[{"kind":"wall","finish":"tile:Tile_Grey60","faces":4,"grossM2":29.7,"openingsM2":3.33,"areaM2":26.37},{"kind":"floor","finish":"RAL 9010","faces":1,"areaM2":7.5},{"kind":"ceiling","finish":"","faces":1,"areaM2":7.5}],"baseboards":[{"finish":"","lengthM":10.1}],"rooms":[{"roomId":1,"areaM2":7.5,"perimeterM":11,"ceilingHeightCm":270}],"counts":{"sets":1,"objects":0},"truncated":false};
  it('validates against placement.schema.json#/$defs/estimateState and as an envelope event', () => {
    const vs = ajv.getSchema('maximall/ai/placement.schema.json#/$defs/estimateState')!;
    expect(vs(UE_STATE), JSON.stringify(vs.errors)).toBe(true);
    const ve = ajv.getSchema('maximall/ai/envelope.schema.json#/$defs/event')!;
    expect(ve({ type: 'event', event: 'room_estimate_state', data: UE_STATE })).toBe(true);
    expect(UE_STATE.surfaces.find((s: any) => s.kind === 'wall')).toMatchObject({ faces: 4, grossM2: 29.7, openingsM2: 3.33, areaM2: 26.37 });
  });
  it('priced as the page posts it: Milu 3230 BYN, tiled walls 26.37 m² and the RAL 9010 floor unpriced, the bare ceiling an info line', () => {
    const body = {
      lang: 'ru', rev: UE_STATE.rev, truncated: UE_STATE.truncated,
      sets: UE_STATE.sets.map((s: any) => ({ setIds: s.instanceIds, qty: s.qty, config: s.config })),
      objects: UE_STATE.objects.map((o: any) => ({ assetId: o.assetId, name: o.name ?? '', qty: o.qty })),
      surfaces: UE_STATE.surfaces.map((s: any) => ({ kind: s.kind, areaM2: s.areaM2, finish: s.finish })),
      baseboards: UE_STATE.baseboards.map((b: any) => ({ lengthM: b.lengthM, finish: b.finish })),
    };
    valid('request', body);
    const v = validateEstimateRequest(body);
    expect(v.ok).toBe(true);
    const r = buildEstimate((v as any).req, deps);
    expect(r.totalBYN).toBe(3230);
    expect(line(r, 'fin:tile:Tile_Grey60:wall')).toMatchObject({ quantity: 26.37, status: 'unpriced' });
    expect(line(r, 'fin:RAL 9010:floor')).toMatchObject({ quantity: 7.5, status: 'unpriced' });
    expect(line(r, 'info:unfinished')).toMatchObject({ quantity: 7.5, status: 'info' });
    valid('okResponse', r);
  });
});

describe('M6 estimate request validation (§11.3)', () => {
  const ok = (b: unknown) => expect(validateEstimateRequest(b)).toMatchObject({ ok: true });
  const bad = (b: unknown, field: string) => expect(validateEstimateRequest(b)).toEqual({ ok: false, field });

  it('the page request (§11.3 example) validates, here and in the schema', () => {
    const body = {
      lang: 'ru', rev: '9b1e44d2', truncated: false,
      sets: [{ setIds: ['AB12CD34'], qty: 1, config: MILU }],
      objects: [{ assetId: 'Chair_Dining02', name: 'Стул', qty: 1 }],
      surfaces: [{ kind: 'wall', areaM2: 6.21, finish: 'tile:Tile_Grey60' }],
      baseboards: [{ lengthM: 10.1, finish: '' }],
    };
    ok(body);
    valid('request', body);
    ok({});
  });

  it('out-of-bounds input names the field', () => {
    bad([], 'body');
    bad({ extra: 1 }, 'extra');
    bad({ lang: 'de' }, 'lang');
    bad({ rev: 'x'.repeat(17) }, 'rev');
    bad({ truncated: 'no' }, 'truncated');
    bad({ sets: Array.from({ length: 31 }, () => ({ qty: 1, config: MILU })) }, 'sets');
    bad({ sets: [{ qty: 0, config: MILU }] }, 'sets[0].qty');
    bad({ sets: [{ qty: 101, config: MILU }] }, 'sets[0].qty');
    bad({ sets: [{ qty: 1.5, config: MILU }] }, 'sets[0].qty');
    bad({ sets: [{ qty: 1, config: { ...MILU, sizeIndex: 100 } }] }, 'sets[0].config.sizeIndex');
    bad({ sets: [{ qty: 1, config: { ...MILU, mirrorSizeIndex: -2 } }] }, 'sets[0].config.mirrorSizeIndex');
    bad({ sets: [{ qty: 1, config: { ...MILU, hack: 1 } }] }, 'sets[0].config.hack');
    bad({ sets: [{ qty: 1, config: { productId: 'Milu' } }] }, 'sets[0].config.sizeIndex');
    bad({ sets: [{ qty: 1, setIds: ['x'.repeat(65)], config: MILU }] }, 'sets[0].setIds[0]');
    bad({ sets: [{ qty: 1, setIds: Array.from({ length: 60 }, (_, i) => `a${i}`), config: MILU }, { qty: 1, setIds: Array.from({ length: 41 }, (_, i) => `b${i}`), config: MILU }] }, 'sets[1].setIds');
    bad({ objects: Array.from({ length: 201 }, () => ({ assetId: 'A', qty: 1 })) }, 'objects');
    bad({ objects: [{ assetId: '', qty: 1 }] }, 'objects[0].assetId');
    bad({ objects: [{ assetId: 'A', name: 'n'.repeat(81), qty: 1 }] }, 'objects[0].name');
    bad({ surfaces: [{ kind: 'roof', areaM2: 1 }] }, 'surfaces[0].kind');
    bad({ surfaces: [{ kind: 'wall', areaM2: 10001 }] }, 'surfaces[0].areaM2');
    bad({ surfaces: [{ kind: 'wall', areaM2: -1 }] }, 'surfaces[0].areaM2');
    bad({ surfaces: [{ kind: 'wall', areaM2: 1, finish: 'f'.repeat(41) }] }, 'surfaces[0].finish');
    bad({ baseboards: Array.from({ length: 51 }, () => ({ lengthM: 1 })) }, 'baseboards');
    bad({ baseboards: [{ lengthM: Infinity }] }, 'baseboards[0].lengthM');
  });
});

describe('M6 POST /api/ai/estimate through the real app', () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    process.env.LOCAL_MODE = '1';
    const { default: app } = await import('../src/app');
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8090', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('prices a Milu room (200), CORS for the page, no-store', async () => {
    const r = await post({ lang: 'ru', rev: 'abc', sets: [{ setIds: ['AB12CD34'], qty: 1, config: MILU }] });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:8090');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const j = await r.json();
    expect(j.totalBYN).toBe(3230);
    expect(j.rev).toBe('abc');
    valid('response', j);
  });

  it('out-of-bounds → 400 BAD_REQUEST with the field; wrong content type; broken JSON', async () => {
    let r = await post({ sets: [{ qty: 0, config: MILU }] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'BAD_REQUEST', field: 'sets[0].qty' });
    r = await post('{"lang":', {});
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: 'BAD_REQUEST', field: 'body' });
    r = await fetch(`${url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await r.json()).field).toBe('contentType');
  });

  it('more than 64 KB → 413 TOO_LARGE, with Content-Length and chunked (no Content-Length)', async () => {
    const big = JSON.stringify({ objects: [{ assetId: 'A', name: 'x'.repeat(70 * 1024), qty: 1 }] });
    const r = await post(big);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ ok: false, error: 'TOO_LARGE' });
    // Under the 64 KB limit the same field is checked by the validator instead.
    const under = await post({ objects: [{ assetId: 'A', name: 'x'.repeat(100), qty: 1 }] });
    expect(under.status).toBe(400);
    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(`${url}/api/ai/estimate`);
      const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      rq.on('error', reject);
      for (let i = 0; i < 10; i++) rq.write(big.slice(i * 8000, (i + 1) * 8000)); // 80 KB in 8 KB chunks
      rq.end(big.slice(80000));
    });
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toEqual({ ok: false, error: 'TOO_LARGE' });
  });

  it('other routes keep the global 25 MB parser (a 100 KB save record still posts)', async () => {
    const body = { username: 'qa_m6.user', saveId: 's-m6', saveName: 'Ванная', date: '2026-10-09', boothStates: [], metrics: { note: 'x'.repeat(100 * 1024) } };
    const r = await fetch(`${url}/api/saves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    await fetch(`${url}/api/saves/qa_m6.user/s-m6`, { method: 'DELETE' });
  });
});

describe('M6 estimate route: rate limit and catalog (module-only apps)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm6est-'));
  async function serve(catalogOpt: CatalogIndex | null) {
    const app = express();
    const mod = createAiModule({
      catalog: catalogOpt,
      logDir: path.join(tmp, 'logs'),
      clips: new ClipStore(path.join(tmp, 'clips')),
      renderDir: path.join(tmp, 'renders'),
      savesDir: path.join(tmp, 'saves'),
      dossierDir: path.join(tmp, 'dossiers'),
      arDir: path.join(tmp, 'ar'),
    });
    app.use(mod.router);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const body = JSON.stringify({ sets: [{ setIds: ['A'], qty: 1, config: MILU }] });

  it('600 requests per minute per IP; the 601st → 429 RATE_LIMITED', async () => {
    const s = await serve(catalog);
    try {
      let okCount = 0;
      for (let i = 0; i < 600; i++) {
        const r = await fetch(`${s.url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (r.status === 200) okCount++;
        await r.arrayBuffer();
      }
      expect(okCount).toBe(600);
      const r = await fetch(`${s.url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ ok: false, error: 'RATE_LIMITED' });
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it('no catalog → 503 CATALOG_UNAVAILABLE; the module-only route has the 64 KB parser too', async () => {
    const s = await serve(null);
    try {
      const r = await fetch(`${s.url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, error: 'CATALOG_UNAVAILABLE' });
      const big = await fetch(`${s.url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) });
      expect(big.status).toBe(413);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });
});
