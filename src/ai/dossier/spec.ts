import type { CatalogIndex } from '../catalog/index';
import { componentLabel, componentLabelRu, fullConfig } from '../catalog/index';
import { t, type Lang } from '../i18n';
import { colourLabel, tileName } from '../i18n/names';
import type { Quote, SetConfig } from '../catalog/types';

/** A save record as posted by UE to /api/saves (SaveSystemWidget + the `metrics` block of dossier-api.schema.json). */
export interface SaveRecord {
  saveId: string;
  saveName?: string;
  date?: string;
  planner?: any;
  thumbnail?: string;
  boothStates?: { boothName?: string; plannerInstanceId?: string; state?: Record<string, any>; customColors?: any[] }[];
  metrics?: {
    plannerInstanceId?: string;
    perimeterM?: number;
    floorAreaM2?: number;
    wallFaces?: { segmentId: number; side: 'left' | 'right'; areaM2?: number; finish?: string }[];
    sets?: { setId?: string; config?: SetConfig; productName?: string; sku?: string; customColours?: { component: string; rgb?: string; code?: string }[] }[];
    layoutJson?: string;
  };
}

export interface SpecSet {
  setId: string;
  title: string;
  config: Required<SetConfig>;
  quote: Quote;
  customColours: { component: string; rgb?: string; code?: string }[];
}
export interface Spec {
  sets: SpecSet[];
  total: number;
  hasEstimated: boolean;
  hasUnpriced: boolean;
  finishes: { surface: string; label: string; areaM2?: number }[];
  floorAreaM2?: number;
  perimeterM?: number;
  layout: any | null;
  plannerInstanceId?: string;
  source: 'metrics' | 'boothStates';
  /** v2.5: the language the spec (titles, finishes) is written in. */
  lang?: Lang;
}

/** boothStates[].state (SaveSystemWidget field names) -> commands config. */
export function stateToConfig(s: Record<string, any>): SetConfig {
  return {
    productId: String(s.productID ?? s.productId ?? ''),
    sizeIndex: Number(s.activeSizeIndex ?? 0),
    colourIndex: Number(s.activeColorIndex ?? 0),
    countertopSizeIndex: Number(s.countertopSizeIndex ?? 0),
    countertopColourIndex: Number(s.activeCountertopColorIndex ?? 0),
    closetSizeIndex: Number(s.closetSizeIndex ?? -1),
    closetColourIndex: Number(s.closetColorIndex ?? 0),
    sinkSizeIndex: Number(s.sinkSizeIndex ?? 0),
    sinkColourIndex: Number(s.sinkColorIndex ?? 0),
    faucetSizeIndex: Number(s.faucetSizeIndex ?? 0),
    faucetColourIndex: Number(s.faucetColorIndex ?? 0),
    mirrorSizeIndex: Number(s.mirrorSizeIndex ?? 0),
    mirrorColourIndex: Number(s.mirrorColorIndex ?? 0),
  };
}

/** QA-036: tiles by display name («Серый керамогранит 60×60»), never the DT_PlannerTiles row id. */
function finishLabel(f: any, tiles: { id: string; name: string }[] = [], lang: Lang = 'ru'): string | null {
  const tn = (id: string) => tileName(lang, id, tiles.find((x) => x.id === id)?.name ?? id);
  if (!f || typeof f !== 'object') {
    if (typeof f !== 'string' || !f) return null;
    return /^Tile_/.test(f) ? t(lang, 'finish.tile', { name: tn(f) }) : f;
  }
  if (f.code) return t(lang, 'finish.paint', { code: f.code });
  if (f.colorCode) return t(lang, 'finish.paint', { code: f.colorCode });
  if (f.tileId || f.tile) return t(lang, 'finish.tile', { name: tn(f.tileId ?? f.tile) });
  return null;
}

/**
 * Specification: only the planner booths of the visitor's planner instance (never salon booths). Prefers
 * metrics.sets (built by UE for this instance); falls back to boothStates with a plannerInstanceId (matching
 * metrics.plannerInstanceId when given). Prices from the catalogue index only.
 */
export function buildSpec(save: SaveRecord, catalog: CatalogIndex, lang: Lang = 'ru'): Spec {
  const m = save.metrics ?? {};
  let raw: { setId: string; config: SetConfig; customColours: any[] }[] = [];
  let source: Spec['source'] = 'metrics';
  if (m.sets?.length) {
    raw = m.sets.filter((s) => s.config?.productId).map((s, i) => ({ setId: s.setId ?? `set-${i + 1}`, config: s.config!, customColours: s.customColours ?? [] }));
  } else {
    source = 'boothStates';
    raw = (save.boothStates ?? [])
      .filter((b) => b.plannerInstanceId && (!m.plannerInstanceId || b.plannerInstanceId === m.plannerInstanceId) && b.state)
      .map((b, i) => ({ setId: b.boothName ?? `set-${i + 1}`, config: stateToConfig(b.state!), customColours: b.customColors ?? [] }));
  }
  const sets: SpecSet[] = raw
    .filter((r) => catalog.getProduct(r.config.productId))
    .map((r) => {
      const cfg = fullConfig(r.config);
      const p = catalog.getProduct(cfg.productId)!;
      const closet = cfg.closetSizeIndex >= 0 ? t(lang, 'title.withCloset') : '';
      return {
        setId: r.setId,
        title: t(lang, 'dossier.setTitle', { collection: p.collection ?? cfg.productId, size: catalog.sizeName(cfg) ?? '', colour: colourLabel(lang, catalog.colourName(cfg)), closet }).replace(/\s+/g, ' ').replace(/ ,/g, ','),
        config: cfg,
        quote: catalog.quote(cfg),
        customColours: r.customColours,
      };
    });
  let layout: any = null;
  try {
    layout = m.layoutJson ? JSON.parse(m.layoutJson) : save.planner ?? null;
  } catch {
    layout = save.planner ?? null;
  }
  const finishes: Spec['finishes'] = [];
  const tiles = catalog.tiles();
  for (const f of m.wallFaces ?? []) if (f.finish) finishes.push({ surface: t(lang, 'surface.wallSide', { id: f.segmentId, left: f.side === 'left' }), label: finishLabel(f.finish, tiles, lang) ?? f.finish, areaM2: f.areaM2 });
  if (!finishes.length && layout?.walls) {
    const seen = new Set<string>();
    for (const w of layout.walls) for (const f of [w.finish, w.finishRight]) {
      const l = finishLabel(f, tiles, lang);
      if (l && !seen.has(l)) {
        seen.add(l);
        finishes.push({ surface: t(lang, 'surface.walls'), label: l });
      }
    }
  }
  for (const r of layout?.rooms ?? []) {
    const l = finishLabel(r.finish, tiles, lang);
    if (l) finishes.push({ surface: t(lang, 'surface.floor'), label: l });
  }
  const total = Math.round(sets.reduce((a, s) => a + s.quote.total, 0) * 100) / 100;
  return {
    sets,
    total,
    hasEstimated: sets.some((s) => s.quote.estimated),
    hasUnpriced: sets.some((s) => s.quote.unpriced.length > 0),
    finishes,
    floorAreaM2: m.floorAreaM2,
    perimeterM: m.perimeterM,
    layout,
    plannerInstanceId: m.plannerInstanceId,
    source,
    ...(lang !== 'ru' ? { lang } : {}),
  };
}

export const componentRu = componentLabelRu;
export const componentName = (c: Parameters<typeof componentLabel>[0], lang: Lang = 'ru') => componentLabel(c, lang);
