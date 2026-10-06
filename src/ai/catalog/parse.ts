import * as cheerio from 'cheerio';

export const COLLECTIONS = ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type ProductCategory =
  | 'cabinet_with_sink' // тумба с раковиной
  | 'cabinet_with_countertop' // тумба со столешницей
  | 'cabinet' // тумба (без раковины/столешницы)
  | 'closet' // шкаф навесной / пенал
  | 'countertop'
  | 'sink'
  | 'faucet'
  | 'mirror'
  | 'other';

/** catalog-mapping.schema.json#/$defs/scrapedProduct (+ extra fields: features, breadcrumbs, productIdSite) */
export interface ScrapedProduct {
  articleCode: string;
  name: string;
  priceBYN: number;
  oldPriceBYN?: number;
  collection?: string;
  category?: ProductCategory;
  dimensionsCm?: { width?: number; depth?: number; height?: number };
  materials?: string[];
  colour?: string;
  images?: string[];
  url: string;
  fetchedAt?: string;
  sizeLabel?: string; // "Размер" feature, e.g. "80"
  features?: Record<string, string>;
  breadcrumbs?: string[];
}

/** Percent-encodes non-ASCII characters (image paths contain Cyrillic) so URLs are valid RFC 3986 URIs. */
export function safeUri(u: string): string {
  try {
    return encodeURI(decodeURI(u));
  } catch {
    return encodeURI(u);
  }
}

export function parsePriceText(t: string): number | undefined {
  const n = t.replace(/&nbsp;| |\s/g, '').replace(',', '.').match(/[0-9]+(\.[0-9]+)?/);
  return n ? Number(n[0]) : undefined;
}

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.replace(',', '.').match(/-?[0-9]+(\.[0-9]+)?/);
  return m ? Number(m[0]) : undefined;
}

export function detectCollection(...texts: (string | undefined)[]): Collection | undefined {
  // The earliest collection name wins: "Тумба Oliveeka Avenu 80 / Столешница Oliveeka Milu" is Avenu.
  for (const t of texts) {
    if (!t) continue;
    let best: { c: Collection; at: number } | undefined;
    for (const c of COLLECTIONS) {
      const m = new RegExp(`\\b${c}\\b`, 'i').exec(t);
      if (m && (!best || m.index < best.at)) best = { c, at: m.index };
    }
    if (best) return best.c;
  }
  return undefined;
}

export function detectCategory(name: string, type?: string): ProductCategory {
  const s = `${name} ${type ?? ''}`.toLowerCase();
  if (/^\s*раковин/.test(s)) return 'sink'; // «Раковина … с отверстием под смеситель» is a basin
  if (/смесител/.test(s)) return 'faucet';
  if (/зеркал/.test(s)) return 'mirror';
  if (/пенал|шкаф/.test(s)) return 'closet';
  if (/тумба[^/]*с раковин/.test(s)) return 'cabinet_with_sink';
  if (/тумба[^/]*со столешниц/.test(s)) return 'cabinet_with_countertop';
  if (/^\s*столешниц/.test(s)) return 'countertop';
  if (/^\s*раковин/.test(s)) return 'sink';
  if (/тумба/.test(s)) return 'cabinet';
  return 'other';
}

/** Parses a product page. Returns null when the page is not a product page (no schema.org Product JSON-LD). */
export function parseProductPage(html: string, url: string, fetchedAt = new Date().toISOString()): ScrapedProduct | null {
  const $ = cheerio.load(html);
  let ld: any = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).text());
      const t = String(j['@type'] ?? '');
      if (/Product$/.test(t)) ld = j;
    } catch {
      /* ignore malformed blocks */
    }
  });
  if (!ld) return null;

  const features: Record<string, string> = {};
  $('.ty-product-feature').each((_, el) => {
    const label = $(el).find('.ty-product-feature__label').first().text().replace(/:\s*$/, '').trim();
    const value = $(el).find('.ty-product-feature__value').first().text().replace(/\s+/g, ' ').trim();
    if (label && value && !(label in features)) features[label] = value;
  });

  const offers = Array.isArray(ld.offers) ? ld.offers : ld.offers ? [ld.offers] : [];
  const offer = offers[0] ?? {};
  const currency = String(offer.priceCurrency ?? 'BYN').toUpperCase();
  let price = typeof offer.price === 'number' ? offer.price : num(String(offer.price ?? ''));
  if (currency !== 'BYN') price = undefined;

  let oldPrice: number | undefined;
  const strike = $('.ty-product-block .ty-strike .ty-list-price, .ty-product-block__price-old .ty-price-num').first().text();
  if (strike) oldPrice = parsePriceText(strike);

  const name = String(ld.name ?? $('h1').first().text()).trim();
  // The feature table is page-specific; JSON-LD sku is sometimes copied from a sibling (e.g. the CMA80A page says CMA80R).
  const articleCode = String(features['Артикул'] || ld.sku || '').trim();
  const breadcrumbs = $('.ty-breadcrumbs a, .ty-breadcrumbs span')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t && t !== '/');

  const materials = Object.entries(features)
    .filter(([k]) => /материал|покрыти/i.test(k))
    .map(([k, v]) => `${k}: ${v}`);

  const images: string[] = (Array.isArray(ld.image) ? ld.image.map(String) : ld.image ? [String(ld.image)] : []).map(safeUri);

  const dims = {
    width: num(features['Ширина, см']) ?? (num(features['Ширина, мм']) !== undefined ? num(features['Ширина, мм'])! / 10 : undefined),
    depth: num(features['Глубина, см']) ?? (num(features['Глубина, мм']) !== undefined ? num(features['Глубина, мм'])! / 10 : undefined),
    height: num(features['Высота, см']) ?? (num(features['Высота, мм']) !== undefined ? num(features['Высота, мм'])! / 10 : undefined),
  };
  const dimensionsCm = Object.fromEntries(Object.entries(dims).filter(([, v]) => v !== undefined)) as ScrapedProduct['dimensionsCm'];

  if (!articleCode || price === undefined || price <= 0) return null; // no price = not a sellable offer
  return {
    articleCode,
    name,
    priceBYN: price,
    ...(oldPrice && oldPrice > price ? { oldPriceBYN: oldPrice } : {}),
    collection: detectCollection(name, breadcrumbs.join(' '), url),
    category: detectCategory(name, features['Тип']),
    dimensionsCm,
    materials,
    colour: features['Цвет'] ?? features['Цвет каркаса'],
    images,
    url: safeUri(String(offer.url ?? url)),
    fetchedAt,
    sizeLabel: features['Размер'],
    features,
    breadcrumbs,
  };
}

/** Links found on a listing or product page: product-title anchors and any same-site links. */
export function extractLinks(html: string, baseUrl: string): { products: string[]; all: string[] } {
  const $ = cheerio.load(html);
  const products = new Set<string>();
  const all = new Set<string>();
  $('a[href], link[rel="next"][href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    let abs: URL;
    try {
      abs = new URL(href.replace(/&amp;/g, '&'), baseUrl);
    } catch {
      return;
    }
    if (abs.origin !== new URL(baseUrl).origin) return;
    abs.hash = '';
    const s = normaliseUrl(abs.toString());
    all.add(s);
    if ($(el).hasClass('product-title')) products.add(s);
  });
  return { products: [...products], all: [...all] };
}

export function normaliseUrl(u: string): string {
  const url = new URL(u);
  url.hash = '';
  if (!url.search && !url.pathname.endsWith('/') && !/\.[a-z0-9]{2,4}$/i.test(url.pathname)) url.pathname += '/';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  return url.toString();
}
