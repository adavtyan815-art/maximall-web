import fs from 'fs';
import path from 'path';
import type { CatalogIndex } from '../catalog/index';
import { componentLabel } from '../catalog/index';
import type { Component, SetConfig } from '../catalog/types';
import { t, type Lang } from '../i18n';
import { articleName, tileName } from '../i18n/names';
import { CatalogLinks, cmToMm, isPartnerUrl, PARTNER_HOME, PARTNER_HOST, type DimensionsMm } from './catalogLinks';
import { countsInTotal, isApproximate, lineAmount, lineStatus, round2, statusCounts, totalOf, unitPriceOf, type LineStatus } from './status';

/**
 * MONTH2_SPEC m2.2 §11.3–§11.4 (REQ-31 / REQ-32, decisions D4): the room estimate (смета) behind POST /api/ai/estimate.
 *
 * The page posts UE's aggregated room_estimate_state (sets by identical config, objects by assetId, surfaces by kind + finish,
 * baseboards by finish). Pure and read-only: no session, no writes, no paid calls; nothing about the request is stored or logged.
 *
 * - Sets: CatalogIndex.quote(config) (bundle first, de-duplicated within the set) × the entry's qty; quote().missing → one unpriced
 *   line per component. Lines with the same article code merge across sets (qty summed, setIds united); lines without one merge by
 *   component + name.
 * - Objects (DT_PlannerObjects) are not shop products: one unpriced line per assetId, no link.
 * - Finishes by (finish, surface kind), m² or m; prices only from the optional data/catalog/finish_prices.json (absent tonight: every
 *   finishing line is unpriced, never invented). Unfinished surfaces sum into one `info` line «Без отделки: N м²».
 * - Line status (status.ts): priced / estimated (counted, approximate) / unpriced («цена уточняется», not counted). VAT is included in the
 *   retail prices: vatIncluded:true, no tax line.
 * - Links (catalogLinks.ts): only an article of the scraped site list products[], and only its own https oliveeka.by page.
 * Never returned: note, estimatedFrom, unmapped, match, image.
 */

export { ESTIMATE_PATH, ESTIMATE_BODY_LIMIT, estimateJsonParser } from './bodyParser';
export const DEFAULT_FINISH_PRICES_FILE = path.join(__dirname, '..', '..', '..', 'data', 'catalog', 'finish_prices.json');

const SURFACE_KINDS = ['wall', 'floor', 'ceiling'] as const;
type SurfaceKind = (typeof SURFACE_KINDS)[number];
const CONFIG_KEYS = [
  'productId', 'sizeIndex', 'colourIndex', 'countertopSizeIndex', 'countertopColourIndex', 'closetSizeIndex', 'closetColourIndex',
  'sinkSizeIndex', 'sinkColourIndex', 'faucetSizeIndex', 'faucetColourIndex', 'mirrorSizeIndex', 'mirrorColourIndex',
] as const;
const COMPONENTS: readonly Component[] = ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'];

// ─── request (§11.3) ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface EstimateRequest {
  lang: Lang;
  rev?: string;
  truncated?: boolean;
  sets: { setIds: string[]; qty: number; config: SetConfig }[];
  objects: { assetId: string; name?: string; qty: number }[];
  surfaces: { kind: SurfaceKind; areaM2: number; finish: string }[];
  baseboards: { lengthM: number; finish: string }[];
}

