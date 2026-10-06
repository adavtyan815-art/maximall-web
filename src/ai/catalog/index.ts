import fs from 'fs';
import path from 'path';
import type { CatalogIndexData, Component, Mapping, Quote, QuoteLine, ResolvedModel, ResolvedSpace, SetConfig, SharedComponent, UeProduct } from './types';

export const DEFAULT_INDEX_FILE = path.join(__dirname, '..', '..', '..', 'data', 'catalog', 'index.json');

const COMPONENT_LABEL_RU: Record<Component, string> = {
  cabinet: 'тумба',
  closet: 'шкаф навесной',
  countertop: 'столешница',
  sink: 'раковина',
  faucet: 'смеситель',
  mirror: 'зеркало',
};
export function componentLabelRu(c: Component) {
  return COMPONENT_LABEL_RU[c];
}

/** Colour words → tone classes, used for style filtering and reasons. */
export const COLOUR_TONES: { re: RegExp; tones: string[]; ru: string }[] = [
  { re: /бел|white|ivory|молоч|кашемир/i, tones: ['light', 'white', 'neutral'], ru: 'светлый' },
  { re: /дуб|oak/i, tones: ['light', 'wood', 'warm'], ru: 'дерево' },
  { re: /орех|walnut/i, tones: ['dark', 'wood', 'warm'], ru: 'тёмное дерево' },
  { re: /сер|grey|gray|бетон|графит/i, tones: ['neutral', 'grey', 'modern'], ru: 'серый' },
  { re: /черн|чёрн|black|антрацит|венге/i, tones: ['dark', 'black', 'modern'], ru: 'тёмный' },
  { re: /беж|песоч|sand|капуч|латте/i, tones: ['light', 'warm'], ru: 'тёплый светлый' },
  { re: /зелен|олив|шалфей|green/i, tones: ['colour', 'green'], ru: 'цветной' },
];
export function tonesOf(colourName?: string): string[] {
  if (!colourName) return [];
  const t = new Set<string>();
  for (const c of COLOUR_TONES) if (c.re.test(colourName)) c.tones.forEach((x) => t.add(x));
  return [...t];
}

