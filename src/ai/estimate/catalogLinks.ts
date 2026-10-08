import type { CatalogIndexData, ScrapedProduct } from '../catalog/types';

/**
 * MONTH2_SPEC m2.2 §11.4 (REQ-32, decision D4): partner links for the room estimate.
 *
 * Link rule: a line gets a `url` only when its article code is in the scraped site list `products[]` of the catalog index, and then
 * it is THAT product's own page — and only if the URL is https on exactly oliveeka.by. Nothing else is a link source: mapping /
 * bundle URLs (borrowed-price sibling pages, Terra/Tuma estimates) and `ue.*.colours[].url` (category pages) are never used.
 * A hostname check alone is not enough: `javascript://oliveeka.by/%0aalert(1)` has hostname oliveeka.by.
 */

export const PARTNER_HOST = 'oliveeka.by';
export const PARTNER_HOME = 'https://oliveeka.by/';

/** True only for an absolute https URL on exactly oliveeka.by (default port, no credentials). The page applies the same check. */
export function isPartnerUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.hostname === PARTNER_HOST && u.port === '' && u.username === '' && u.password === '';
}

export interface DimensionsMm {
  width?: number;
  depth?: number;
  height?: number;
}

/** catalog dimensionsCm × 10 → dimensionsMm (rounded), only the finite non-negative values present; undefined when none. */
export function cmToMm(dimensionsCm?: { width?: number; depth?: number; height?: number } | null): DimensionsMm | undefined {
  if (!dimensionsCm) return undefined;
  const out: DimensionsMm = {};
  for (const k of ['width', 'depth', 'height'] as const) {
    const v = dimensionsCm[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v * 10);
  }
  return Object.keys(out).length ? out : undefined;
}

/** One sellable article of the partner site (a `products[]` entry), as the estimate uses it. */
export interface PartnerArticle {
  articleCode: string;
  name: string;
  /** BYN, VAT included; 0 when the site lists no price. */
  priceBYN: number;
  /** The product's own page; absent when its scraped URL fails isPartnerUrl. */
  url?: string;
  category?: string;
  dimensionsMm?: DimensionsMm;
}

type ProductLike = Pick<ScrapedProduct, 'articleCode' | 'name' | 'priceBYN' | 'url'> & Partial<Pick<ScrapedProduct, 'category' | 'dimensionsCm'>>;

/** Article code → own partner article, built from `products[]` only. */
export class CatalogLinks {
  private readonly byCode = new Map<string, PartnerArticle>();

  constructor(products: readonly ProductLike[]) {
    for (const p of products ?? []) {
      const code = typeof p?.articleCode === 'string' ? p.articleCode.trim() : '';
      if (!code || this.byCode.has(code)) continue; // first entry wins
      const price = typeof p.priceBYN === 'number' && Number.isFinite(p.priceBYN) && p.priceBYN > 0 ? p.priceBYN : 0;
      this.byCode.set(code, {
        articleCode: code,
        name: typeof p.name === 'string' ? p.name : code,
        priceBYN: price,
        ...(isPartnerUrl(p.url) ? { url: p.url } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(cmToMm(p.dimensionsCm) ? { dimensionsMm: cmToMm(p.dimensionsCm) } : {}),
      });
    }
  }

  /** Built from a catalog index (CatalogIndex.data): reads `products[]` and nothing else. */
  static fromIndex(data: Pick<CatalogIndexData, 'products'>): CatalogLinks {
    return new CatalogLinks(data?.products ?? []);
  }

  get size(): number {
    return this.byCode.size;
  }

  /** The partner article for an article code, or undefined when the code is not a product of the site. */
  ownArticle(articleCode: string | undefined | null): PartnerArticle | undefined {
    if (typeof articleCode !== 'string') return undefined;
    return this.byCode.get(articleCode.trim());
  }

  /** The §11.4 link: the article's own https oliveeka.by URL, or undefined (bundle / part articles, estimates, unknown codes). */
  ownArticleUrl(articleCode: string | undefined | null): string | undefined {
    return this.ownArticle(articleCode)?.url;
  }
}
