import type { CatalogIndex } from '../catalog/index';
import { fullConfig, tonesOf } from '../catalog/index';
import type { SetConfig } from '../catalog/types';
import { partLabel, resolvePartChoice, type PartName } from './parts';
import { t, type Lang } from '../i18n';
import { colourLabel, colourMatches, colourMatchesLoose } from '../i18n/names';

/**
 * Contracts v2.0: salon booth dialogue. booth_get gives the booth's productId + config (the UE truth); names, prices and
 * the option space come from the catalog index (the same booth-resolved space UE uses), so the answer is Russian and priced.
 */
export interface BoothState {
  boothId: string;
  label?: string;
  productId: string;
  collection?: string;
  config: SetConfig;
  customColours?: { component: string; rgb?: string; code?: string }[];
  /** v2.4: open | closed | none per door group. */
  doors?: { cabinet?: string; closet?: string };
  products?: string[];
  undoAvailable?: boolean;
}

export interface BoothRequest {
  collection?: string;
  sizeCm?: number;
  colour?: string;
  part?: PartName;
  closet?: boolean;
  paintCode?: string;
  paintSystem?: 'RAL' | 'NCS';
  styleHint?: 'lighter' | 'darker';
  /** v2.4: the part's model by its DataTable id (list_options), e.g. a sink row «NewRow_3», a mirror, a countertop. */
  option?: string;
  /** v2.4: a colour by SKU (or name) from list_options. */
  colourId?: string;
  /** v2.4: open / close the doors of the cabinet (or of the wall cabinet with part «closet»). */
  doors?: 'open' | 'closed';
  /** v2.4: remove the RAL/NCS paint of the part (back to the catalogue colour). */
  clearPaint?: boolean;
}

export interface BoothArgs {
  productId?: string;
  config?: Partial<SetConfig>;
  customColour?: { component: string; system: 'RAL' | 'NCS'; code: string };
  clearCustomColour?: string;
  doors?: { cabinet?: 'open' | 'closed'; closet?: 'open' | 'closed' };
}

export type BoothPlan = { kind: 'configure'; args: BoothArgs; what: string } | { kind: 'say'; ok: boolean; say: string; noChange?: boolean };

const SHARED_PARTS = new Set(['countertop', 'sink', 'faucet', 'mirror']);

const stem = (s: string) => s.toLowerCase().replace(/ё/g, 'е').slice(0, 4);

/**
 * v2.5: a colour word -> a catalogue colour. Ids first (the English id «walnut», the raw DataTable id «Black_MDF»), then the
 * Russian 4-letter stem (unchanged for Russian), then — English sessions — the English name (exact, then a loose prefix).
 */
function findColour<T extends { name?: string; productName?: string }>(list: T[], word: string, lang: Lang): T | undefined {
  // a Russian word: the 4-letter stem exactly as before v2.5 (Russian behaviour unchanged)
  if (/[А-Яа-яЁё]/.test(word)) return list.find((x) => stem(x.name ?? '') === stem(word));
  return list.find((x) => colourMatches(word, x.name, x.productName)) ?? (lang === 'en' ? list.find((x) => colourMatchesLoose(word, x.name)) : undefined);
}

export function collectionOf(c: CatalogIndex, productId: string): string {
  return c.getProduct(productId)?.collection ?? productId;
}

export function boothTitle(c: CatalogIndex, cfg: SetConfig, custom?: { component: string; code?: string }[], lang: Lang = 'ru'): string {
  const f = fullConfig(cfg);
  const paint = custom?.find((x) => x.component === 'cabinet' && x.code)?.code;
  const closetPaint = custom?.find((x) => x.component === 'closet' && x.code)?.code;
  const closet = (f.closetSizeIndex ?? -1) >= 0 ? (closetPaint ? t(lang, 'title.withClosetPaint', { code: closetPaint }) : t(lang, 'title.withCloset')) : '';
  return (collectionOf(c, f.productId) + ' ' + (c.sizeName(f) ?? '') + ', ' + (paint ? t(lang, 'title.paint', { code: paint }) : colourLabel(lang, c.colourName(f))) + closet).replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
}
/** «… BYN» plus the honest note for custom paint (no price source for RAL/NCS paint). */
export function boothPrice(total: number, estimated: boolean, custom?: { code?: string }[], lang: Lang = 'ru'): string {
  return t(lang, 'price.byn', { total, estimated }) + (estimated ? t(lang, 'price.estimated') : '') + (custom?.some((x) => x.code) ? t(lang, 'price.paintNote') : '');
}

