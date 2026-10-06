import fs from 'fs';
import path from 'path';
import { deepParseUe } from './ueText';
import { COLLECTIONS, Collection, detectCollection, ScrapedProduct } from './parse';
import type { BaseLine, Bundle, CatalogIndexData, Component, Mapping, MatchKind, ResolvedModel, ResolvedSpace, SharedComponent, UeColour, UeProduct, UeSharedRow } from './types';

/* ───────────────────────── UE export loader ───────────────────────── */

const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
const str = (x: any): string => (typeof x === 'string' ? x.trim() : '');
const baseName = (p: string) => (p || '').split('/').pop()?.split('.')[0] ?? '';

const FAUCET_THUMB_COLOUR: Record<string, string> = { silver: 'Хром', chrome: 'Хром', gold: 'Золотой матовый', black: 'Черный матовый', nickel: 'Никель матовый', gunmetal: 'Матовый оружейный металл' };

/** "Тумба под раковину Oliveeka Milu Орех 80" -> "Орех" */
export function colourFromName(name: string, collection?: string): string {
  let s = name.replace(/\s+/g, ' ');
  if (collection) {
    const i = s.toLowerCase().indexOf(collection.toLowerCase());
    if (i >= 0) s = s.slice(i + collection.length);
  }
  const m = s.match(/([А-ЯЁ][а-яё]+(?:\s+[а-яё]+)?)/);
  return m ? m[1].trim() : '';
}

/** "Столешница Oliveeka Milu 18 мм Белая, 2 выреза, 800х500 мм" -> "Белая"; basin names -> "белая" */
export function topColourFromName(name: string): string {
  const m = name.match(/мм\s+([А-ЯЁа-яё]+)/) ?? name.match(/(белая|белый|серая|серый|орех|дуб|палисандр|темный коричневый|коричнев[а-я]+)/i);
  return m ? m[1] : '';
}

const COLOUR_WORDS: Record<string, string> = {
  black: 'Чёрный', white: 'Белый', grey: 'Серый', gray: 'Серый', beige: 'Бежевый', oak: 'Дуб', walnut: 'Орех', brown: 'Коричневый',
  green: 'Зелёный', blue: 'Синий', red: 'Красный', orange: 'Оранжевый', graphite: 'Графит', concrete: 'Бетон', sand: 'Песочный',
  mdf: 'МДФ', matte: 'матовый', matt: 'матовый', gloss: 'глянцевый', glossy: 'глянцевый',
};
/** Visitor-facing colour name: DataTable names that are raw ids (Latin, e.g. «Black_MDF») become Russian («Чёрный МДФ»). */
export function ruColourName(raw: string, index?: number): string {
  const s = (raw ?? '').trim();
  if (!s || /[А-Яа-яЁё]/.test(s)) return s;
  const words = s.split(/[_\s-]+/).map((w) => COLOUR_WORDS[w.toLowerCase()]).filter(Boolean);
  return words.length ? words.join(' ') : index !== undefined ? `Цвет ${index + 1}` : '';
}

function colours(list: any, fallbackName: string): UeColour[] {
  const a = arr(list);
  if (a.length === 0) return [{ index: 0, name: fallbackName, sizeIndices: [] }];
  return a.map((c: any, index: number) => ({
    index,
    name: ruColourName(str(c.ProductName), index) || fallbackName,
    productName: str(c.ProductName) || undefined,
    sku: str(c.SKU) || undefined,
    url: str(c.URL) || undefined,
    sizeIndices: arr(c.SizeIndices).filter((x: any) => typeof x === 'number'),
    thumbnail: str(c.Thumbnail) || undefined,
  }));
}

export interface UeExport {
  products: UeProduct[];
  shared: UeSharedRow[];
  skipped: { productId: string; reason: string }[];
  issues: string[];
  tiles: { id: string; name: string }[];
  exportedAt?: string;
}

/** Colours visible for a cabinet size (booth FilterColors), re-indexed; implicit single colour when the row has none. */
function filterColours(cs: UeColour[], cabinetSize: number): UeColour[] {
  return cs.filter((c) => !c.sizeIndices?.length || c.sizeIndices.includes(cabinetSize)).map((c, i) => ({ ...c, index: i, rawIndex: c.index }));
}

/**
 * Mirrors AShowroomBooth::GetResolvedComponentOptions (ShowroomBooth.cpp:581) for one cabinet size:
 * - dangling Allowed ids are skipped (models re-indexed in the order of the found rows);
 * - colours filtered by SizeIndices and re-indexed;
 * - a BuiltIn countertop with no mesh for the size falls back to the first SurfaceMounted allowed row that has one;
 * - faucets are split by countertop type: BuiltIn -> Integrated rows, SurfaceMounted -> Standard rows.
 */