export type ValidateResult = { ok: true; req: EstimateRequest } | { ok: false; field: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const isNum = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const isStr = (x: unknown, max: number, min = 0): x is string => typeof x === 'string' && x.length >= min && x.length <= max;

class Bad extends Error {
  constructor(public readonly field: string) {
    super(field);
  }
}
function only(o: Record<string, unknown>, keys: readonly string[], at: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Bad(at ? `${at}.${k}` : k);
}
function arr(body: Record<string, unknown>, key: string, max: number): unknown[] {
  const v = body[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new Bad(key);
  return v;
}

/** §11.3 limits (estimate-api.schema.json#/$defs/request). Any violation → the offending field path. */
export function validateEstimateRequest(body: unknown): ValidateResult {
  try {
    if (!isObj(body)) throw new Bad('body');
    only(body, ['lang', 'rev', 'truncated', 'sets', 'objects', 'surfaces', 'baseboards'], '');
    if (body.lang !== undefined && body.lang !== 'ru' && body.lang !== 'en') throw new Bad('lang');
    if (body.rev !== undefined && !isStr(body.rev, 16)) throw new Bad('rev');
    if (body.truncated !== undefined && typeof body.truncated !== 'boolean') throw new Bad('truncated');

    let setIdCount = 0;
    const sets = arr(body, 'sets', 30).map((s, i) => {
      const at = `sets[${i}]`;
      if (!isObj(s)) throw new Bad(at);
      only(s, ['setIds', 'qty', 'config'], at);
      if (!isInt(s.qty, 1, 100)) throw new Bad(`${at}.qty`);
      const ids = s.setIds === undefined ? [] : s.setIds;
      if (!Array.isArray(ids) || ids.length > 100) throw new Bad(`${at}.setIds`);
      ids.forEach((id, j) => {
        if (!isStr(id, 64)) throw new Bad(`${at}.setIds[${j}]`);
      });
      setIdCount += ids.length;
      if (setIdCount > 100) throw new Bad(`${at}.setIds`);
      const c = s.config;
      if (!isObj(c)) throw new Bad(`${at}.config`);
      only(c, CONFIG_KEYS, `${at}.config`);
      if (!isStr(c.productId, 64, 1)) throw new Bad(`${at}.config.productId`);
      for (const k of CONFIG_KEYS) {
        if (k === 'productId') continue;
        const req = k === 'sizeIndex' || k === 'colourIndex';
        if (c[k] === undefined && !req) continue;
        if (!isInt(c[k], -1, 99)) throw new Bad(`${at}.config.${k}`);
      }
      return { setIds: ids as string[], qty: s.qty, config: { ...(c as unknown as SetConfig) } };
    });

    const objects = arr(body, 'objects', 200).map((o, i) => {
      const at = `objects[${i}]`;
      if (!isObj(o)) throw new Bad(at);
      only(o, ['assetId', 'name', 'qty'], at);
      if (!isStr(o.assetId, 64, 1)) throw new Bad(`${at}.assetId`);
      if (o.name !== undefined && !isStr(o.name, 80)) throw new Bad(`${at}.name`);
      if (!isInt(o.qty, 1, 100)) throw new Bad(`${at}.qty`);
      return { assetId: o.assetId, ...(o.name !== undefined ? { name: o.name as string } : {}), qty: o.qty };
    });

    const surfaces = arr(body, 'surfaces', 400).map((s, i) => {
      const at = `surfaces[${i}]`;
      if (!isObj(s)) throw new Bad(at);
      only(s, ['kind', 'areaM2', 'finish'], at);
      if (!SURFACE_KINDS.includes(s.kind as SurfaceKind)) throw new Bad(`${at}.kind`);
      if (!isNum(s.areaM2, 0, 10000)) throw new Bad(`${at}.areaM2`);
      if (s.finish !== undefined && !isStr(s.finish, 40)) throw new Bad(`${at}.finish`);
      return { kind: s.kind as SurfaceKind, areaM2: s.areaM2, finish: (s.finish as string | undefined) ?? '' };
    });

    const baseboards = arr(body, 'baseboards', 50).map((b, i) => {
      const at = `baseboards[${i}]`;
      if (!isObj(b)) throw new Bad(at);
      only(b, ['lengthM', 'finish'], at);
      if (!isNum(b.lengthM, 0, 10000)) throw new Bad(`${at}.lengthM`);
      if (b.finish !== undefined && !isStr(b.finish, 40)) throw new Bad(`${at}.finish`);
      return { lengthM: b.lengthM, finish: (b.finish as string | undefined) ?? '' };
    });

    return {
      ok: true,
      req: {
        lang: body.lang === 'en' ? 'en' : 'ru',
        ...(body.rev !== undefined ? { rev: body.rev as string } : {}),
        ...(body.truncated !== undefined ? { truncated: body.truncated as boolean } : {}),
        sets,
        objects,
        surfaces,
        baseboards,
      },
    };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, field: e.field };
    throw e;
  }
}

// ─── finish prices (optional file, §11.4) ─────────────────────────────────────────────────────────────────────────────

export interface FinishPrice {
  /** walls / floors / ceilings */
  priceBYNPerM2?: number;
  /** baseboards */
  priceBYNPerM?: number;
  url?: string;
}
export type FinishPrices = ReadonlyMap<string, FinishPrice>;

/**
 * data/catalog/finish_prices.json: {"tile:Tile_Grey60":{"priceBYNPerM2":n,"url":"https://oliveeka.by/…"},"RAL 9010":{"priceBYNPerM":n}}.
 * Absent or unreadable → no finish prices (every finishing line unpriced). Only finite positive prices and partner URLs are kept.
 */
export function loadFinishPrices(file = process.env.AI_FINISH_PRICES ?? DEFAULT_FINISH_PRICES_FILE): FinishPrices {
  const out = new Map<string, FinishPrice>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!isObj(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!isObj(v) || key.length === 0 || key.length > 40) continue;
    const p: FinishPrice = {};
    if (isNum(v.priceBYNPerM2, 0.01, 1e6)) p.priceBYNPerM2 = v.priceBYNPerM2;
    if (isNum(v.priceBYNPerM, 0.01, 1e6)) p.priceBYNPerM = v.priceBYNPerM;
    if (isPartnerUrl(v.url)) p.url = v.url;
    if (p.priceBYNPerM2 !== undefined || p.priceBYNPerM !== undefined) out.set(key, p);
  }
  return out;
}

