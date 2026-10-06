/**
 * Usage: npx tsx scripts/scrape-oliveeka.ts [--offline] [--refresh] [--max N]
 * Crawls oliveeka.by (robots.txt respected, 1 request/second, pages cached in
 * D:/AI_Consultant_Workspace/catalog/scrape_cache) and writes data/catalog/scraped_products.json.
 */
import path from 'path';
import fs from 'fs';
import { scrapeOliveeka, writeScrapeResult, DEFAULT_SEARCH_QUERIES } from '../src/ai/catalog/scrape';
import { loadUeExport } from '../src/ai/catalog/mapping';

const args = process.argv.slice(2);
const cacheDir = process.env.SCRAPE_CACHE_DIR ?? 'D:/AI_Consultant_Workspace/catalog/scrape_cache';
const out = path.join(__dirname, '..', 'data', 'catalog', 'scraped_products.json');
const maxIdx = args.indexOf('--max');

(async () => {
  const t0 = Date.now();
  // Search queries: defaults + every SKU found in the UE export (cabinets, closets, tops, basins, sinks).
  const ueDir = process.env.UE_EXPORT_DIR ?? 'D:/AI_Consultant_Workspace/catalog/ue_export/raw';
  const skus = new Set<string>();
  if (fs.existsSync(ueDir)) {
    const ue = loadUeExport(ueDir);
    for (const p of ue.products) {
      Object.values(p.cabinetSkus ?? {}).forEach((x) => skus.add(x.trim()));
      Object.values(p.closetSkus ?? {}).forEach((x) => skus.add(x.trim()));
    }
    for (const r of ue.shared) for (const c of r.colours) if (c.sku && !c.sku.startsWith('#')) skus.add(c.sku.trim());
  }
  const searchQueries = [...DEFAULT_SEARCH_QUERIES, ...[...skus].filter((x) => /^[A-Z0-9-]{3,}$/i.test(x))];
  console.log('search queries:', searchQueries.length);
  const result = await scrapeOliveeka({
    searchQueries,
    cacheDir,
    offline: args.includes('--offline'),
    refresh: args.includes('--refresh'),
    maxPages: maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined,
    log: (m) => console.log(m),
  });
  writeScrapeResult(result, out);
  const byCol: Record<string, number> = {};
  for (const p of result.products) byCol[`${p.collection ?? '-'}/${p.category}`] = (byCol[`${p.collection ?? '-'}/${p.category}`] ?? 0) + 1;
  console.log(JSON.stringify({ out, products: result.products.length, byCol, stats: result.stats, seconds: (Date.now() - t0) / 1000 }, null, 2));
})();