/** «Milu: размеры 80 и 100 см; цвет: орех; …» for THIS booth (scope «эта коллекция»). */
export function describeBoothOptions(c: CatalogIndex, st: BoothState, lang: Lang = 'ru'): { say: string; amounts: number[] } {
  const cfg = fullConfig(st.config);
  const p = c.getProduct(cfg.productId);
  if (!p) return { say: t(lang, 'model.notInCatalog'), amounts: [] };
  const amounts: number[] = [];
  const sizes = p.cabinet.sizes.map((sz) => {
    const ci = c.colourIndicesForSize(p, sz.index)[0] ?? 0;
    const q = c.quote(fullConfig({ productId: p.productId, sizeIndex: sz.index, colourIndex: ci, ...(c.defaultsFor(p.productId, sz.index) ?? {}) }));
    amounts.push(q.total);
    return t(lang, 'booth.sizeFrom', { size: sz.name, from: q.total, estimated: q.estimated });
  });
  const colours = [...new Set(c.colourIndicesForSize(p, cfg.sizeIndex).map((i) => p.cabinet.colours.find((x) => x.index === i)?.name).filter(Boolean) as string[])].map((n) => colourLabel(lang, n));
  const closet = p.closetModels.length ? (cfg.closetSizeIndex >= 0 ? t(lang, 'booth.closetHas') : t(lang, 'booth.closetCanAdd')) : t(lang, 'booth.closetNone');
  const q = c.quote(cfg);
  amounts.push(q.total);
  const dims = p.cabinet.sizes.find((x) => x.index === cfg.sizeIndex);
  const dimText = dims?.widthCm ? t(lang, 'dims.paren', { w: dims.widthCm, d: dims.depthCm, h: dims.heightCm }) : '';
  return {
    say: t(lang, 'booth.describe', {
      collection: collectionOf(c, cfg.productId),
      sizes,
      colours: (lang === 'en' ? [...new Set(colours)] : colours).join(', ') || t(lang, 'colours.single'),
      closet,
      title: boothTitle(c, cfg, st.customColours, lang),
      dims: dimText,
      price: boothPrice(q.total, q.estimated, st.customColours, lang),
    }),
    amounts,
  };
}

function rankTone(name: string) {
  const t = tonesOf(name);
  if (t.includes('white')) return 0;
  if (t.includes('light')) return 1;
  if (t.includes('grey') || t.includes('neutral')) return 2;
  if (t.includes('dark') || t.includes('black')) return 3;
  return 2;
}

/**
 * QA-080: an honest, informational answer to a fit question from catalogue dimensions (no booth change):
 * the set width (cabinet + wall cabinet) against the longest wall of the room the visitor named, and the depth.
 */