// ─── response (§11.3) ──────────────────────────────────────────────────────────────────────────────────────────────────

export type SurfaceOrBaseboard = SurfaceKind | 'baseboard';

export interface EstimateLine {
  key: string;
  kind: 'article' | 'part' | 'object' | 'finish' | 'info';
  articleCode?: string;
  name?: string;
  label?: string;
  component?: Component;
  includes?: Component[];
  setIds?: string[];
  assetId?: string;
  finish?: string;
  surface?: SurfaceOrBaseboard;
  unit?: 'pcs' | 'm2' | 'm';
  quantity?: number;
  qty?: number;
  unitPriceBYN: number | null;
  amountBYN: number;
  status: LineStatus;
  approximate?: boolean;
  url?: string;
  dimensionsMm?: DimensionsMm;
}

export interface EstimateSection {
  id: 'sanitary' | 'finishing';
  title: string;
  subtotalBYN: number;
  lines: EstimateLine[];
}

export interface PartnerItem {
  articleCode: string;
  name: string;
  qty: number;
  priceBYN: number;
  approximate: boolean;
  url: string;
}

export interface EstimateResponse {
  ok: true;
  currency: 'BYN';
  vatIncluded: true;
  catalogSyncedAt: string;
  source: 'https://oliveeka.by';
  lang: Lang;
  rev?: string;
  truncated: boolean;
  sections: EstimateSection[];
  totalBYN: number;
  pricedCount: number;
  estimatedCount: number;
  unpricedCount: number;
  partner: { name: typeof PARTNER_HOST; url: typeof PARTNER_HOME; items: PartnerItem[] };
}

const TEXT = {
  ru: { sanitary: 'Сантехника и мебель', finishing: 'Отделочные материалы', unfinished: (v: string) => `Без отделки: ${v} м²` },
  en: { sanitary: 'Sanitary ware & furniture', finishing: 'Finishing materials', unfinished: (v: string) => `No finish: ${v} m²` },
} as const;

/** «12,4» / "12.4": 2 decimals at most, trailing zeros dropped. */
function num2(v: number, lang: Lang): string {
  const s = String(round2(v));
  return lang === 'en' ? s : s.replace('.', ',');
}

