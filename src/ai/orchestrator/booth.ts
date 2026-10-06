import type { CatalogIndex } from '../catalog/index';
import { fullConfig, lcColour, tonesOf } from '../catalog/index';
import type { SetConfig } from '../catalog/types';
import { PART_RU, resolvePartChoice, type PartName } from './parts';

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

export function collectionOf(c: CatalogIndex, productId: string): string {
  return c.getProduct(productId)?.collection ?? productId;
}

export function boothTitle(c: CatalogIndex, cfg: SetConfig, custom?: { component: string; code?: string }[]): string {
  const f = fullConfig(cfg);
  const paint = custom?.find((x) => x.component === 'cabinet' && x.code)?.code;
  const closetPaint = custom?.find((x) => x.component === 'closet' && x.code)?.code;
  const closet = (f.closetSizeIndex ?? -1) >= 0 ? (closetPaint ? ', с навесным шкафом в ' + closetPaint : ', с навесным шкафом') : '';
  return (collectionOf(c, f.productId) + ' ' + (c.sizeName(f) ?? '') + ', ' + (paint ? 'покраска ' + paint : lcColour(c.colourName(f))) + closet).replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
}
/** «… BYN» plus the honest note for custom paint (no price source for RAL/NCS paint). */
export function boothPrice(total: number, estimated: boolean, custom?: { code?: string }[]): string {
  return total + ' BYN' + (estimated ? ' (цена уточняется)' : '') + (custom?.some((x) => x.code) ? '; стоимость покраски уточнит менеджер' : '');
}

