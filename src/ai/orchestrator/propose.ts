import type { CatalogIndex } from '../catalog/index';
import { fullConfig, lcColour, tonesOf } from '../catalog/index';
import type { Quote, SetConfig } from '../catalog/types';
import { safeUri } from '../catalog/parse';

export interface ProposeArgs {
  budgetBYN?: number;
  style?: string; // light | dark | wood | white | grey | modern | warm | any
  collection?: string;
  withCloset?: boolean;
  segmentId?: number;
  excludeProductId?: string;
}
export interface Candidate {
  key: string;
  config: Required<SetConfig>;
  quote: Quote;
  widthCm?: number;
  colourName?: string;
  sizeName?: string;
  collection?: string;
  styleScore: number;
  topLabel?: string;
}
export interface FitResult {
  key: string;
  fits: boolean;
  placement?: { segmentId: number; side: 'left' | 'right'; offsetCm: number; spareCm: number; footprintCm?: any };
  reasonCode?: string;
  reason?: string;
}
export type Tier = 'best_fit' | 'best_value' | 'premium';
export const TIER_LABEL_RU: Record<Tier | 'single', string> = {
  best_fit: 'Лучше всего подходит',
  best_value: 'Выгодно',
  premium: 'Премиум',
  single: 'Вариант',
};

export interface Card {
  cardId: string;
  tier: Tier | 'single';
  tierLabel: string;
  title: string;
  collection: string;
  image: string;
  price: number;
  currency: 'BYN';
  spareCm: number;
  reason: string;
  config: Required<SetConfig>;
  placement: { segmentId?: number; side?: 'left' | 'right' | 'auto'; anchor?: 'centre' | 'start' | 'end' | 'auto'; offsetCm?: number };
  items: { component: string; articleCode: string; name: string; price: number; url?: string; dimensionsCm?: any }[];
  state: 'available';
  catalogSyncedAt: string;
  estimated?: boolean;
}

const STYLE_TONES: Record<string, string[]> = {
  light: ['light', 'white'],
  white: ['white'],
  dark: ['dark', 'black'],
  wood: ['wood'],
  grey: ['grey', 'neutral'],
  modern: ['modern', 'grey', 'neutral'],
  warm: ['warm', 'wood'],
};

export function styleScore(colourName: string | undefined, style?: string): number {
  if (!style || style === 'any') return 0.5;
  const want = STYLE_TONES[style] ?? [];
  const have = tonesOf(colourName);
  if (have.length === 0) return 0.3;
  return want.some((w) => have.includes(w)) ? 1 : 0;
}

/**
 * Candidate generation from the catalogue index: every product × cabinet size × colour valid for that size, with the
 * default shared components (index 0) and the wall cabinet on/off. Only fully priced configurations (all present
 * components mapped) are kept, so a card can never show an unpriced item. Estimated prices are allowed but flagged.
 */
export function generateCandidates(catalog: CatalogIndex, args: ProposeArgs, maxCandidates = 40): Candidate[] {
  const out: Candidate[] = [];
  for (const p of catalog.listProducts()) {
    if (p.showInConstructor === false && !(args.collection && p.collection === args.collection)) continue;
    if (!catalog.isCollectionEnabled(p.collection)) continue;
    if (args.excludeProductId && p.productId === args.excludeProductId) continue;
    if (args.collection && p.collection && p.collection.toLowerCase() !== args.collection.toLowerCase()) continue;
    for (const s of p.cabinet.sizes) {
      for (const ci of catalog.colourIndicesForSize(p, s.index)) {
        if (args.withCloset === true && p.closetModels.length === 0) continue; // QA-003: never fake a wall cabinet
        const closetOptions = p.closetModels.length === 0 ? [-1] : args.withCloset === true ? [0] : args.withCloset === false ? [-1] : [-1, 0];
        const sp = catalog.space(p.productId, s.index);
        const topOptions = sp?.countertop.length ? sp.countertop.map((m) => m.index) : [0];
        const wantWhite = args.style === 'light' || args.style === 'white';
        for (const top of topOptions)
        for (const closet of closetOptions) {
          const defaults = catalog.defaultsFor(p.productId, s.index, { topIndex: top, preferColour: wantWhite ? 'Бел' : catalog.colourName({ productId: p.productId, sizeIndex: s.index, colourIndex: ci }) });
          if (!defaults) continue;
          const cfg = fullConfig({ productId: p.productId, sizeIndex: s.index, colourIndex: ci, ...defaults, closetSizeIndex: closet, closetColourIndex: closet >= 0 ? bestClosetColour(p, ci) : 0 });
          if (catalog.validate(cfg)) continue;
          const quote = catalog.quote(cfg);
          if (!quote.complete || quote.total <= 0) continue;
          const colourName = catalog.colourName(cfg);
          out.push({
            key: `${p.productId}:${s.index}:${ci}:${top}:${closet}`,
            config: cfg,
            quote,
            widthCm: catalog.footprintWidthCm(cfg),
            colourName,
            sizeName: s.name,
            collection: p.collection,
            styleScore: styleScore(colourName, args.style),
            topLabel: sp?.countertop.length ? (sp.countertop[top]?.kind === 'BuiltIn' ? 'с раковиной' : 'со столешницей') : undefined,
          });
        }
      }
    }
  }
  // Pre-rank so the 40 sent to the fit dry run are the most relevant: style first, then budget distance.
  const b = args.budgetBYN;
  out.sort((x, y) => {
    const bx = b === undefined ? 0 : x.quote.total <= b ? 0 : 1;
    const by = b === undefined ? 0 : y.quote.total <= b ? 0 : 1;
    return bx - by || y.styleScore - x.styleScore || (b === undefined ? x.quote.total - y.quote.total : Math.abs(b - x.quote.total) - Math.abs(b - y.quote.total));
  });
  return out.slice(0, maxCandidates);
}

