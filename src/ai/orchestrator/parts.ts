import type { CatalogIndex } from '../catalog/index';
import { fullConfig, lcColour } from '../catalog/index';
import type { ResolvedModel, SetConfig, UeColour } from '../catalog/types';

/**
 * Contracts v2.4 (Phase 4): the parts of a cabinet set addressed by DataTable identifiers instead of raw indices.
 *
 * - a model of a shared part = its row name in DT_SharedCountertops / DT_SharedSinks / AllowedFaucetIDs / AllowedMirrorIDs
 *   (e.g. «ForMiluStoleshka», «NewRow_3»); the cabinet «model» = its size name in DT_FurnitureCatalog (e.g. «80»); the wall cabinet
 *   = its ClosetOptions model name;
 * - a colour = its SKU (FFurnitureColorOption.SKU) or, when the row has none (faucets), its Russian name.
 *
 * Everything is resolved in the booth-resolved space for the set's CURRENT cabinet size (QA-007), exactly the options the
 * right-click configurator offers, and validated by the catalog index before a command is sent.
 */
export type PartName = 'cabinet' | 'closet' | 'countertop' | 'sink' | 'faucet' | 'mirror';
export const PART_NAMES: PartName[] = ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'];

export const PART_RU: Record<PartName, string> = {
  cabinet: 'тумба',
  closet: 'навесной шкаф',
  countertop: 'столешница',
  sink: 'раковина',
  faucet: 'смеситель',
  mirror: 'зеркало',
};

export interface PartColour {
  id: string;
  name: string;
  current: boolean;
  priceBYN?: number;
  estimated?: boolean;
}
export interface PartOption {
  id: string;
  label: string;
  widthCm?: number;
  current: boolean;
  colours: PartColour[];
}
export interface PartListing {
  part: PartName;
  label: string;
  options: PartOption[];
  /** Why the part has no choice here (e.g. a built-in sink), Russian. */
  note?: string;
}

const norm = (s?: string) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const stem = (s?: string) => norm(s).slice(0, 4);