/** «Milu: размеры 80 и 100 см; цвет: орех; …» for THIS booth (scope «эта коллекция»). */
export function describeBoothOptions(c: CatalogIndex, st: BoothState): { say: string; amounts: number[] } {
  const cfg = fullConfig(st.config);
  const p = c.getProduct(cfg.productId);
  if (!p) return { say: 'Этой модели нет в каталоге — уточню у менеджера.', amounts: [] };
  const amounts: number[] = [];
  const sizes = p.cabinet.sizes.map((sz) => {
    const ci = c.colourIndicesForSize(p, sz.index)[0] ?? 0;
    const q = c.quote(fullConfig({ productId: p.productId, sizeIndex: sz.index, colourIndex: ci, ...(c.defaultsFor(p.productId, sz.index) ?? {}) }));
    amounts.push(q.total);
    return `${sz.name} см — от ${q.total} BYN${q.estimated ? ' (цена уточняется)' : ''}`;
  });
  const colours = [...new Set(c.colourIndicesForSize(p, cfg.sizeIndex).map((i) => p.cabinet.colours.find((x) => x.index === i)?.name).filter(Boolean) as string[])].map((n) => lcColour(n));
  const closet = p.closetModels.length ? (cfg.closetSizeIndex >= 0 ? 'навесной шкаф есть — можно убрать' : 'можно добавить навесной шкаф') : 'навесного шкафа в этой коллекции нет';
  const q = c.quote(cfg);
  amounts.push(q.total);
  const dims = p.cabinet.sizes.find((x) => x.index === cfg.sizeIndex);
  const dimText = dims?.widthCm ? ` (${dims.widthCm}${dims.depthCm ? `×${dims.depthCm}` : ''}${dims.heightCm ? `×${dims.heightCm}` : ''} см)` : '';
  return {
    say:
      `${collectionOf(c, cfg.productId)}: размеры ${sizes.join('; ')}. Цвета для этого размера: ${colours.join(', ') || 'один вариант'}. ${closet[0].toUpperCase()}${closet.slice(1)}. ` +
      `Сейчас на стенде — ${boothTitle(c, cfg, st.customColours)}${dimText}, ${boothPrice(q.total, q.estimated, st.customColours)}. ` +
      `Что поменять: размер, цвет, навесной шкаф или покраску по RAL/NCS?`,
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
export function fitAnswer(c: CatalogIndex, cur: SetConfig | undefined, text: string, room: { widthCm: number; depthCm: number } | null): string {
  const s = text.toLowerCase().replace(/ё/g, 'е');
  const named = c.listProducts().find((p) => p.collection && new RegExp(p.collection.toLowerCase()).test(s));
  const base = named ? undefined : cur ? fullConfig(cur) : undefined;
  const p = named ?? (base ? c.getProduct(base.productId) : undefined);
  if (!p) return 'Подойдите к стенду или назовите коллекцию — скажу точные размеры.';
  // the width the visitor asked about («тумба 100 см», «А 80 см поместится?»), not the room numbers
  const roomNums = room ? [room.widthCm, room.depthCm] : [];
  const asked = [...s.matchAll(/(\d{2,3})\s*(?:см|сантиметр)/g)].map((m) => Number(m[1])).find((n) => !roomNums.includes(n) && p.cabinet.sizes.some((z) => z.widthCm === n || new RegExp('(^|\\D)' + n + '(\\D|$)').test(z.name)));
  const size = asked !== undefined ? p.cabinet.sizes.find((z) => z.widthCm === asked || new RegExp('(^|\\D)' + asked + '(\\D|$)').test(z.name))! : p.cabinet.sizes.find((z) => z.index === (base?.sizeIndex ?? p.cabinet.sizes[0].index)) ?? p.cabinet.sizes[0];
  const cfg = fullConfig({ ...(base && base.productId === p.productId ? base : {}), productId: p.productId, sizeIndex: size.index, colourIndex: c.colourIndicesForSize(p, size.index)[0] ?? 0, ...(base && base.productId === p.productId && base.sizeIndex === size.index ? {} : c.defaultsFor(p.productId, size.index) ?? {}) });
  const width = c.footprintWidthCm(cfg) ?? size.widthCm;
  const depth = size.depthCm;
  const label = (p.collection ?? p.productId) + ' ' + size.name + (cfg.closetSizeIndex >= 0 ? ' с навесным шкафом' : '');
  const dims = 'занимает по ширине ' + (width ?? '?') + ' см' + (depth ? ', глубина ' + depth + ' см' : '') + (size.heightCm ? ', высота ' + size.heightCm + ' см' : '');
  if (!room || !width) return label + ' ' + dims + '.';
  const wall = Math.max(room.widthCm, room.depthCm);
  const spare = wall - width;
  return spare >= 0
    ? label + ' ' + dims + '. Ваша длинная стена ' + wall + ' см — по ширине комплект помещается, останется около ' + spare + ' см (без учёта двери и проходов).'
    : label + ' ' + dims + '. Ваша длинная стена ' + wall + ' см — по ширине комплект не помещается, нужно ещё ' + -spare + ' см.';
}

/** Visitor request (semantic) -> booth_configure args for THIS booth, or a truthful answer without a command. */
export function planBoothChange(c: CatalogIndex, st: BoothState, r: BoothRequest): BoothPlan {
  const cur = fullConfig(st.config);
  const p = c.getProduct(cur.productId);
  if (!p) return { kind: 'say', ok: false, say: 'Этой модели нет в каталоге — уточню у менеджера.' };

  if (r.collection) {
    const target = c.listProducts().find((x) => (x.collection ?? x.productId).toLowerCase() === r.collection!.toLowerCase());
    if (!target) return { kind: 'say', ok: false, say: `Коллекции ${r.collection} в каталоге нет.` };
    if (target.productId === cur.productId) return { kind: 'say', ok: true, noChange: true, say: `На стенде уже ${collectionOf(c, cur.productId)}.` };
    if (!c.isCollectionEnabled(target.collection ?? '')) {
      const alt = c.alternativeFor(target.collection);
      return { kind: 'say', ok: false, say: `Коллекцию ${target.collection} мы ещё готовим.${alt ? ` Ближе всего к ней ${alt} — поставить её?` : ''}` };
    }
    if (st.products?.length && !st.products.includes(target.productId)) return { kind: 'say', ok: false, say: `На этот стенд ${target.collection} поставить нельзя.` };
    return { kind: 'configure', args: { productId: target.productId }, what: `Поставила на стенд ${target.collection}` };
  }

  if (r.paintCode) {
    const system = r.paintSystem ?? (/^s\s/i.test(r.paintCode) ? 'NCS' : 'RAL');
    const code = system === 'RAL' && !/^ral/i.test(r.paintCode) ? `RAL ${r.paintCode}` : r.paintCode.toUpperCase().replace(/^RAL\s*/, 'RAL ');
    const component = r.part ?? 'cabinet';
    if (component === 'closet' && cur.closetSizeIndex < 0) return { kind: 'say', ok: false, say: 'Навесного шкафа на стенде нет — сначала его можно добавить.' };
    return { kind: 'configure', args: { customColour: { component, system, code } }, what: `Покрасила ${component === 'closet' ? 'навесной шкаф' : 'тумбу'} в ${code}` };
  }

  const change: Partial<SetConfig> = {};
  let what = '';
  const join = (a: string, b: string) => (a ? `${a}, ${b[0].toLowerCase()}${b.slice(1)}` : b);
  // v2.4: a part by its DataTable id / SKU (or a shared part by colour name) goes through the parts resolver
  const partReq = r.option !== undefined || r.colourId !== undefined || (r.part !== undefined && SHARED_PARTS.has(r.part) && r.colour !== undefined);
  if (r.sizeCm !== undefined) {
    const sz = p.cabinet.sizes.find((x) => x.widthCm === r.sizeCm || new RegExp(`(^|\\D)${r.sizeCm}(\\D|$)`).test(x.name));
    if (!sz) return { kind: 'say', ok: false, say: `Такого размера в ${collectionOf(c, cur.productId)} нет. Есть: ${p.cabinet.sizes.map((x) => `${x.name} см`).join(', ')}.` };
    if (sz.index !== cur.sizeIndex) {
      change.sizeIndex = sz.index;
      const curName = c.colourName(cur) ?? '';
      const same = c.colourIndicesForSize(p, sz.index).find((i) => stem(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') === stem(curName));
      change.colourIndex = same ?? c.colourIndicesForSize(p, sz.index)[0] ?? 0;
      Object.assign(change, c.defaultsFor(p.productId, sz.index) ?? {});
      what = `Поменяла размер на ${sz.name} см`;
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
    });
    if ('error' in res) return { kind: 'say', ok: false, say: res.error };
    Object.assign(change, res.change);
    if (res.what) what = join(what, res.what);
  }
  if (!partReq && r.colour && (r.part ?? 'cabinet') === 'cabinet') {
    const idx = c.colourIndicesForSize(p, size).find((i) => stem(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') === stem(r.colour!));
    if (idx === undefined) {
      const names = [...new Set(c.colourIndicesForSize(p, size).map((i) => lcColour(p.cabinet.colours.find((x) => x.index === i)?.name)))];
      return { kind: 'say', ok: false, say: `Такого цвета у ${collectionOf(c, cur.productId)} нет. Есть: ${names.join(', ')}. Можно покрасить по RAL или NCS — назовите код.` };
    }
    if (idx !== cur.colourIndex) {
      change.colourIndex = idx;
      what = what ? `${what}, цвет — ${lcColour(p.cabinet.colours.find((x) => x.index === idx)?.name)}` : `Поменяла цвет на ${lcColour(p.cabinet.colours.find((x) => x.index === idx)?.name)}`;
    }
  }
  if (!partReq && r.colour && r.part === 'closet') {
    if (cur.closetSizeIndex < 0) return { kind: 'say', ok: false, say: 'Навесного шкафа на стенде нет — сначала его можно добавить.' };
    const m = p.closetModels.find((x) => x.index === cur.closetSizeIndex) ?? p.closetModels[0];
    const ci = m?.colours.find((x) => stem(x.name ?? '') === stem(r.colour!))?.index;
    if (ci === undefined) return { kind: 'say', ok: false, say: `Для навесного шкафа есть цвета: ${(m?.colours ?? []).map((x) => lcColour(x.name)).join(', ')}.` };
    if (ci !== cur.closetColourIndex) {
      change.closetColourIndex = ci;
      what = 'Поменяла цвет навесного шкафа';
    }
  }
  if (r.styleHint) {
    const curRank = rankTone(c.colourName(cur) ?? '');
    const opts = c
      .colourIndicesForSize(p, size)
      .map((i) => ({ i, r: rankTone(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') }))
      .filter((o) => (r.styleHint === 'lighter' ? o.r < curRank : o.r > curRank))
      .sort((a, b) => (r.styleHint === 'lighter' ? b.r - a.r : a.r - b.r));
    if (!opts.length) return { kind: 'say', ok: true, noChange: true, say: `В коллекции ${collectionOf(c, cur.productId)} ${r.styleHint === 'lighter' ? 'светлее' : 'темнее'} цвета нет. Можно покрасить по RAL/NCS или посмотреть другие коллекции.` };
    change.colourIndex = opts[0].i;
    what = `Сделала ${r.styleHint === 'lighter' ? 'светлее' : 'темнее'}: ${lcColour(p.cabinet.colours.find((x) => x.index === opts[0].i)?.name)}`;
  }
  if (r.closet !== undefined) {
    if (r.closet) {
      if (!p.closetModels.length) {
        const others = c.collectionsWithCloset().filter((x) => x !== p.collection);
        return { kind: 'say', ok: false, say: `В коллекции ${p.collection} навесного шкафа нет.${others.length ? ` Он есть в ${others.join(', ')}.` : ''}` };
      }
      if (cur.closetSizeIndex >= 0) return { kind: 'say', ok: true, noChange: true, say: 'Навесной шкаф уже на стенде — можно поменять его цвет.' };
      const m = p.closetModels[0];
      const cab = stem(c.colourName(cur) ?? '');
      change.closetSizeIndex = m.index;
      change.closetColourIndex = m.colours.find((x) => stem(x.name ?? '') === cab)?.index ?? m.colours[0]?.index ?? 0;
      what = what ? `${what}, добавила навесной шкаф` : 'Добавила навесной шкаф';
    } else {
      if (cur.closetSizeIndex < 0) return { kind: 'say', ok: true, noChange: true, say: 'Навесного шкафа на стенде нет — убирать нечего.' };
      change.closetSizeIndex = -1;
      what = what ? `${what}, убрала навесной шкаф` : 'Убрала навесной шкаф';
    }
  }
  // v2.4 extras: back to the catalogue colour, doors
  const args: BoothArgs = {};
  const next = fullConfig({ ...cur, ...change });
  if (r.clearPaint) {
    const part = r.part ?? 'cabinet';
    const has = (st.customColours ?? []).some((x) => x.component === part || (part === 'cabinet' && x.component === 'doors'));
    if (!has && Object.keys(change).length === 0 && !r.doors) return { kind: 'say', ok: true, noChange: true, say: `Покраски у части «${PART_RU[part]}» нет — она уже в цвете из каталога.` };
    if (has) {
      args.clearCustomColour = part;
      what = join(what, `Вернула части «${PART_RU[part]}» цвет из каталога`);
    }
  }
  if (r.doors) {
    const group = r.part === 'closet' ? 'closet' : 'cabinet';
    if (group === 'closet' && next.closetSizeIndex < 0) return { kind: 'say', ok: false, say: 'Навесного шкафа нет — открывать нечего.' };
    if (st.doors && st.doors[group] === 'none') return { kind: 'say', ok: false, say: group === 'closet' ? 'У навесного шкафа нет дверец.' : 'У этой тумбы нет дверец.' };
    if (st.doors && st.doors[group] === r.doors && Object.keys(change).length === 0 && !args.clearCustomColour) {
      return { kind: 'say', ok: true, noChange: true, say: r.doors === 'open' ? 'Дверцы уже открыты.' : 'Дверцы уже закрыты.' };
    }
    args.doors = { [group]: r.doors };
    what = join(what, `${r.doors === 'open' ? 'Открыла' : 'Закрыла'} дверцы ${group === 'closet' ? 'навесного шкафа' : 'тумбы'}`);
  }
  if (Object.keys(change).length === 0 && !args.clearCustomColour && !args.doors) return { kind: 'say', ok: true, noChange: true, say: 'Так уже и есть — на стенде ничего менять не нужно.' };
  if (Object.keys(change).length) {
    const invalid = c.validate(next);
    if (invalid) return { kind: 'say', ok: false, say: invalid };
    args.config = change;
  }
  return { kind: 'configure', args, what };
}