/** Colour name inside a sentence/title: lower-case words, keep abbreviations such as «МДФ». */
export function lcColour(name?: string): string {
  return (name ?? '')
    .split(' ')
    .map((w) => (/^[А-ЯЁA-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

export function fullConfig(c: SetConfig): Required<SetConfig> {
  return {
    productId: c.productId,
    sizeIndex: c.sizeIndex,
    colourIndex: c.colourIndex,
    countertopSizeIndex: c.countertopSizeIndex ?? 0,
    countertopColourIndex: c.countertopColourIndex ?? 0,
    closetSizeIndex: c.closetSizeIndex ?? -1,
    closetColourIndex: c.closetColourIndex ?? 0,
    sinkSizeIndex: c.sinkSizeIndex ?? 0,
    sinkColourIndex: c.sinkColourIndex ?? 0,
    faucetSizeIndex: c.faucetSizeIndex ?? 0,
    faucetColourIndex: c.faucetColourIndex ?? 0,
    mirrorSizeIndex: c.mirrorSizeIndex ?? 0,
    mirrorColourIndex: c.mirrorColourIndex ?? 0,
  };
}

function key(m: { productId: string; component: Component; cabinetSizeIndex?: number; topKind?: string; sizeIndex: number; colourIndex: number }) {
  return `${m.productId}|${m.component}|${m.cabinetSizeIndex ?? '-'}|${m.component === 'faucet' ? m.topKind ?? '-' : '-'}|${m.sizeIndex}|${m.colourIndex}`;
}

export class CatalogIndex {
  private byKey = new Map<string, Mapping>();
  private products = new Map<string, UeProduct>();
  constructor(public readonly data: CatalogIndexData) {
    for (const m of data.mappings) this.byKey.set(key(m), m);
    for (const p of data.ue.products) this.products.set(p.productId, p);
  }

  static load(file = process.env.AI_CATALOG_INDEX ?? DEFAULT_INDEX_FILE): CatalogIndex {
    return new CatalogIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  static tryLoad(file?: string): CatalogIndex | null {
    try {
      return CatalogIndex.load(file);
    } catch {
      return null;
    }
  }

  get syncedAt() {
    return this.data.syncedAt;
  }
  listProducts(): UeProduct[] {
    return [...this.products.values()];
  }
  getProduct(id: string) {
    return this.products.get(id);
  }

  /** Cabinet/closet mappings are size-independent; shared parts are looked up in the resolved space of the cabinet size. */
  mapping(productId: string, component: Component, sizeIndex: number, colourIndex: number, ctx: { cabinetSizeIndex?: number; topKind?: string } = {}) {
    const shared = component !== 'cabinet' && component !== 'closet';
    return this.byKey.get(key({ productId, component, sizeIndex, colourIndex, cabinetSizeIndex: shared ? ctx.cabinetSizeIndex : undefined, topKind: ctx.topKind }));
  }

  space(productId: string, cabinetSizeIndex: number): ResolvedSpace | undefined {
    return this.getProduct(productId)?.resolved?.[String(cabinetSizeIndex)];
  }
  /** The booth-resolved model for a shared component (faucets depend on the countertop type). */
  resolvedModel(cfg: SetConfig, comp: SharedComponent): ResolvedModel | undefined {
    const c = fullConfig(cfg);
    const sp = this.space(c.productId, c.sizeIndex);
    if (!sp) return undefined;
    if (comp === 'faucet') return sp.faucet[this.topKind(c)]?.[c.faucetSizeIndex];
    return (sp[comp] as ResolvedModel[])[(c as any)[`${comp}SizeIndex`]];
  }
  topKind(cfg: SetConfig): 'SurfaceMounted' | 'BuiltIn' {
    const c = fullConfig(cfg);
    const m = this.space(c.productId, c.sizeIndex)?.countertop[c.countertopSizeIndex];
    return m?.kind === 'BuiltIn' ? 'BuiltIn' : 'SurfaceMounted';
  }

  /** Colours valid for a cabinet size (SizeIndices empty = all sizes). */
  colourIndicesForSize(p: UeProduct, sizeIndex: number): number[] {
    return p.cabinet.colours.filter((c) => !c.sizeIndices || c.sizeIndices.length === 0 || c.sizeIndices.includes(sizeIndex)).map((c) => c.index);
  }

  /**
   * Collections that may be proposed/placed. Tuma is off unless CATALOG_TUMA_ENABLED=1 (QA-025: its DT_CabinetSetLayouts
   * row puts the set on the floor, turned 90°, until the owner fixes the data). It stays in the index and coverage report.
   */
  isCollectionEnabled(collection?: string): boolean {
    if (collection === 'Tuma') return process.env.CATALOG_TUMA_ENABLED === '1';
    return true;
  }
  /** Closest enabled alternative for a disabled collection (Tuma -> Terra: same 70/80 cm sizes, dark wood). */
  alternativeFor(collection?: string): string | undefined {
    return collection === 'Tuma' ? 'Terra' : undefined;
  }

  /** Validates a config in the booth-resolved index space. Returns a Russian reason or null. */
  validate(cfg: SetConfig): string | null {
    const c = fullConfig(cfg);
    const p = this.getProduct(c.productId);
    if (!p) return `Нет такого товара в каталоге: ${c.productId}`;
    if (!this.isCollectionEnabled(p.collection)) return `Коллекцию ${p.collection} мы ещё готовим для 3D-комнаты`;
    if (!p.cabinet.sizes.some((s) => s.index === c.sizeIndex)) return 'Такого размера нет в каталоге';
    if (!this.colourIndicesForSize(p, c.sizeIndex).includes(c.colourIndex)) return 'Этот цвет недоступен для выбранного размера';
    if (c.closetSizeIndex >= 0) {
      if (p.closetModels.length === 0) return 'К этой коллекции навесного шкафа нет';
      const m = p.closetModels.find((x) => x.index === c.closetSizeIndex);
      if (!m) return 'Такого навесного шкафа нет в каталоге';
      if (!m.colours.some((x) => x.index === c.closetColourIndex)) return 'Такого цвета шкафа нет в каталоге';
    }
    const sp = this.space(c.productId, c.sizeIndex);
    if (!sp) return null;
    const check = (comp: SharedComponent, list: ResolvedModel[]) => {
      if (list.length === 0) return null;
      const m = list[(c as any)[`${comp}SizeIndex`]];
      if (!m) return `Недопустимый вариант: ${componentLabelRu(comp)}`;
      const ci = (c as any)[`${comp}ColourIndex`] as number;
      const n = Math.max(1, m.colours.length);
      if (ci < 0 || ci >= n) return comp === 'countertop' ? 'Эта столешница не подходит к выбранному размеру тумбы' : `Недопустимый цвет: ${componentLabelRu(comp)}`;
      return null;
    };
    return check('countertop', sp.countertop) ?? check('sink', sp.sink) ?? check('faucet', sp.faucet[this.topKind(c)]) ?? check('mirror', sp.mirror);
  }

  /**
   * Prices a complete configuration from the index only (never invents): the price source for cabinet + countertop option
   * (one bundle article, or the single parts, or a flagged estimate), then closet, vessel sink (only on a surface-mounted
   * top), faucet and mirror. Duplicate article codes are counted once. `complete` is false when a present component has
   * no mapping.
   */
  quote(cfg: SetConfig): Quote {
    const c = fullConfig(cfg);
    const p = this.getProduct(c.productId);
    const lines: QuoteLine[] = [];
    const missing: string[] = [];
    if (!p) return { lines, total: 0, currency: 'BYN', estimated: false, unpriced: [], complete: false, missing: ['product'] };
    const pushLine = (l: QuoteLine) => {
      if (!l.articleCode || !lines.some((x) => x.articleCode === l.articleCode)) lines.push(l);
    };
    const push = (component: Component, m: Mapping | undefined) => {
      if (!m) {
        missing.push(component);
        return;
      }
      pushLine({
        component,
        articleCode: m.articleCode,
        name: m.name ?? m.articleCode,
        price: m.priceBYN,
        url: m.url,
        image: m.image,
        estimated: m.match === 'estimated' && m.priceBYN > 0,
        unpriced: m.match === 'estimated' && m.priceBYN === 0,
        dimensionsCm: m.dimensionsCm as any,
      });
    };
    const sp = this.space(c.productId, c.sizeIndex);
    const ctx = { cabinetSizeIndex: c.sizeIndex };
    const hasTop = (sp?.countertop.length ?? 0) > 0;
    const bundle = hasTop
      ? this.data.bundles.find((b) => b.productId === c.productId && b.sizeIndex === c.sizeIndex && b.colourIndex === c.colourIndex && b.topSizeIndex === c.countertopSizeIndex && b.topColourIndex === c.countertopColourIndex)
      : undefined;
    if (bundle) {
      bundle.lines.forEach((l, i) =>
        pushLine({
          component: i === 0 ? 'cabinet' : 'countertop',
          articleCode: l.articleCode,
          name: l.name,
          price: l.priceBYN,
          url: l.url,
          image: l.image,
          dimensionsCm: l.dimensionsCm,
          estimated: l.match === 'estimated',
          ...(bundle.lines.length === 1 ? { includes: ['cabinet', 'countertop'] as Component[] } : {}),
        }),
      );
    } else {
      push('cabinet', this.mapping(c.productId, 'cabinet', c.sizeIndex, c.colourIndex));
      if (hasTop) push('countertop', this.mapping(c.productId, 'countertop', c.countertopSizeIndex, c.countertopColourIndex, ctx));
    }
    if (c.closetSizeIndex >= 0) push('closet', this.mapping(c.productId, 'closet', c.closetSizeIndex, c.closetColourIndex));
    const kind = this.topKind(c);
    if ((sp?.sink.length ?? 0) > 0 && kind === 'SurfaceMounted') push('sink', this.mapping(c.productId, 'sink', c.sinkSizeIndex, c.sinkColourIndex, ctx));
    if ((sp?.faucet[kind].length ?? 0) > 0) push('faucet', this.mapping(c.productId, 'faucet', c.faucetSizeIndex, c.faucetColourIndex, { ...ctx, topKind: kind }));
    if ((sp?.mirror.length ?? 0) > 0) push('mirror', this.mapping(c.productId, 'mirror', c.mirrorSizeIndex, c.mirrorColourIndex, ctx));
    const total = Math.round(lines.reduce((s, l) => s + l.price, 0) * 100) / 100;
    return { lines, total, currency: 'BYN', estimated: lines.some((l) => l.estimated), unpriced: lines.filter((l) => l.unpriced).map((l) => l.component), complete: missing.length === 0, missing };
  }

  /** Width along the wall used for pre-filtering before the authoritative UE check_fit. */
  footprintWidthCm(cfg: SetConfig): number | undefined {
    const c = fullConfig(cfg);
    const p = this.getProduct(c.productId);
    if (!p) return undefined;
    const s = p.cabinet.sizes.find((x) => x.index === c.sizeIndex);
    let w = s?.widthCm ?? this.mapping(c.productId, 'cabinet', c.sizeIndex, c.colourIndex)?.dimensionsCm?.width;
    if (w === undefined) return undefined;
    if (c.closetSizeIndex >= 0) {
      const cm = p.closetModels.find((x) => x.index === c.closetSizeIndex);
      w += cm?.widthCm ?? this.mapping(c.productId, 'closet', c.closetSizeIndex, c.closetColourIndex)?.dimensionsCm?.width ?? 0;
    }
    return w;
  }

  /**
   * Default shared-component choices for a cabinet size (resolved space): countertop model `topIndex` with a colour
   * matching `preferColour` if possible, the mirror whose width is closest to the cabinet, faucet/sink 0.
   */
  defaultsFor(productId: string, sizeIndex: number, opts: { topIndex?: number; preferColour?: string } = {}): Partial<SetConfig> | null {
    const p = this.getProduct(productId);
    const sp = this.space(productId, sizeIndex);
    if (!p || !sp) return null;
    const out: Partial<SetConfig> = {};
    if (sp.countertop.length) {
      const m = sp.countertop[Math.min(opts.topIndex ?? 0, sp.countertop.length - 1)];
      if (!m || m.colours.length === 0) return null;
      const pref = opts.preferColour ? m.colours.find((c) => c.name && c.name.toLowerCase().slice(0, 4) === opts.preferColour!.toLowerCase().slice(0, 4)) : undefined;
      out.countertopSizeIndex = m.index;
      out.countertopColourIndex = (pref ?? m.colours[0]).index;
    }
    if (sp.mirror.length) {
      const w = p.cabinet.sizes.find((s) => s.index === sizeIndex)?.widthCm ?? 80;
      let best = 0;
      let bestD = Infinity;
      for (const m of sp.mirror)
        if (m.widthCm !== undefined && Math.abs(m.widthCm - w) < bestD) {
          bestD = Math.abs(m.widthCm - w);
          best = m.index;
        }
      out.mirrorSizeIndex = best;
      out.mirrorColourIndex = 0;
    }
    out.sinkSizeIndex = 0;
    out.sinkColourIndex = 0;
    out.faucetSizeIndex = 0;
    out.faucetColourIndex = 0;
    return out;
  }

  colourName(cfg: SetConfig): string | undefined {
    const p = this.getProduct(cfg.productId);
    return p?.cabinet.colours.find((c) => c.index === cfg.colourIndex)?.name;
  }
  sizeName(cfg: SetConfig): string | undefined {
    const p = this.getProduct(cfg.productId);
    return p?.cabinet.sizes.find((s) => s.index === cfg.sizeIndex)?.name;
  }
  tiles(): { id: string; name: string }[] {
    return this.data.ue.tiles ?? [];
  }
  /** Collections that have a wall cabinet (for QA-003 answers). */
  collectionsWithCloset(): string[] {
    return this.listProducts()
      .filter((p) => p.closetModels.length > 0 && p.showInConstructor !== false)
      .map((p) => p.collection ?? p.productId);
  }

  /** Short Russian catalogue summary for the LLM system prompt (cached context). Prices from the index only. */
  summaryForPrompt(): string {
    const lines: string[] = [`Каталог (синхронизирован ${this.syncedAt}, цены в BYN):`];
    for (const p of this.listProducts()) {
      const sizes = p.cabinet.sizes.map((s) => s.name || `${s.widthCm ?? '?'} см`).join(', ');
      const colours = [...new Set(p.cabinet.colours.map((c) => c.name))].join(', ');
      const s0 = p.cabinet.sizes[0]?.index ?? 0;
      const q = this.quote({ productId: p.productId, sizeIndex: s0, colourIndex: this.colourIndicesForSize(p, s0)[0] ?? 0, ...(this.defaultsFor(p.productId, s0) ?? {}) });
      lines.push(
        `- ${p.collection ?? ''} [${p.productId}]${p.showInConstructor === false ? ' (скрыта в конструкторе)' : ''}: размеры ${sizes}; цвета ${colours}; навесной шкаф: ${p.closetModels.length ? 'есть' : 'нет'}; от ${q.total} BYN${q.estimated ? ' (цена уточняется)' : ''}`,
      );
    }
    return lines.join('\n');
  }
}