/** Visitor-facing label of a shared model: the shop article name without the trailing code, plus its width. */
function modelLabel(c: CatalogIndex, productId: string, part: PartName, m: ResolvedModel, ctx: { cabinetSizeIndex: number; topKind?: string }): string {
  const mp = c.mapping(productId, part, m.index, m.colours[0]?.index ?? 0, ctx);
  let name = (mp?.name ?? m.name ?? '').replace(/\s+/g, ' ').trim();
  if (mp?.articleCode) name = name.replace(mp.articleCode, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
  if (part === 'mirror') name = `Зеркало ${m.widthCm ? `${m.widthCm} см` : ''}${m.name && !/^combined|^sm_/i.test(m.name) ? ` (${m.name})` : ''}`.trim();
  if (part === 'countertop' && m.kind === 'BuiltIn' && !/раковин/i.test(name)) name += ' (со встроенной раковиной)';
  if (part === 'faucet' && m.kind === 'Integrated' && !/скрыт/i.test(name)) name += ' (скрытого монтажа)';
  // a faucet's mesh width (≈ 5 cm) means nothing to a visitor
  const width = m.widthCm && part !== 'mirror' && part !== 'faucet' && !new RegExp(`${m.widthCm}`).test(name) ? `, ${m.widthCm} см` : '';
  return (name || `${PART_RU[part]} ${m.index + 1}`) + width;
}

/** Several models with the same shop name (sinks, faucets): add the article / SKU, then a number, so each label is unique. */
function uniqueLabels(c: CatalogIndex, productId: string, part: PartName, models: ResolvedModel[], options: PartOption[], ctx: { cabinetSizeIndex: number; topKind?: string }) {
  const count = (l: string) => options.filter((o) => o.label === l).length;
  options.forEach((o, i) => {
    if (count(o.label) < 2) return;
    const m = models[i];
    const code = c.mapping(productId, part, m.index, m.colours[0]?.index ?? 0, ctx)?.articleCode ?? m.colours[0]?.sku;
    if (code && !/^#/.test(code)) o.label = `${o.label} (${code})`;
  });
  const seen = new Map<string, number>();
  for (const o of options) {
    if (count(o.label) < 2) continue;
    const n = (seen.get(o.label) ?? 0) + 1;
    seen.set(o.label, n);
    o.label = `${o.label} — вариант ${n}`;
  }
  return options;
}

function colourId(col: UeColour): string {
  return col.sku && !/^#/.test(col.sku) ? col.sku : col.name;
}

function priced(c: CatalogIndex, productId: string, part: PartName, sizeIndex: number, colourIndex: number, ctx: { cabinetSizeIndex?: number; topKind?: string }) {
  const mp = c.mapping(productId, part, sizeIndex, colourIndex, ctx);
  if (!mp) return {};
  return mp.priceBYN > 0 ? { priceBYN: mp.priceBYN, estimated: mp.match === 'estimated' } : { estimated: true };
}

/** Every allowed option of one part (or all parts) for this configuration, with ids for the tools. */
export function listParts(c: CatalogIndex, cfg: SetConfig, only?: PartName): PartListing[] {
  const f = fullConfig(cfg);
  const p = c.getProduct(f.productId);
  if (!p) return [];
  const out: PartListing[] = [];
  const want = (x: PartName) => !only || only === x;
  const ctx = { cabinetSizeIndex: f.sizeIndex };
  if (want('cabinet')) {
    const options = p.cabinet.sizes.map((sz) => {
      const cols = c.colourIndicesForSize(p, sz.index).map((i) => p.cabinet.colours.find((x) => x.index === i)!).filter(Boolean);
      return {
        id: sz.name,
        label: `Тумба ${sz.name} см${sz.widthCm && sz.depthCm ? ` (${sz.widthCm}×${sz.depthCm}${sz.heightCm ? `×${sz.heightCm}` : ''} см)` : ''}`,
        widthCm: sz.widthCm,
        current: sz.index === f.sizeIndex,
        colours: cols.map((col) => ({ id: colourId(col), name: lcColour(col.name), current: sz.index === f.sizeIndex && col.index === f.colourIndex, ...priced(c, p.productId, 'cabinet', sz.index, col.index, {}) })),
      };
    });
    out.push({ part: 'cabinet', label: PART_RU.cabinet, options });
  }
  if (want('closet')) {
    out.push({
      part: 'closet',
      label: PART_RU.closet,
      options: p.closetModels.map((m) => ({
        id: m.name ?? String(m.index),
        label: `Навесной шкаф${m.widthCm ? ` ${m.widthCm}${m.heightCm ? `×${m.heightCm}` : ''} см` : ''}`,
        widthCm: m.widthCm,
        current: f.closetSizeIndex === m.index,
        colours: m.colours.map((col) => ({ id: colourId(col), name: lcColour(col.name), current: f.closetSizeIndex === m.index && f.closetColourIndex === col.index, ...priced(c, p.productId, 'closet', m.index, col.index, {}) })),
      })),
      note: p.closetModels.length ? (f.closetSizeIndex < 0 ? 'Сейчас без навесного шкафа — его можно добавить.' : 'Навесной шкаф можно убрать.') : 'В этой коллекции навесного шкафа нет.',
    });
  }
  const sp = c.space(p.productId, f.sizeIndex);
  if (!sp) return out;
  const kind = c.topKind(f);
  const shared = (part: 'countertop' | 'sink' | 'mirror' | 'faucet', models: ResolvedModel[], extra: { topKind?: string } = {}) =>
    uniqueLabels(c, p.productId, part, models, sharedOptions(part, models, extra), { ...ctx, ...extra });
  const sharedOptions = (part: 'countertop' | 'sink' | 'mirror' | 'faucet', models: ResolvedModel[], extra: { topKind?: string } = {}): PartOption[] =>
    models.map((m) => ({
      id: m.rowId,
      label: modelLabel(c, p.productId, part, m, { ...ctx, ...extra }),
      widthCm: m.widthCm,
      current: (f as any)[`${part}SizeIndex`] === m.index,
      colours: m.colours.map((col) => ({ id: colourId(col), name: lcColour(col.name), current: (f as any)[`${part}SizeIndex`] === m.index && (f as any)[`${part}ColourIndex`] === col.index, ...priced(c, p.productId, part, m.index, col.index, { ...ctx, ...extra }) })),
    }));
  if (want('countertop') && sp.countertop.length) out.push({ part: 'countertop', label: PART_RU.countertop, options: shared('countertop', sp.countertop) });
  if (want('sink') && sp.sink.length) {
    out.push(
      kind === 'BuiltIn'
        ? { part: 'sink', label: PART_RU.sink, options: [], note: 'Раковина встроена в столешницу — отдельную раковину можно выбрать только с обычной столешницей.' }
        : { part: 'sink', label: PART_RU.sink, options: shared('sink', sp.sink) },
    );
  }
  if (want('faucet') && sp.faucet[kind].length) out.push({ part: 'faucet', label: PART_RU.faucet, options: shared('faucet', sp.faucet[kind], { topKind: kind }) });
  if (want('mirror') && sp.mirror.length) out.push({ part: 'mirror', label: PART_RU.mirror, options: shared('mirror', sp.mirror) });
  return out;
}

/** One short Russian line per part: current choice and how many alternatives (for speech / chat). */
export function describeListing(listing: PartListing[]): string {
  return listing
    .map((l) => {
      if (!l.options.length) return `${l.label[0].toUpperCase()}${l.label.slice(1)}: ${l.note ?? 'выбора нет'}`;
      const cur = l.options.find((o) => o.current);
      const curCol = cur?.colours.find((x) => x.current)?.name;
      const names = l.options.map((o) => o.label + (o.colours.length > 1 ? ` (цвета: ${o.colours.map((x) => x.name).join(', ')})` : ''));
      return `${l.label[0].toUpperCase()}${l.label.slice(1)}: сейчас ${cur ? `${cur.label}${curCol ? `, ${curCol}` : ''}` : 'не выбрана'}; варианты — ${names.join('; ')}`;
    })
    .join('. ');
}

export interface PartChoice {
  part: PartName;
  /** Model id from listParts (row name / size name / closet model name). */
  option?: string;
  /** Colour id (SKU) or Russian colour name. */
  colour?: string;
  /** Wall cabinet: false removes it, true adds it. */
  present?: boolean;
}

/** Visitor choice → partial config (booth-resolved indices) + a Russian "what I did", or a truthful refusal. */
export function resolvePartChoice(c: CatalogIndex, cfg: SetConfig, ch: PartChoice): { change: Partial<SetConfig>; what: string } | { error: string } {
  const f = fullConfig(cfg);
  const p = c.getProduct(f.productId);
  if (!p) return { error: 'Этой модели нет в каталоге.' };
  const listing = listParts(c, f, ch.part)[0];
  const ru = PART_RU[ch.part];
  if (ch.part === 'closet' && ch.present === false) {
    if (f.closetSizeIndex < 0) return { error: 'Навесного шкафа и так нет.' };
    return { change: { closetSizeIndex: -1 }, what: 'Убрала навесной шкаф' };
  }
  if (!listing || !listing.options.length) return { error: listing?.note ?? `Для этой коллекции ${ru} не выбирается.` };
  // the model: by id (exact, case-insensitive), else by a number in it («зеркало 80»), else the current one
  const q = norm(ch.option);
  let opt = ch.option ? listing.options.find((o) => norm(o.id) === q) : undefined;
  if (!opt && ch.option) {
    const n = q.match(/\d{2,3}/)?.[0];
    opt = listing.options.find((o) => norm(o.label).includes(q)) ?? (n ? listing.options.find((o) => String(o.widthCm) === n || o.id === n) : undefined);
  }
  if (ch.option && !opt) return { error: `Такого варианта (${ru}) нет. Есть: ${listing.options.map((o) => o.label).join('; ')}.` };
  if (!opt) opt = listing.options.find((o) => o.current) ?? (ch.part === 'closet' || ch.present ? listing.options[0] : undefined);
  if (!opt) return { error: `Уточните, какой вариант (${ru}) поставить.` };
  // the colour: by SKU or name stem, else keep the current colour name if the model has it, else the first
  let col = ch.colour ? opt.colours.find((x) => norm(x.id) === norm(ch.colour)) ?? opt.colours.find((x) => stem(x.name) === stem(ch.colour)) : undefined;
  if (ch.colour && !col && opt.colours.length) return { error: `У варианта «${opt.label}» есть цвета: ${opt.colours.map((x) => x.name).join(', ')}.` };
  if (!col) col = opt.colours.find((x) => x.current) ?? opt.colours.find((x) => stem(x.name) === stem(c.colourName(f))) ?? opt.colours[0];
  const colIndex = (models: { index: number; colours: UeColour[] }[], modelIdx: number) => {
    const m = models.find((x) => x.index === modelIdx);
    return col ? m?.colours.find((x) => colourId(x) === col!.id && lcColour(x.name) === col!.name)?.index ?? m?.colours.find((x) => colourId(x) === col!.id)?.index ?? 0 : 0;
  };
  const sp = c.space(p.productId, f.sizeIndex);
  const change: Partial<SetConfig> = {};
  switch (ch.part) {
    case 'cabinet': {
      const sz = p.cabinet.sizes.find((x) => x.name === opt!.id)!;
      const ci = p.cabinet.colours.find((x) => col && colourId(x) === col.id && lcColour(x.name) === col.name && c.colourIndicesForSize(p, sz.index).includes(x.index))?.index ?? c.colourIndicesForSize(p, sz.index)[0] ?? 0;
      if (sz.index !== f.sizeIndex) Object.assign(change, { sizeIndex: sz.index }, c.defaultsFor(p.productId, sz.index) ?? {});
      if (ci !== f.colourIndex || sz.index !== f.sizeIndex) change.colourIndex = ci;
      break;
    }
    case 'closet': {
      const m = p.closetModels.find((x) => (x.name ?? String(x.index)) === opt!.id)!;
      change.closetSizeIndex = m.index;
      change.closetColourIndex = colIndex(p.closetModels, m.index);
      break;
    }
    case 'countertop':
    case 'sink':
    case 'mirror': {
      const list = sp![ch.part];
      const m = list.find((x) => x.rowId === opt!.id)!;
      (change as any)[`${ch.part}SizeIndex`] = m.index;
      (change as any)[`${ch.part}ColourIndex`] = colIndex(list, m.index);
      if (ch.part === 'countertop' && (m.kind === 'BuiltIn' ? 'BuiltIn' : 'SurfaceMounted') !== c.topKind(f)) {
        // the faucet list depends on the countertop type (as the configurator resets it): first faucet, same colour name if possible
        const kind = m.kind === 'BuiltIn' ? 'BuiltIn' : 'SurfaceMounted';
        const curFaucetCol = c.resolvedModel(f, 'faucet')?.colours.find((x) => x.index === f.faucetColourIndex)?.name;
        const first = sp!.faucet[kind][0];
        change.faucetSizeIndex = first?.index ?? 0;
        change.faucetColourIndex = first?.colours.find((x) => stem(x.name) === stem(curFaucetCol))?.index ?? 0;
      }
      break;
    }
    case 'faucet': {
      const list = sp!.faucet[c.topKind(f)];
      const m = list.find((x) => x.rowId === opt!.id)!;
      change.faucetSizeIndex = m.index;
      change.faucetColourIndex = colIndex(list, m.index);
      break;
    }
  }
  const next = fullConfig({ ...f, ...change });
  const same = Object.keys(change).every((k) => (next as any)[k] === (f as any)[k]);
  if (same) return { change: {}, what: '' };
  const invalid = c.validate(next);
  if (invalid) return { error: invalid };
  const colTxt = col && opt.colours.length > 1 ? `, ${col.name}` : '';
  const what =
    ch.part === 'cabinet'
      ? `Поставила ${opt.label.toLowerCase()}${colTxt}`
      : ch.part === 'closet' && f.closetSizeIndex < 0
        ? `Добавила навесной шкаф${colTxt}`
        : `Поменяла ${ru === 'зеркало' ? 'зеркало' : ru} на «${opt.label}»${colTxt}`;
  return { change, what };
}