export function fitAnswer(c: CatalogIndex, cur: SetConfig | undefined, text: string, room: { widthCm: number; depthCm: number } | null, lang: Lang = 'ru'): string {
  const s = text.toLowerCase().replace(/ё/g, 'е');
  const named = c.listProducts().find((p) => p.collection && new RegExp(p.collection.toLowerCase()).test(s));
  const base = named ? undefined : cur ? fullConfig(cur) : undefined;
  const p = named ?? (base ? c.getProduct(base.productId) : undefined);
  if (!p) return t(lang, 'fit.nameCollection');
  // the width the visitor asked about («тумба 100 см», «А 80 см поместится?»), not the room numbers
  const roomNums = room ? [room.widthCm, room.depthCm] : [];
  const unitRe = lang === 'en' ? /(\d{2,3})\s*(?:см|сантиметр|cm\b|centimet)/g : /(\d{2,3})\s*(?:см|сантиметр)/g;
  const asked = [...s.matchAll(unitRe)].map((m) => Number(m[1])).find((n) => !roomNums.includes(n) && p.cabinet.sizes.some((z) => z.widthCm === n || new RegExp('(^|\\D)' + n + '(\\D|$)').test(z.name)));
  const size = asked !== undefined ? p.cabinet.sizes.find((z) => z.widthCm === asked || new RegExp('(^|\\D)' + asked + '(\\D|$)').test(z.name))! : p.cabinet.sizes.find((z) => z.index === (base?.sizeIndex ?? p.cabinet.sizes[0].index)) ?? p.cabinet.sizes[0];
  const cfg = fullConfig({ ...(base && base.productId === p.productId ? base : {}), productId: p.productId, sizeIndex: size.index, colourIndex: c.colourIndicesForSize(p, size.index)[0] ?? 0, ...(base && base.productId === p.productId && base.sizeIndex === size.index ? {} : c.defaultsFor(p.productId, size.index) ?? {}) });
  const width = c.footprintWidthCm(cfg) ?? size.widthCm;
  const depth = size.depthCm;
  const label = (p.collection ?? p.productId) + ' ' + size.name + (cfg.closetSizeIndex >= 0 ? t(lang, 'fit.withCloset') : '');
  const dims = t(lang, 'fit.dims', { width, depth, height: size.heightCm });
  if (!room || !width) return t(lang, 'fit.plain', { label, dims });
  const wall = Math.max(room.widthCm, room.depthCm);
  const spare = wall - width;
  return spare >= 0 ? t(lang, 'fit.fitsWall', { label, dims, wall, spare }) : t(lang, 'fit.noFitWall', { label, dims, wall, need: -spare });
}