const cap = (s: string) => (s ? s[0].toLocaleUpperCase('ru') + s.slice(1) : s);

/** «Плитка «Серый керамогранит 60×60»», «Краска RAL 9010» (parseFinish + tileName, finish.tile / finish.paint). */
export function finishLabel(finish: string, catalog: CatalogIndex | null, lang: Lang): string {
  const f = finish.trim();
  if (/^tile:/i.test(f)) {
    const id = f.slice(5);
    const ru = catalog?.tiles().find((x) => x.id === id)?.name;
    return cap(t(lang, 'finish.tile', { name: tileName(lang, id, ru ?? id) }));
  }
  return cap(t(lang, 'finish.paint', { code: f }));
}

export interface EstimateDeps {
  catalog: CatalogIndex;
  links: CatalogLinks;
  finishPrices?: FinishPrices;
}

/** §11.3 / §11.4: the priced estimate of one validated request. */
export function buildEstimate(req: EstimateRequest, deps: EstimateDeps): EstimateResponse {
  const { catalog, links } = deps;
  const prices = deps.finishPrices ?? new Map<string, FinishPrice>();
  const lang = req.lang;

  // ── sanitary: sets ──
  const merged = new Map<string, EstimateLine>();
  const order: string[] = [];
  const add = (key: string, make: () => EstimateLine, qty: number, setIds: string[]) => {
    let l = merged.get(key);
    if (!l) {
      l = make();
      l.qty = 0;
      l.setIds = [];
      merged.set(key, l);
      order.push(key);
    }
    l.qty = (l.qty ?? 0) + qty;
    for (const id of setIds) if (!l.setIds!.includes(id)) l.setIds!.push(id);
  };
  for (const entry of req.sets) {
    const q = catalog.quote(entry.config);
    for (const ql of q.lines) {
      const status = lineStatus({ price: ql.price, estimated: ql.estimated, unpriced: ql.unpriced });
      const code = (ql.articleCode ?? '').trim();
      const own = code ? links.ownArticle(code) : undefined;
      const name = articleName(lang, ql.name) || ql.name;
      const key = code ? `art:${code}` : `part:${ql.component}:${ql.name}`;
      add(
        key,
        () => {
          const dims = cmToMm(ql.dimensionsCm) ?? own?.dimensionsMm;
          return {
            key,
            kind: code ? 'article' : 'part',
            ...(code ? { articleCode: code } : {}),
            name,
            component: ql.component,
            ...(ql.includes?.length ? { includes: [...ql.includes] } : {}),
            unitPriceBYN: unitPriceOf({ price: ql.price, estimated: ql.estimated, unpriced: ql.unpriced }),
            amountBYN: 0,
            status,
            approximate: isApproximate(status),
            ...(own?.url && isPartnerUrl(own.url) ? { url: own.url } : {}),
            ...(dims ? { dimensionsMm: dims } : {}),
          };
        },
        entry.qty,
        entry.setIds,
      );
    }
    for (const missing of q.missing) {
      const comp = COMPONENTS.includes(missing as Component) ? (missing as Component) : undefined;
      const name = comp ? cap(componentLabel(comp, lang)) : entry.config.productId;
      const key = `part:${missing}:${name}`;
      add(
        key,
        () => ({ key, kind: 'part', name, ...(comp ? { component: comp } : {}), unitPriceBYN: null, amountBYN: 0, status: 'unpriced', approximate: false }),
        entry.qty,
        entry.setIds,
      );
    }
  }
  const setLines: EstimateLine[] = order.map((k) => {
    const l = merged.get(k)!;
    l.amountBYN = lineAmount(l.status, l.unitPriceBYN, l.qty ?? 0);
    return l;
  });

  // ── sanitary: objects (not shop products: unpriced, no link) ──
  const objQty = new Map<string, { name: string; qty: number }>();
  for (const o of req.objects) {
    const cur = objQty.get(o.assetId);
    if (cur) cur.qty += o.qty;
    else objQty.set(o.assetId, { name: o.name?.trim() || o.assetId, qty: o.qty });
  }
  const objectLines: EstimateLine[] = [...objQty.entries()].map(([assetId, o]) => ({
    key: `obj:${assetId}`,
    kind: 'object',
    assetId,
    name: o.name,
    qty: o.qty,
    unitPriceBYN: null,
    amountBYN: 0,
    status: 'unpriced',
  }));

  // ── finishing: by (finish, surface kind); unfinished surfaces → one info line ──
  const fin = new Map<string, { finish: string; surface: SurfaceOrBaseboard; quantity: number }>();
  const finOrder: string[] = [];
  let unfinishedM2 = 0;
  const addFin = (finish: string, surface: SurfaceOrBaseboard, quantity: number) => {
    const key = `fin:${finish}:${surface}`;
    const cur = fin.get(key);
    if (cur) cur.quantity += quantity;
    else {
      fin.set(key, { finish, surface, quantity });
      finOrder.push(key);
    }
  };
  for (const s of req.surfaces) {
    if (!s.finish.trim()) unfinishedM2 += s.areaM2;
    else addFin(s.finish.trim(), s.kind, s.areaM2);
  }
  for (const b of req.baseboards) if (b.finish.trim()) addFin(b.finish.trim(), 'baseboard', b.lengthM);
  const finishLines: EstimateLine[] = finOrder.map((key) => {
    const f = fin.get(key)!;
    const quantity = round2(f.quantity);
    const unit = f.surface === 'baseboard' ? 'm' : 'm2';
    const p = prices.get(f.finish);
    const unitPrice = (f.surface === 'baseboard' ? p?.priceBYNPerM : p?.priceBYNPerM2) ?? null;
    const status: LineStatus = unitPrice !== null && unitPrice > 0 ? 'priced' : 'unpriced';
    return {
      key,
      kind: 'finish',
      finish: f.finish,
      surface: f.surface,
      label: finishLabel(f.finish, catalog, lang),
      unit,
      quantity,
      unitPriceBYN: status === 'priced' ? unitPrice : null,
      amountBYN: status === 'priced' ? round2((unitPrice ?? 0) * quantity) : 0,
      status,
      ...(status === 'priced' && p?.url ? { url: p.url } : {}),
    };
  });
  if (unfinishedM2 > 0) {
    const quantity = round2(unfinishedM2);
    finishLines.push({ key: 'info:unfinished', kind: 'info', label: TEXT[lang].unfinished(num2(quantity, lang)), unit: 'm2', quantity, unitPriceBYN: null, amountBYN: 0, status: 'info' });
  }

  const sanitaryLines = [...setLines, ...objectLines];
  const all = [...sanitaryLines, ...finishLines];
  const counts = statusCounts(all);
  const items: PartnerItem[] = [];
  for (const l of setLines) {
    if (!l.url || !l.articleCode || !countsInTotal(l.status) || l.unitPriceBYN === null) continue;
    items.push({ articleCode: l.articleCode, name: l.name ?? l.articleCode, qty: l.qty ?? 1, priceBYN: l.unitPriceBYN, approximate: l.status === 'estimated', url: l.url });
  }
  return {
    ok: true,
    currency: 'BYN',
    vatIncluded: true,
    catalogSyncedAt: catalog.syncedAt,
    source: 'https://oliveeka.by',
    lang,
    ...(req.rev !== undefined ? { rev: req.rev } : {}),
    truncated: req.truncated === true,
    sections: [
      { id: 'sanitary', title: TEXT[lang].sanitary, subtotalBYN: totalOf(sanitaryLines), lines: sanitaryLines },
      { id: 'finishing', title: TEXT[lang].finishing, subtotalBYN: totalOf(finishLines), lines: finishLines },
    ],
    totalBYN: totalOf(all),
    ...counts,
    partner: { name: PARTNER_HOST, url: PARTNER_HOME, items },
  };
}