function bestClosetColour(p: { closetModels: { colours: { index: number; name: string }[] }[]; cabinet: { colours: { index: number; name: string }[] } }, cabinetColourIndex: number): number {
  const cabName = p.cabinet.colours.find((c) => c.index === cabinetColourIndex)?.name?.toLowerCase() ?? '';
  const colours = p.closetModels[0]?.colours ?? [];
  const same = colours.find((c) => c.name && cabName && c.name.toLowerCase().split(/\s+/)[0] === cabName.split(/\s+/)[0]);
  return same?.index ?? colours[0]?.index ?? 0;
}

export function reasonRu(c: Candidate, spareCm: number, args: ProposeArgs, tier: Tier): string {
  const parts: string[] = [];
  if (args.style && args.style !== 'any' && c.styleScore >= 1 && c.colourName) parts.push(`${c.colourName} — в выбранном стиле`);
  else if (c.colourName) parts.push(`цвет ${lcColour(c.colourName)}`);
  parts.push(`на стене остаётся ${Math.round(spareCm)} см`);
  if (args.budgetBYN !== undefined) {
    const d = Math.round(args.budgetBYN - c.quote.total);
    parts.push(d >= 0 ? `в рамках бюджета, запас ${d} BYN` : `выше бюджета на ${-d} BYN`);
  }
  if (tier === 'best_value') parts.push('самый доступный из подходящих');
  if (tier === 'premium' && c.config.closetSizeIndex >= 0) parts.push('с навесным шкафом');
  if (c.quote.estimated) parts.push('цена уточняется');
  else if (c.quote.unpriced.length) parts.push(`цена: ${c.quote.unpriced.map((u) => (u === 'mirror' ? 'зеркало' : u === 'sink' ? 'раковина' : u)).join(', ')} — уточняется`);
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Picks up to three distinct fit-checked candidates. Rules: only fits=true; with a budget every card is within it;
 * best_fit = best style match, then the fullest use of the wall, then price nearest the budget; best_value = cheapest;
 * premium = most expensive remaining (prefers a wall cabinet). Never a failed or unpriced configuration.
 */
export function rankTiers(cands: Candidate[], fits: FitResult[], args: ProposeArgs): { tier: Tier; cand: Candidate; fit: FitResult }[] {
  const fitByKey = new Map(fits.map((f) => [f.key, f]));
  let ok = cands
    .map((c) => ({ c, f: fitByKey.get(c.key) }))
    .filter((x): x is { c: Candidate; f: FitResult } => !!x.f && x.f.fits === true && !!x.f.placement);
  if (args.budgetBYN !== undefined) ok = ok.filter((x) => x.c.quote.total <= args.budgetBYN!);
  if (ok.length === 0) return [];
  const used = new Set<string>();
  const res: { tier: Tier; cand: Candidate; fit: FitResult }[] = [];
  const take = (tier: Tier, sorted: typeof ok) => {
    const x2 = sorted.find((y) => !used.has(y.c.key) && !res.some((r) => sameLook(r.cand, y.c)));
    if (x2) {
      used.add(x2.c.key);
      res.push({ tier, cand: x2.c, fit: x2.f });
    }
  };
  const b = args.budgetBYN;
  take(
    'best_fit',
    [...ok].sort(
      (x, y) =>
        y.c.styleScore - x.c.styleScore ||
        Number(x.c.quote.estimated) - Number(y.c.quote.estimated) ||
        (x.f.placement!.spareCm - y.f.placement!.spareCm) ||
        (b === undefined ? 0 : Math.abs(b - x.c.quote.total) - Math.abs(b - y.c.quote.total)),
    ),
  );
  take('best_value', [...ok].sort((x, y) => Number(x.c.quote.estimated) - Number(y.c.quote.estimated) || x.c.quote.total - y.c.quote.total || y.c.styleScore - x.c.styleScore));
  take(
    'premium',
    [...ok].sort((x, y) => Number(x.c.quote.estimated) - Number(y.c.quote.estimated) || y.c.quote.total - x.c.quote.total || Number(y.c.config.closetSizeIndex >= 0) - Number(x.c.config.closetSizeIndex >= 0)),
  );
  return res;
}

/** Two cards look the same to a visitor when collection, size, colour and wall cabinet match, or title and price match. */
function sameLook(a: Candidate, b: Candidate) {
  const same = a.config.productId === b.config.productId && a.config.sizeIndex === b.config.sizeIndex && a.config.colourIndex === b.config.colourIndex && (a.config.closetSizeIndex >= 0) === (b.config.closetSizeIndex >= 0);
  return same || (a.quote.total === b.quote.total && a.config.productId === b.config.productId && a.config.sizeIndex === b.config.sizeIndex);
}

/** v2.0 salon: an INFORMATION card (no placement, no fit check) — same card contract, placement {} and spareCm 0. */
export function buildInfoCard(c: Candidate, tier: Tier, syncedAt: string, id: string): Card {
  const card = buildCard({ tier, cand: c, fit: { key: c.key, fits: true, placement: { segmentId: 0, side: 'left', offsetCm: 0, spareCm: 0 } } as any }, {}, syncedAt, id);
  const cab = c.quote.lines.find((l) => l.component === 'cabinet')?.dimensionsCm;
  return {
    ...card,
    spareCm: 0,
    placement: {},
    reason: cab?.width ? ['Ширина ' + Math.round(cab.width) + ' см', cab.depth ? 'глубина ' + Math.round(cab.depth) + ' см' : '', cab.height ? 'высота ' + Math.round(cab.height) + ' см' : ''].filter(Boolean).join(', ') : 'Цена из каталога oliveeka.by',
  } as Card;
}

export function buildCard(r: { tier: Tier; cand: Candidate; fit: FitResult }, args: ProposeArgs, syncedAt: string, id: string, single = false): Card {
  const c = r.cand;
  const pl = r.fit.placement!;
  const first = c.quote.lines[0];
  const closet = c.config.closetSizeIndex >= 0 ? ', с навесным шкафом' : '';
  const size = c.sizeName || (c.widthCm ? `${Math.round(c.widthCm)}` : '');
  const tier: Tier | 'single' = single ? 'single' : r.tier;
  return {
    cardId: id,
    tier,
    tierLabel: TIER_LABEL_RU[tier],
    title: `${c.collection ?? ''} ${size}, ${lcColour(c.colourName)}${c.topLabel ? `, ${c.topLabel}` : ''}${closet}`.replace(/\s+/g, ' ').trim(),
    collection: c.collection ?? 'Milu',
    image: safeUri(first?.image ?? c.quote.lines.find((l) => l.image)?.image ?? 'https://oliveeka.by/'),
    price: c.quote.total,
    currency: 'BYN',
    spareCm: Math.round(pl.spareCm),
    reason: reasonRu(c, pl.spareCm, args, r.tier),
    config: c.config,
    placement: { segmentId: pl.segmentId, side: pl.side, offsetCm: pl.offsetCm },
    items: c.quote.lines.map((l) => ({ component: l.component, articleCode: l.articleCode, name: l.name, price: l.price, ...(l.url ? { url: l.url } : {}), ...(l.dimensionsCm ? { dimensionsCm: l.dimensionsCm } : {}) })),
    state: 'available',
    catalogSyncedAt: syncedAt,
    ...(c.quote.estimated ? { estimated: true } : {}),
  };
}