/** Visitor request (semantic) -> booth_configure args for THIS booth, or a truthful answer without a command. */
export function planBoothChange(c: CatalogIndex, st: BoothState, r: BoothRequest, lang: Lang = 'ru'): BoothPlan {
  const cur = fullConfig(st.config);
  const p = c.getProduct(cur.productId);
  if (!p) return { kind: 'say', ok: false, say: t(lang, 'model.notInCatalog') };

  if (r.collection) {
    const target = c.listProducts().find((x) => (x.collection ?? x.productId).toLowerCase() === r.collection!.toLowerCase());
    if (!target) return { kind: 'say', ok: false, say: t(lang, 'booth.noCollection', { col: r.collection }) };
    if (target.productId === cur.productId) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.alreadyCollection', { col: collectionOf(c, cur.productId) }) };
    if (!c.isCollectionEnabled(target.collection ?? '')) {
      const alt = c.alternativeFor(target.collection);
      return { kind: 'say', ok: false, say: t(lang, 'booth.collectionNotReady', { col: target.collection, alt }) };
    }
    if (st.products?.length && !st.products.includes(target.productId)) return { kind: 'say', ok: false, say: t(lang, 'booth.collectionNotHere', { col: target.collection }) };
    return { kind: 'configure', args: { productId: target.productId }, what: t(lang, 'booth.placedCollection', { col: target.collection }) };
  }

  if (r.paintCode) {
    const system = r.paintSystem ?? (/^s\s/i.test(r.paintCode) ? 'NCS' : 'RAL');
    const code = system === 'RAL' && !/^ral/i.test(r.paintCode) ? `RAL ${r.paintCode}` : r.paintCode.toUpperCase().replace(/^RAL\s*/, 'RAL ');
    const component = r.part ?? 'cabinet';
    if (component === 'closet' && cur.closetSizeIndex < 0) return { kind: 'say', ok: false, say: t(lang, 'booth.noClosetYet') };
    return { kind: 'configure', args: { customColour: { component, system, code } }, what: t(lang, 'booth.painted', { closet: component === 'closet', code }) };
  }

  const change: Partial<SetConfig> = {};
  let what = '';
  const join = (a: string, b: string) => {
    if (!a) return b;
    const b2 = lang === 'en' ? b.replace(/^I've /, '') : b;
    return `${a}, ${b2[0].toLowerCase()}${b2.slice(1)}`;
  };
  // v2.4: a part by its DataTable id / SKU (or a shared part by colour name) goes through the parts resolver
  const partReq = r.option !== undefined || r.colourId !== undefined || (r.part !== undefined && SHARED_PARTS.has(r.part) && r.colour !== undefined);
  if (r.sizeCm !== undefined) {
    const sz = p.cabinet.sizes.find((x) => x.widthCm === r.sizeCm || new RegExp(`(^|\\D)${r.sizeCm}(\\D|$)`).test(x.name));
    if (!sz) return { kind: 'say', ok: false, say: t(lang, 'booth.noSize', { col: collectionOf(c, cur.productId), sizes: p.cabinet.sizes.map((x) => x.name) }) };
    if (sz.index !== cur.sizeIndex) {
      change.sizeIndex = sz.index;
      const curName = c.colourName(cur) ?? '';
      const same = c.colourIndicesForSize(p, sz.index).find((i) => stem(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') === stem(curName));
      change.colourIndex = same ?? c.colourIndicesForSize(p, sz.index)[0] ?? 0;
      Object.assign(change, c.defaultsFor(p.productId, sz.index) ?? {});
      what = t(lang, 'booth.sizeChanged', { size: sz.name });
    }
  }
  const size = change.sizeIndex ?? cur.sizeIndex;
  if (partReq) {
    const part: PartName = r.part ?? 'cabinet';
    const res = resolvePartChoice(c, fullConfig({ ...cur, ...change }), {
      part,
      option: r.option ?? (part === 'cabinet' ? p.cabinet.sizes.find((x) => x.index === size)?.name : undefined),
      colour: r.colourId ?? r.colour,
      present: part === 'closet' ? true : undefined,
    }, lang);
    if ('error' in res) return { kind: 'say', ok: false, say: res.error };
    Object.assign(change, res.change);
    if (res.what) what = join(what, res.what);
  }
  if (!partReq && r.colour && (r.part ?? 'cabinet') === 'cabinet') {
    const sizeColours = c.colourIndicesForSize(p, size).map((i) => p.cabinet.colours.find((x) => x.index === i)!).filter(Boolean);
    const idx = findColour(sizeColours, r.colour!, lang)?.index;
    if (idx === undefined) {
      const names = [...new Set(c.colourIndicesForSize(p, size).map((i) => colourLabel(lang, p.cabinet.colours.find((x) => x.index === i)?.name)))];
      return { kind: 'say', ok: false, say: t(lang, 'booth.noColour', { col: collectionOf(c, cur.productId), names }) };
    }
    if (idx !== cur.colourIndex) {
      change.colourIndex = idx;
      const colour = colourLabel(lang, p.cabinet.colours.find((x) => x.index === idx)?.name);
      what = what ? t(lang, 'booth.colourAppend', { what, colour }) : t(lang, 'booth.colourChanged', { colour });
    }
  }
  if (!partReq && r.colour && r.part === 'closet') {
    if (cur.closetSizeIndex < 0) return { kind: 'say', ok: false, say: t(lang, 'booth.noClosetYet') };
    const m = p.closetModels.find((x) => x.index === cur.closetSizeIndex) ?? p.closetModels[0];
    const ci = findColour(m?.colours ?? [], r.colour!, lang)?.index;
    if (ci === undefined) return { kind: 'say', ok: false, say: t(lang, 'booth.closetColours', { names: (m?.colours ?? []).map((x) => colourLabel(lang, x.name)) }) };
    if (ci !== cur.closetColourIndex) {
      change.closetColourIndex = ci;
      what = t(lang, 'booth.closetColourChanged');
    }
  }
  if (r.styleHint) {
    const curRank = rankTone(c.colourName(cur) ?? '');
    const opts = c
      .colourIndicesForSize(p, size)
      .map((i) => ({ i, r: rankTone(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') }))
      .filter((o) => (r.styleHint === 'lighter' ? o.r < curRank : o.r > curRank))
      .sort((a, b) => (r.styleHint === 'lighter' ? b.r - a.r : a.r - b.r));
    if (!opts.length) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.noLighter', { col: collectionOf(c, cur.productId), lighter: r.styleHint === 'lighter' }) };
    change.colourIndex = opts[0].i;
    what = t(lang, 'lighter.done', { lighter: r.styleHint === 'lighter', colour: colourLabel(lang, p.cabinet.colours.find((x) => x.index === opts[0].i)?.name) });
  }
  if (r.closet !== undefined) {
    if (r.closet) {
      if (!p.closetModels.length) {
        const others = c.collectionsWithCloset().filter((x) => x !== p.collection);
        return { kind: 'say', ok: false, say: t(lang, 'booth.noClosetInCollection', { collection: p.collection, others }) };
      }
      if (cur.closetSizeIndex >= 0) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.closetAlready') };
      const m = p.closetModels[0];
      const cab = stem(c.colourName(cur) ?? '');
      change.closetSizeIndex = m.index;
      change.closetColourIndex = m.colours.find((x) => stem(x.name ?? '') === cab)?.index ?? m.colours[0]?.index ?? 0;
      what = what ? t(lang, 'booth.closetAddedAppend', { what }) : t(lang, 'closet.added');
    } else {
      if (cur.closetSizeIndex < 0) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.closetNothingToRemove') };
      change.closetSizeIndex = -1;
      what = what ? t(lang, 'booth.closetRemovedAppend', { what }) : t(lang, 'closet.removed');
    }
  }
  // v2.4 extras: back to the catalogue colour, doors
  const args: BoothArgs = {};
  const next = fullConfig({ ...cur, ...change });
  if (r.clearPaint) {
    const part = r.part ?? 'cabinet';
    const has = (st.customColours ?? []).some((x) => x.component === part || (part === 'cabinet' && x.component === 'doors'));
    if (!has && Object.keys(change).length === 0 && !r.doors) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.noPaintPart', { part: partLabel(part, lang) }) };
    if (has) {
      args.clearCustomColour = part;
      what = join(what, t(lang, 'booth.clearedPaint', { part: partLabel(part, lang) }));
    }
  }
  if (r.doors) {
    const group = r.part === 'closet' ? 'closet' : 'cabinet';
    if (group === 'closet' && next.closetSizeIndex < 0) return { kind: 'say', ok: false, say: t(lang, 'booth.noClosetDoors') };
    if (st.doors && st.doors[group] === 'none') return { kind: 'say', ok: false, say: group === 'closet' ? t(lang, 'booth.closetNoDoors') : t(lang, 'booth.cabinetNoDoors') };
    if (st.doors && st.doors[group] === r.doors && Object.keys(change).length === 0 && !args.clearCustomColour) {
      return { kind: 'say', ok: true, noChange: true, say: r.doors === 'open' ? t(lang, 'booth.doorsAlreadyOpen') : t(lang, 'booth.doorsAlreadyClosed') };
    }
    args.doors = { [group]: r.doors };
    what = join(what, t(lang, 'booth.doors', { open: r.doors === 'open', closet: group === 'closet' }));
  }
  if (Object.keys(change).length === 0 && !args.clearCustomColour && !args.doors) return { kind: 'say', ok: true, noChange: true, say: t(lang, 'booth.same') };
  if (Object.keys(change).length) {
    const invalid = c.validate(next, lang);
    if (invalid) return { kind: 'say', ok: false, say: invalid };
    args.config = change;
  }
  return { kind: 'configure', args, what };
}