export function resolveSpace(p: { allowed: Record<SharedComponent, string[]> }, shared: UeSharedRow[], s: number, issues?: string[], productId = ''): ResolvedSpace {
  const find = (comp: SharedComponent, id: string) => shared.find((r) => r.component === comp && r.id === id);
  const models = (comp: SharedComponent, filter?: (r: UeSharedRow) => boolean): ResolvedModel[] => {
    const out: ResolvedModel[] = [];
    for (const id of p.allowed[comp]) {
      const r = find(comp, id);
      if (!r) continue;
      if (filter && !filter(r)) continue;
      let row = r;
      let kind = r.kind;
      let fallbackFrom: string | undefined;
      if (comp === 'countertop') {
        const hasMesh = !!(r.meshes?.[s] ?? '').trim();
        if (!hasMesh && r.kind === 'BuiltIn') {
          const fb = p.allowed.countertop.map((x) => find('countertop', x)).find((x) => x && x.kind === 'SurfaceMounted' && !!(x.meshes?.[s] ?? '').trim());
          if (fb) {
            row = fb;
            kind = 'SurfaceMounted';
            fallbackFrom = fb.id;
          } else issues?.push(`${productId}: countertop ${r.id} has no mesh for size ${s} and no SurfaceMounted fallback.`);
        }
      }
      let cs = filterColours(row.colours, s);
      if (cs.length === 0) cs = []; // booth: a model with no colour for this size offers no colour option
      out.push({ index: out.length, rowId: r.id, kind, name: row.name, widthCm: row.widthCm, heightCm: row.heightCm, depthCm: row.depthCm, ...(fallbackFrom ? { fallbackFrom } : {}), colours: cs });
    }
    return out;
  };
  return {
    countertop: models('countertop'),
    sink: models('sink'),
    faucet: { SurfaceMounted: models('faucet', (r) => r.kind === 'Standard'), BuiltIn: models('faucet', (r) => r.kind === 'Integrated') },
    mirror: models('mirror'),
  };
}

