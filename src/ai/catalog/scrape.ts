import fs from 'fs';
import path from 'path';
import { PoliteFetcher, FetcherOptions } from './fetcher';
import { extractLinks, normaliseUrl, parseProductPage, ScrapedProduct } from './parse';

export const OLIVEEKA_ORIGIN = 'https://oliveeka.by';

/** Seeds: furniture root, the collections listing, and the basin-mixer (faucet) categories. */
export const DEFAULT_SEEDS = [
  '/mebel-dlya-vannoy/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-urban/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-avenu/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-terra/',
  '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-tuma/',
  '/santehnika/smesiteli/',
  '/santehnika/mixers-ru/',
];

/** Paths the crawler may follow (listing pages and product pages). */
export function inScope(url: string): boolean {
  const u = new URL(url);
  if (u.origin !== OLIVEEKA_ORIGIN) return false;
  if (u.search) return false; // no query-string variants (sort/filters/pagination params)
  if (/\.(png|jpe?g|webp|gif|svg|pdf|css|js)$/i.test(u.pathname)) return false;
  return /^\/mebel-dlya-vannoy\//.test(u.pathname) || /^\/santehnika\/(smesiteli|mixers-ru)\//.test(u.pathname);
}

/** Only furniture pages are expanded for further links; mixer pages only via listing pages. */
function expandFrom(url: string, isProduct: boolean): boolean {
  const p = new URL(url).pathname;
  if (!isProduct) return true;
  return /^\/mebel-dlya-vannoy\//.test(p);
}

export interface ScrapeResult {
  syncedAt: string;
  source: string;
  products: ScrapedProduct[];
  stats: { pagesVisited: number; networkRequests: number; cacheHits: number; blocked: number; failed: string[] };
}

/** Site search URL (robots-compliant: no page=, sort_by=, subcats= parameters). */
export function searchUrl(q: string) {
  return `${OLIVEEKA_ORIGIN}/index.php?dispatch=products.search&search_performed=Y&pname=Y&pkeywords=Y&pcode_from_q=Y&q=${encodeURIComponent(q)}`;
}

/**
 * Many single parts (cabinets «Тумба под раковину», countertops, basins) are not linked from the category pages but are
 * found by the site search. The crawler runs these queries (collection names, UE SKUs, part words) as extra seeds;
 * product links from search results are fetched as product pages only (not expanded).
 */
export const DEFAULT_SEARCH_QUERIES = ['milu', 'urban', 'avenu', 'terra', 'tuma', 'тумба', 'столешница', 'раковина', 'зеркало', 'шкаф', 'пенал', 'flow', 'looma', 'parma', 'смеситель'];

export async function scrapeOliveeka(opts: FetcherOptions & { seeds?: string[]; maxPages?: number; searchQueries?: string[] }): Promise<ScrapeResult> {
  const fetcher = new PoliteFetcher(opts);
  const seeds = (opts.seeds ?? DEFAULT_SEEDS).map((s) => normaliseUrl(new URL(s, OLIVEEKA_ORIGIN).toString()));
  const queue = [...seeds];
  const seen = new Set(queue);
  const byCode = new Map<string, ScrapedProduct>();
  const failed: string[] = [];
  let blocked = 0;
  let pages = 0;
  const max = opts.maxPages ?? 600;
  await fetcher.loadRobots(OLIVEEKA_ORIGIN);
  const searchHits = new Set<string>();
  for (const q of opts.searchQueries ?? []) {
    const url = searchUrl(q);
    if (!fetcher.allowed(url)) {
      blocked++;
      continue;
    }
    const html = await fetcher.get(url);
    pages++;
    if (html === null) {
      failed.push(url);
      continue;
    }
    const links = extractLinks(html, url).products.filter((l) => !new URL(l).search);
    for (const l of links) {
      searchHits.add(l);
      if (!seen.has(l)) {
        seen.add(l);
        queue.push(l);
      }
    }
    opts.log?.(`[search] ${q}: ${links.length} products`);
  }

  while (queue.length && pages < max) {
    const url = queue.shift()!;
    if (!fetcher.allowed(url)) {
      blocked++;
      continue;
    }
    const html = await fetcher.get(url);
    pages++;
    if (html === null) {
      failed.push(url);
      continue;
    }
    const product = parseProductPage(html, url);
    if (product) {
      const prev = byCode.get(product.articleCode);
      // Several URLs (e.g. "-ru" duplicates) may carry the same article code; keep the shortest canonical URL.
      if (!prev || product.url.length < prev.url.length) byCode.set(product.articleCode, product);
    }
    if (searchHits.has(url) && !inScope(url)) continue;
    if (!expandFrom(url, !!product)) continue;
    const links = extractLinks(html, url);
    for (const l of [...links.products, ...links.all]) {
      if (!seen.has(l) && inScope(l)) {
        seen.add(l);
        queue.push(l);
      }
    }
    opts.log?.(`[${pages}] ${product ? 'P ' + product.articleCode : 'L'} ${url} (queue ${queue.length})`);
  }

  const products = [...byCode.values()].sort((a, b) => (a.collection ?? '').localeCompare(b.collection ?? '') || a.articleCode.localeCompare(b.articleCode));
  return {
    syncedAt: new Date().toISOString(),
    source: OLIVEEKA_ORIGIN,
    products,
    stats: { pagesVisited: pages, networkRequests: fetcher.networkRequests, cacheHits: fetcher.cacheHits, blocked, failed },
  };
}

export function writeScrapeResult(result: ScrapeResult, outFile: string) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
}