export function loadUeExport(dir: string): UeExport {
  const read = (n: string) => {
    const f = path.join(dir, n);
    return fs.existsSync(f) ? deepParseUe(JSON.parse(fs.readFileSync(f, 'utf8'))) : [];
  };
  const bounds: Record<string, { sizeCm: number[] }> = {};
  for (const n of ['mesh_bounds.json', 'mesh_bounds_2.json']) {
    const f = path.join(dir, n);
    if (fs.existsSync(f)) Object.assign(bounds, JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  const bx = (mesh: string) => bounds[mesh]?.sizeCm;
  const issues: string[] = [];
  const skipped: { productId: string; reason: string }[] = [];
  const shared: UeSharedRow[] = [];
  const addShared = (file: string, component: SharedComponent) => {
    for (const r of arr(read(file))) {
      const meshes = r.Mesh ? [str(r.Mesh)] : arr(r.Sizes).map(str);
      const b = bx(meshes.find(Boolean) ?? '');
      let cols = colours(r.Colors, '');
      if (component === 'faucet') {
        cols = cols.map((c) => {
          const t = baseName(c.thumbnail ?? '').toLowerCase();
          return { ...c, name: c.name || FAUCET_THUMB_COLOUR[t] || t };
        });
      }
      if (component === 'countertop' || component === 'sink') cols = cols.map((c) => ({ ...c, name: topColourFromName(c.name) || c.name }));
      shared.push({
        id: str(r.Name),
        component,
        name: component === 'countertop' || component === 'sink' ? str(arr(r.Colors)[0]?.ProductName) || baseName(meshes[0]) : baseName(meshes[0]),
        widthCm: b ? Math.round(b[0]) : undefined,
        heightCm: b ? Math.round(b[2]) : undefined,
        depthCm: b ? Math.round(b[1]) : undefined,
        kind: str(r.CountertopType) || str(r.FaucetType) || undefined,
        meshes: meshes.map(baseName),
        colours: cols,
      });
    }
  };
  addShared('DT_SharedCountertops.json', 'countertop');
  addShared('DT_SharedSinks.json', 'sink');
  addShared('AllowedFaucetIDs.json', 'faucet');
  addShared('AllowedMirrorIDs.json', 'mirror');

  const products: UeProduct[] = [];
  for (const r of arr(read('DT_FurnitureCatalog.json'))) {
    const id = str(r.Name);
    const collection = (COLLECTIONS as readonly string[]).includes(id) ? (id as Collection) : detectCollection(id);
    if (!collection) {
      skipped.push({ productId: id, reason: 'не коллекция мебели для ванной (нет в Milu/Urban/Avenu/Terra/Tuma)' });
      continue;
    }
    const co = r.CabinetOptions ?? {};
    const cabinetSkus: Record<string, string> = {};
    let comboName = '';
    for (const m of arr(co.CombinationsMetadata)) {
      const sku = str(m.Metadata?.SKU);
      if (sku) cabinetSkus[`${m.SizeIndex}:${m.ColorIndex}`] = sku;
      if (!comboName && /Oliveeka/.test(str(m.Metadata?.ProductName))) comboName = str(m.Metadata?.ProductName);
    }
    const defaultColour = colourFromName(comboName, collection);
    const meshes = arr(co.Sizes).map(str);
    const sizes = arr(co.SizeNames).map((n: any, index: number) => {
      const name = str(n);
      const fromName = Number((name.match(/\d+/) ?? [])[0]);
      const b = bx(meshes[index]);
      return { index, name, widthCm: Number.isFinite(fromName) && fromName > 0 ? fromName : b ? Math.round(b[0]) : undefined, depthCm: b ? Math.round(b[1]) : undefined, heightCm: b ? Math.round(b[2]) : undefined };
    });
    const closetSkus: Record<string, string> = {};
    for (const m of arr(r.ClosetOptions?.CombinationsMetadata)) {
      const sku = str(m.Metadata?.SKU);
      if (sku) closetSkus[`${m.SizeIndex}:${m.ColorIndex}`] = sku;
    }
    const closetModels = arr(r.ClosetOptions?.Models).map((m: any, index: number) => {
      const b = bx(str(m.Mesh));
      return { index, name: baseName(str(m.Mesh)), widthCm: b ? Math.round(b[0]) : undefined, heightCm: b ? Math.round(b[2]) : undefined, colours: colours(m.Colors, defaultColour) };
    });
    const ids = (x: any) => arr(x).map(str).filter(Boolean);
    const allowed = { countertop: ids(r.AllowedCountertopIDs), sink: ids(r.AllowedSinkIDs), faucet: ids(r.AllowedFaucetIDs), mirror: ids(r.AllowedMirrorIDs) };
    for (const comp of ['countertop', 'sink', 'faucet', 'mirror'] as SharedComponent[])
      allowed[comp].forEach((x, i) => {
        if (!shared.some((s) => s.component === comp && s.id === x)) issues.push(`${id}: Allowed ${comp} id ${x} (DataTable position ${i}) is not in the exported table — the booth skips it (QA-001).`);
      });
    const resolved: Record<string, ResolvedSpace> = {};
    for (const s of sizes) resolved[String(s.index)] = resolveSpace({ allowed }, shared, s.index, issues, id);
    products.push({
      productId: id,
      collection,
      displayName: `Oliveeka ${collection}`,
      cabinet: { sizes, colours: colours(co.Colors, defaultColour) },
      closetModels,
      allowed,
      showInConstructor: r.ShowInConstructor !== false,
      cabinetSkus,
      closetSkus,
      resolved,
    });
  }
  let exportedAt: string | undefined;
  const log = path.join(dir, 'export_log.txt');
  if (fs.existsSync(log)) exportedAt = fs.statSync(log).mtime.toISOString();
  const tiles = arr(read('DT_PlannerTiles.json')).map((t: any) => ({ id: str(t.Name), name: str(t.DisplayName) || str(t.Name) }));
  return { products, shared, skipped, issues, tiles, exportedAt };
}

/** QA-024: visitor-facing names, never UE asset names. */
export function sinkNameRu(c: UeColour): string {
  const n = (c.productName ?? '').replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim();
  const sku = (c.sku ?? '').trim();
  return (n || 'Раковина накладная Oliveeka') + (sku && !n.includes(sku) ? ` ${sku}` : '');
}
export function mirrorNameRu(m: { widthCm?: number; heightCm?: number; depthCm?: number }): string {
  const w = m.widthCm;
  const h = m.heightCm;
  const size = w && h ? ` ${w} × ${h} см` : w ? ` ${w} см` : '';
  return `Зеркало${size}`.trim(); // only what the 3D bounds tell; model name unknown (flagged in the note)
}

/* ───────────────────────── mapping builder ───────────────────────── */

const PREFIX: Record<string, string> = { Milu: 'MIL', Urban: 'URB', Avenu: 'AVE', Terra: 'TER', Tuma: 'TUM' };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
/** Same colour ignoring gender/case endings: «Белая» ~ «Белый», «Серая» ~ «Серый». */
export function sameColour(a?: string, b?: string) {
  if (!a || !b) return false;
  const x = norm(a).slice(0, 4);
  const y = norm(b).slice(0, 4);
  return x.length >= 3 && x === y;
}

export interface BuildResult {
  index: CatalogIndexData;
  report: string;
}

const line = (p: ScrapedProduct, match: MatchKind, note?: string): BaseLine => ({
  articleCode: p.articleCode,
  name: p.name,
  priceBYN: p.priceBYN,
  url: p.url,
  image: p.images?.[0],
  dimensionsCm: p.dimensionsCm,
  match,
  ...(note ? { note } : {}),
});

export function buildCatalogIndex(ue: UeExport, scraped: { syncedAt: string; source: string; products: ScrapedProduct[] }): BuildResult {
  const byCode = new Map(scraped.products.map((p) => [p.articleCode.replace(/\s+/g, ''), p]));
  const mappings: Mapping[] = [];
  const bundles: Bundle[] = [];
  const unmapped: CatalogIndexData['unmapped'] = [];
  const issues = [...ue.issues];
  const cheapest = (ps: ScrapedProduct[]) => [...ps].sort((a, b) => a.priceBYN - b.priceBYN)[0];
  const widthOf = (p: ScrapedProduct) => p.dimensionsCm?.width ?? Number(p.sizeLabel) ?? 0;
  const siblingByWidth = (w: number | undefined, cats: string[]) => {
    const ps = scraped.products.filter((p) => cats.includes(p.category ?? ''));
    if (!ps.length || !w) return undefined;
    const best = Math.min(...ps.map((p) => Math.abs(widthOf(p) - w)));
    return cheapest(ps.filter((p) => Math.abs(widthOf(p) - w) === best));
  };
  const img = (p?: ScrapedProduct) => p?.images?.[0];
  const add = (m: Mapping) => mappings.push(m);

  for (const p of ue.products) {
    const col = p.collection!;
    const prefix = PREFIX[col];
    const siteCabinets = scraped.products.filter((x) => x.collection === col && (x.category === 'cabinet' || x.category?.startsWith('cabinet_')));
    const siteColour = siteCabinets[0]?.colour;
    // QA-002: trust a DataTable SKU only if it has the collection prefix; otherwise match by collection + size + colour.
    const cabSku = (s: number) => {
      const size = p.cabinet.sizes.find((x) => x.index === s);
      const raw = Object.entries(p.cabinetSkus ?? {})
        .filter(([k]) => k.startsWith(`${s}:`))
        .map(([, v]) => v.replace(/\s+/g, ''))
        .find((v) => prefix && v.startsWith(prefix));
      if (Object.entries(p.cabinetSkus ?? {}).some(([k, v]) => k.startsWith(`${s}:`) && prefix && !v.replace(/\s+/g, '').startsWith(prefix)))
        issues.push(`${p.productId}: CombinationsMetadata size ${s} carries a SKU of another collection (QA-002) — ignored.`);
      if (raw) return raw;
      // By collection + size: a standalone «Тумба под раковину» of this collection and width.
      const byName = scraped.products.find((x) => x.collection === col && x.category === 'cabinet' && Math.abs(widthOf(x) - (size?.widthCm ?? 0)) <= 2);
      return byName?.articleCode ?? '';
    };

    // ── cabinet (colourIndex = full CabinetOptions.Colors index, as the booth uses it) ──
    for (const s of p.cabinet.sizes) {
      const sku = cabSku(s.index);
      const standalone = sku ? byCode.get(sku) : undefined;
      const bs = sku ? scraped.products.filter((x) => x.articleCode.startsWith(sku + '+')) : [];
      for (const c of p.cabinet.colours.filter((x) => !x.sizeIndices?.length || x.sizeIndices.includes(s.index))) {
        const colourOk = p.cabinet.colours.length === 1 || !siteColour || sameColour(c.name, siteColour);
        const base = { productId: p.productId, collection: col, component: 'cabinet' as Component, sizeIndex: s.index, sizeName: s.name, colourIndex: c.index, colourName: c.name };
        const src = standalone ?? (bs.length ? cheapest(bs) : undefined);
        if (src) {
          const match: MatchKind = colourOk ? (standalone ? 'exact_sku' : 'exact_sku') : 'estimated';
          add({
            ...base,
            articleCode: sku,
            partCode: sku,
            priceBYN: src.priceBYN,
            name: standalone?.name ?? `Тумба под раковину Oliveeka ${col} ${s.name}`,
            url: src.url,
            image: img(src),
            dimensionsCm: src.dimensionsCm,
            match,
            ...(colourOk ? (standalone ? {} : { note: `отдельно не продаётся; цена комплекта ${src.articleCode}` }) : { estimatedFrom: src.articleCode, note: `цвет «${c.name}» нет на сайте, цена как у «${siteColour}»` }),
          });
        } else {
          const sib = siblingByWidth(s.widthCm, ['cabinet']) ?? siblingByWidth(s.widthCm, ['cabinet_with_countertop']);
          if (sib) add({ ...base, articleCode: sku /* DataTable code (TER70R…) or '' = «артикул уточняется» */, priceBYN: sib.priceBYN, name: `Тумба под раковину Oliveeka ${col} ${s.name}, ${c.name}`, url: sib.url, image: img(sib), match: 'estimated', estimatedFrom: sib.articleCode, note: `${col} нет на oliveeka.by; цена ближайшей по ширине тумбы` });
          else unmapped.push({ productId: p.productId, component: 'cabinet', sizeIndex: s.index, colourIndex: c.index, reason: 'нет товара и нет аналога' });
        }
      }
    }

    // ── closet (raw ClosetOptions; QA-002: match by collection + component + colour, not by the DataTable SKU) ──
    const siteCloset = scraped.products.find((x) => x.collection === col && x.category === 'closet');
    for (const m of p.closetModels) {
      for (const c of m.colours) {
        const base = { productId: p.productId, collection: col, component: 'closet' as Component, sizeIndex: m.index, sizeName: `${m.widthCm ?? ''}×${m.heightCm ?? ''}`, colourIndex: c.index, colourName: c.name };
        const sku = (p.closetSkus?.[`${m.index}:${c.index}`] ?? '').replace(/\s+/g, '');
        if (sku && siteCloset && sku !== siteCloset.articleCode) issues.push(`${p.productId}: closet metadata SKU "${sku}" is not a wall-cabinet article (QA-002); matched by collection: ${siteCloset.articleCode}.`);
        if (siteCloset) {
          const colourOk = m.colours.length === 1 || sameColour(c.name, siteCloset.colour);
          add({ ...base, articleCode: siteCloset.articleCode, priceBYN: siteCloset.priceBYN, name: siteCloset.name, url: siteCloset.url, image: img(siteCloset), dimensionsCm: siteCloset.dimensionsCm, match: colourOk ? (sku === siteCloset.articleCode ? 'exact_sku' : 'name_size_colour') : 'estimated', ...(colourOk ? {} : { estimatedFrom: siteCloset.articleCode, note: `цвет «${c.name}» нет на сайте` }) });
        } else {
          const sib = cheapest(scraped.products.filter((x) => x.category === 'closet'));
          if (sib) add({ ...base, articleCode: '', priceBYN: sib.priceBYN, name: `Шкаф навесной Oliveeka ${col}`, url: sib.url, image: img(sib), match: 'estimated', estimatedFrom: sib.articleCode, note: 'нет на oliveeka.by' });
          else unmapped.push({ productId: p.productId, component: 'closet', sizeIndex: m.index, colourIndex: c.index, reason: 'нет товара' });
        }
      }
    }

    // ── shared components in the booth-resolved space, per cabinet size ──
    for (const s of p.cabinet.sizes) {
      const rs = p.resolved[String(s.index)];
      const sku = cabSku(s.index);
      // countertop (and bundles)
      for (const m of rs.countertop) {
        if (m.colours.length === 0) {
          unmapped.push({ productId: p.productId, component: 'countertop', cabinetSizeIndex: s.index, sizeIndex: m.index, colourIndex: 0, reason: `у ${m.rowId} нет цвета для размера ${s.name}` });
          continue;
        }
        for (const c of m.colours) {
          const r = resolveTop(p, s.index, sku, m, c);
          const base = { productId: p.productId, collection: col, component: 'countertop' as Component, cabinetSizeIndex: s.index, topKind: m.kind as any, sharedId: m.rowId, sizeIndex: m.index, sizeName: m.name, colourIndex: c.index, rawColourIndex: c.rawIndex, colourName: c.name };
          if (!r) {
            unmapped.push({ productId: p.productId, component: 'countertop', cabinetSizeIndex: s.index, sizeIndex: m.index, colourIndex: c.index, reason: 'нет столешницы/раковины и нет аналога' });
            continue;
          }
          add({ ...base, articleCode: r.match === 'estimated' ? (c.sku ?? '').trim() : r.topLine?.articleCode ?? ((c.sku ?? '').trim() || r.lines[0].articleCode), partCode: c.sku?.trim(), priceBYN: r.topLine?.priceBYN ?? r.lines[r.lines.length - 1].priceBYN, name: r.topLine?.name ?? m.name, url: r.topLine?.url ?? r.lines[0].url, image: r.topLine?.image ?? r.lines[0].image, match: r.match, ...(r.estimatedFrom ? { estimatedFrom: r.estimatedFrom } : {}), ...(r.note ? { note: r.note } : {}) });
          for (const cc of p.cabinet.colours.filter((x) => !x.sizeIndices?.length || x.sizeIndices.includes(s.index))) {
            const cabMap = mappings.find((x) => x.productId === p.productId && x.component === 'cabinet' && x.sizeIndex === s.index && x.colourIndex === cc.index);
            const cabEstimated = cabMap?.match === 'estimated';
            bundles.push({
              productId: p.productId,
              sizeIndex: s.index,
              colourIndex: cc.index,
              top: 'countertop',
              topSizeIndex: m.index,
              topColourIndex: c.index,
              topKind: m.kind as any,
              lines: r.lines.map((l, i) => (i === 0 && cabEstimated ? { ...l, match: 'estimated' as MatchKind, name: `${l.name} (цвет ${cc.name})`, note: cabMap?.note } : l)),
              match: cabEstimated ? 'estimated' : r.match,
              ...(r.note ? { note: r.note } : {}),
            });
          }
        }
      }
      // sink (vessel), faucet (by top kind), mirror
      const simple = (comp: 'sink' | 'faucet' | 'mirror', list: ResolvedModel[], topKind?: 'SurfaceMounted' | 'BuiltIn') => {
        for (const m of list) {
          const cs = m.colours.length ? m.colours : [{ index: 0, name: '', rawIndex: 0 } as UeColour];
          for (const c of cs) {
            const base = { productId: p.productId, collection: col, component: comp as Component, cabinetSizeIndex: s.index, ...(topKind ? { topKind } : {}), sharedId: m.rowId, sizeIndex: m.index, sizeName: m.name, colourIndex: c.index, rawColourIndex: c.rawIndex, colourName: c.name };
            if (comp === 'faucet') {
              const f = resolveFaucet(m, c, scraped.products);
              if (f) add({ ...base, articleCode: f.articleCode, priceBYN: f.priceBYN, name: f.name, url: f.url, image: img(f), dimensionsCm: f.dimensionsCm, match: 'name_size_colour', note: `тип «${m.kind ?? ''}» + цвет «${c.name}»; 3D-модель ${m.name} условная` });
              else unmapped.push({ productId: p.productId, component: comp, cabinetSizeIndex: s.index, sizeIndex: m.index, colourIndex: c.index, reason: 'нет смесителя этого цвета' });
              continue;
            }
            const sp = c.sku ? byCode.get(c.sku.replace(/\s+/g, '')) : undefined;
            if (sp) add({ ...base, articleCode: sp.articleCode, priceBYN: sp.priceBYN, name: sp.name, url: sp.url, image: img(sp), match: 'exact_sku' });
            else
              add({
                ...base,
                articleCode: (c.sku ?? '').trim(), // DataTable code or '' («артикул уточняется»)
                priceBYN: 0,
                name: comp === 'sink' ? sinkNameRu(c) : mirrorNameRu(m),
                match: 'estimated',
                note: comp === 'mirror' ? 'нет на oliveeka.by — цена уточняется; название по габаритам 3D-модели, уточняется' : 'нет на oliveeka.by — цена уточняется',
              });
          }
        }
      };
      simple('sink', rs.sink);
      simple('faucet', rs.faucet.SurfaceMounted, 'SurfaceMounted');
      simple('faucet', rs.faucet.BuiltIn, 'BuiltIn');
      simple('mirror', rs.mirror);
    }
    for (const comp of ['countertop', 'sink', 'faucet', 'mirror'] as SharedComponent[])
      p.allowed[comp].forEach((rowId, i) => {
        if (!ue.shared.some((r) => r.component === comp && r.id === rowId))
          unmapped.push({ productId: p.productId, component: comp, sizeIndex: -1, colourIndex: -1, reason: `id ${rowId} (позиция ${i} в Allowed*IDs) нет в таблице — стенд пропускает его (QA-001)` });
      });
  }

  /** Price source for cabinet (size s) + countertop option: bundle article, standalone parts, or an estimate. */
  /** Estimated line: the item's own DataTable code (or '') and name, only the price comes from the sibling. */
  function ownLine(code: string, name: string, sib: ScrapedProduct, note: string): BaseLine {
    return { articleCode: code, name, priceBYN: sib.priceBYN, match: 'estimated', note: `${note}; цена по аналогу ${sib.articleCode}` };
  }

  function resolveTop(
    p: UeProduct,
    s: number,
    sku: string,
    m: ResolvedModel,
    c: UeColour,
  ): { lines: BaseLine[]; match: MatchKind; topLine?: BaseLine; estimatedFrom?: string; note?: string } | null {
    const top = (c.sku ?? '').replace(/\s+/g, '');
    const isBasin = m.kind === 'BuiltIn';
    const sizeName = p.cabinet.sizes.find((x) => x.index === s)?.name ?? '';
    const topName = `${isBasin ? 'Раковина накладная' : 'Столешница'} Oliveeka ${top} ${c.name}`.replace(/\s+/g, ' ').trim();
    const bundleName = `Тумба Oliveeka ${p.collection} ${sizeName} + ${isBasin ? 'раковина' : 'столешница'} ${c.name}`.replace(/\s+/g, ' ').trim();
    const cab = sku ? byCode.get(sku) : undefined;
    const topP = top ? byCode.get(top) : undefined;
    // 1. exact bundle article
    const exact = sku && top ? byCode.get(`${sku}+${top}`) : undefined;
    if (exact) return { lines: [line(exact, 'exact_sku')], match: 'exact_sku', topLine: topP ? line(topP, 'exact_sku') : undefined };
    // 2. standalone cabinet + standalone top
    if (cab && topP) return { lines: [line(cab, 'exact_sku'), line(topP, 'exact_sku')], match: 'exact_sku', topLine: line(topP, 'exact_sku') };
    const own = sku ? scraped.products.filter((x) => x.articleCode.startsWith(sku + '+')) : [];
    if (isBasin) {
      // basin top: a cabinet+basin bundle of the same cabinet (WF = with faucet hole), or cabinet + a same-size basin
      const wf = own.filter((x) => x.category === 'cabinet_with_sink' && /WF$/.test(x.articleCode));
      const pick = cheapest(wf.length ? wf : own.filter((x) => x.category === 'cabinet_with_sink'));
      if (pick) return { lines: [line(pick, 'name_size_colour', top ? `в UE раковина ${top}, на сайте комплект ${pick.articleCode}` : undefined)], match: 'name_size_colour', note: top ? `в UE раковина ${top}, на сайте комплект ${pick.articleCode}` : undefined };
    } else if (own.length) {
      const same = own.filter((x) => x.category === 'cabinet_with_countertop' && sameColour(x.name.split('/').pop(), c.name));
      if (same.length) return { lines: [line(cheapest(same), 'name_size_colour')], match: 'name_size_colour' };
    }
    if (cab && !topP && top) {
      // cabinet exists alone; top not on the site -> cabinet + estimated top from a same-type sibling of the same width
      const w = p.cabinet.sizes.find((x) => x.index === s)?.widthCm;
      const sib = siblingByWidth(w, [isBasin ? 'sink' : 'countertop']);
      if (sib) {
        const tl = ownLine(top, topName, sib, `${top} нет на сайте`);
        return { lines: [line(cab, 'exact_sku'), tl], match: 'estimated', topLine: tl, estimatedFrom: sib.articleCode, note: `${top} нет на сайте` };
      }
    }
    if (own.length) {
      const any = cheapest(own.filter((x) => x.category === (isBasin ? 'cabinet_with_sink' : 'cabinet_with_countertop')));
      if (any) return { lines: [ownLine(top ? `${sku}+${top}` : sku, bundleName, any, `столешницы «${c.name}» ${top} нет на сайте`)], match: 'estimated', estimatedFrom: any.articleCode, note: `столешницы «${c.name}» ${top} нет на сайте` };
    }
    const w = p.cabinet.sizes.find((x) => x.index === s)?.widthCm;
    const sib = siblingByWidth(w, [isBasin ? 'cabinet_with_sink' : 'cabinet_with_countertop']);
    return sib ? { lines: [ownLine(sku ? (top ? `${sku}+${top}` : sku) : '', bundleName, sib, `${p.collection} нет на oliveeka.by`)], match: 'estimated', estimatedFrom: sib.articleCode, note: `${p.collection} нет на oliveeka.by; ближайший по ширине комплект` } : null;
  }

  const index: CatalogIndexData = {
    syncedAt: scraped.syncedAt,
    source: scraped.source,
    products: scraped.products,
    mappings,
    bundles,
    unmapped,
    ue: { products: ue.products, shared: ue.shared, tiles: ue.tiles, exportedAt: ue.exportedAt },
  };
  return { index, report: coverageReport(index, ue, issues) };
}

function resolveFaucet(m: ResolvedModel, c: UeColour, products: ScrapedProduct[]): ScrapedProduct | undefined {
  const mesh = (m.name ?? '').toLowerCase();
  const family = m.kind === 'Integrated' ? '869003' : /high/.test(mesh) ? '239003' : '139003';
  const fam = products.filter((p) => p.category === 'faucet' && p.articleCode.includes(`-${family}-`) && !p.articleCode.includes(`-88${family}`));
  return fam.find((p) => sameColour(p.colour, c.name)) ?? undefined;
}

export function coverageReport(index: CatalogIndexData, ue: UeExport, issues: string[]): string {
  const lines: string[] = [];
  lines.push('# Catalog coverage (UE options ↔ oliveeka.by)', '');
  lines.push(`Generated: ${new Date().toISOString()} by \`maximall-web/scripts/build-catalog-index.ts\`. Scrape synced: ${index.syncedAt}. UE export: ${ue.exportedAt ?? 'n/a'}.`, '');
  lines.push(
    'Index space: the booth-resolved option space (AShowroomBooth::GetResolvedComponentOptions), per cabinet size, as in `config` and in QA\'s',
    '`Saved/QA/catalog_matrix_ue.json` (QA-007). Shared parts are counted per cabinet size; faucets are listed for both countertop types',
    '(SurfaceMounted → Standard faucets, BuiltIn → Integrated faucets).',
    '',
  );
  lines.push('Match kinds: `exact_sku` = the article code (or its bundle) is on the site; `name_size_colour` = matched by collection/type/size/colour;', '`estimated` = no product on the site, price borrowed from the closest sibling (or 0 when there is none) and flagged «цена уточняется».', '');
  lines.push('| Collection | Component | exact_sku | name_size_colour | estimated (priced) | estimated (no price) | missing |', '|---|---|---|---|---|---|---|');
  const cols = [...new Set(ue.products.map((p) => p.collection ?? '-'))];
  const comps: Component[] = ['cabinet', 'closet', 'countertop', 'sink', 'faucet', 'mirror'];
  const tot = { e: 0, n: 0, ep: 0, e0: 0, m: 0 };
  for (const col of cols) {
    for (const comp of comps) {
      const ms = index.mappings.filter((m) => (m.collection ?? '-') === col && m.component === comp);
      const miss = index.unmapped.filter((u) => u.sizeIndex >= 0 && ue.products.find((p) => p.productId === u.productId)?.collection === col && u.component === comp).length;
      if (!ms.length && !miss) {
        if (comp === 'closet') lines.push(`| ${col} | closet | – | – | – | – | – (no wall cabinet in the DataTable) |`);
        continue;
      }
      const e = ms.filter((m) => m.match === 'exact_sku').length;
      const n = ms.filter((m) => m.match === 'name_size_colour').length;
      const ep = ms.filter((m) => m.match === 'estimated' && m.priceBYN > 0).length;
      const e0 = ms.filter((m) => m.match === 'estimated' && m.priceBYN === 0).length;
      tot.e += e;
      tot.n += n;
      tot.ep += ep;
      tot.e0 += e0;
      tot.m += miss;
      lines.push(`| ${col} | ${comp} | ${e} | ${n} | ${ep} | ${e0} | ${miss} |`);
    }
  }
  lines.push(`| **all** | | **${tot.e}** | **${tot.n}** | **${tot.ep}** | **${tot.e0}** | **${tot.m}** |`, '');
  const sm = index.mappings.filter((m) => !(m.component === 'faucet' && m.topKind === 'BuiltIn')).length;
  lines.push(`Options in QA's matrix space (faucets for SurfaceMounted tops only): ${sm}. Price sources for cabinet + countertop option: ${index.bundles.length} (${index.bundles.filter((b) => b.match !== 'estimated').length} not estimated).`, '');
  lines.push('## Estimated and missing entries (must be listed in the QA log)', '');
  const grouped = new Map<string, number>();
  for (const m of index.mappings.filter((x) => x.match === 'estimated')) {
    const k = `${m.collection} ${m.component}: ${m.note ?? ''}${m.estimatedFrom ? ` (цена от ${m.estimatedFrom})` : ''}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  for (const [k, v] of grouped) lines.push(`- ${k} — ${v} option(s)`);
  for (const u of index.unmapped) lines.push(`- UNMAPPED ${u.productId} ${u.component}${u.cabinetSizeIndex !== undefined ? ` (cabinet size ${u.cabinetSizeIndex})` : ''}${u.sizeIndex >= 0 ? ` model ${u.sizeIndex} colour ${u.colourIndex}` : ''}: ${u.reason}`);
  lines.push('', '## Data issues found in the UE export', '');
  for (const s of ue.skipped) lines.push(`- Row \`${s.productId}\` skipped: ${s.reason}`);
  for (const i of [...new Set(issues)]) lines.push(`- ${i}`);
  const hidden = ue.products.filter((p) => p.showInConstructor === false).map((p) => p.productId);
  if (hidden.length) lines.push(`- ShowInConstructor = false: ${hidden.join(', ')} (mapped, but not proposed by propose_sets).`);
  lines.push('- Tuma is mapped but not proposed or placed unless `CATALOG_TUMA_ENABLED=1` (QA-025: its DT_CabinetSetLayouts row puts the set on the floor, turned 90°); visitors asking for it get an honest note and Terra.');
  const noCloset = ue.products.filter((p) => p.closetModels.length === 0).map((p) => p.productId);
  if (noCloset.length) lines.push(`- No wall cabinet (ClosetOptions.Models empty): ${noCloset.join(', ')} — the consultant says so and offers a collection that has one (QA-003).`);
  lines.push('', '## Site facts', '');
  lines.push('- oliveeka.by lists only Milu, Urban and Avenu furniture. Terra and Tuma: collection pages return 404, and the site search for «terra», «tuma», TER70R, TER80R, TUM70A, «flow», «looma» finds nothing. Mirrors («зеркало», «parma») are not on the site.');
  lines.push('- Category pages show bundles (`MIL80A+CMA80W`, `MIL80A+MA80WF`); the site search also finds single parts (cabinets `URB80M`, tops `CU80M`/`CMA80W`, basins `U80WF`). A quote uses the bundle article when it exists, else the single parts, so a cabinet and its top are never priced twice.');
  return lines.join('\n') + '\n';
}
