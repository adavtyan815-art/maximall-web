import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseProductPage, extractLinks, detectCollection, detectCategory, normaliseUrl } from '../src/ai/catalog/parse';
import { parseRobots, isAllowed } from '../src/ai/catalog/robots';
import { PoliteFetcher } from '../src/ai/catalog/fetcher';
import { scrapeOliveeka, inScope } from '../src/ai/catalog/scrape';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'oliveeka', n), 'utf8');

describe('oliveeka product page parser', () => {
  it('parses Milu 80 cabinet + white countertop (price BYN, article, dims, materials, images)', () => {
    const p = parseProductPage(fx('product_milu80_white_top.html'), 'https://oliveeka.by/x/')!;
    expect(p).not.toBeNull();
    expect(p.articleCode).toBe('MIL80A+CMA80W');
    expect(p.priceBYN).toBe(2872);
    expect(p.collection).toBe('Milu');
    expect(p.category).toBe('cabinet_with_countertop');
    expect(p.colour).toBe('Орех');
    expect(p.dimensionsCm).toEqual({ width: 79.5, depth: 50, height: 41.8 });
    expect(p.materials!.some((m) => m.includes('Корабельная фанера'))).toBe(true);
    expect(p.images!.length).toBeGreaterThan(3);
    expect(p.images![0]).toMatch(/^https:\/\/oliveeka\.by\/images\//);
    expect(p.url).toContain('tumba-so-stoleshnicey-oliveeka-milu-80-oreh-stoleshnica-oliveeka-milu-belaya');
    expect(p.sizeLabel).toBe('80');
  });

  it('assigns the collection by the earliest name (Avenu cabinet with a Milu countertop is Avenu)', () => {
    const p = parseProductPage(fx('product_avenu80_white_top.html'), 'https://oliveeka.by/x/')!;
    expect(p.articleCode).toBe('AVE80R+CMA80W');
    expect(p.collection).toBe('Avenu');
    expect(p.category).toBe('cabinet_with_countertop');
  });

  it('parses a wall cabinet (closet) and a faucet', () => {
    const c = parseProductPage(fx('product_milu_closet_mpa110.html'), 'https://oliveeka.by/x/')!;
    expect(c.articleCode).toBe('MPA110');
    expect(c.category).toBe('closet');
    expect(c.dimensionsCm).toEqual({ width: 35, depth: 28, height: 110 });
    const f = parseProductPage(fx('product_faucet_88239017_cr.html'), 'https://oliveeka.by/x/')!;
    expect(f.articleCode).toBe('OL-88239017-CR');
    expect(f.category).toBe('faucet');
    expect(f.priceBYN).toBeGreaterThan(0);
    expect(f.colour).toBe('Хром');
  });

  it('returns null for listing pages (no Product JSON-LD)', () => {
    expect(parseProductPage(fx('listing_milu.html'), 'https://oliveeka.by/x/')).toBeNull();
  });
});

describe('listing links', () => {
  it('extracts product-title links from the Milu collection page', () => {
    const l = extractLinks(fx('listing_milu.html'), 'https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/');
    expect(l.products.length).toBe(9);
    expect(l.products.every((u) => u.startsWith('https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/'))).toBe(true);
  });
  it('follows <link rel=next> pagination', () => {
    const l = extractLinks(fx('listing_mebel_root.html'), 'https://oliveeka.by/mebel-dlya-vannoy/');
    expect(l.all).toContain('https://oliveeka.by/mebel-dlya-vannoy/page-2/');
  });
  it('scope and URL normalisation', () => {
    expect(normaliseUrl('https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu#x')).toBe('https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/');
    expect(inScope('https://oliveeka.by/mebel-dlya-vannoy/page-2/')).toBe(true);
    expect(inScope('https://oliveeka.by/mebel-dlya-vannoy/?sort_by=price')).toBe(false);
    expect(inScope('https://oliveeka.by/santehnika/toilet-bowls-ru/')).toBe(false);
  });
  it('category and collection detection', () => {
    expect(detectCollection('Тумба с раковиной Oliveeka Urban 80, Серый')).toBe('Urban');
    expect(detectCategory('Тумба с раковиной Oliveeka Urban 80')).toBe('cabinet_with_sink');
    expect(detectCategory('Шкаф навесной Oliveeka Urban UPM110')).toBe('closet');
    expect(detectCategory('Высокий смеситель для раковины')).toBe('faucet');
  });
});

describe('robots.txt', () => {
  const rules = parseRobots(fx('robots.txt'), 'MaxiMallCatalogBot/1.0');
  it('blocks query-string pagination and sorting, allows path pagination and products', () => {
    expect(isAllowed(rules, '/mebel-dlya-vannoy/?page=2')).toBe(false);
    expect(isAllowed(rules, '/mebel-dlya-vannoy/?sort_by=price')).toBe(false);
    expect(isAllowed(rules, '/app/foo')).toBe(false);
    expect(isAllowed(rules, '/mebel-dlya-vannoy/page-2/')).toBe(true);
    expect(isAllowed(rules, '/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/')).toBe(true);
  });
});

describe('polite fetcher + crawler (offline, fake network)', () => {
  it('uses the cache, respects robots and spaces network requests >= minInterval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-'));
    fs.writeFileSync(path.join(dir, 'robots.txt'), fx('robots.txt'));
    const pages: Record<string, string> = {
      'https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/': fx('listing_milu.html'),
    };
    const times: number[] = [];
    const fakeFetch = (async (url: string) => {
      times.push(Date.now());
      const body = pages[url] ?? (url.includes('kollekciya-milu/') ? fx('product_milu80_white_top.html') : null);
      return { ok: body !== null, status: body ? 200 : 404, text: async () => body ?? '' } as any;
    }) as unknown as typeof fetch;
    const r = await scrapeOliveeka({
      cacheDir: dir,
      minIntervalMs: 50,
      fetchImpl: fakeFetch,
      seeds: ['/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/'],
      maxPages: 5,
    });
    expect(r.products.length).toBe(1); // every fake product page carries the same article code (dedup)
    expect(r.products[0].articleCode).toBe('MIL80A+CMA80W');
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(45);
    // second run: all from cache, no network
    const f2 = new PoliteFetcher({ cacheDir: dir, offline: true });
    const html = await f2.get('https://oliveeka.by/mebel-dlya-vannoy/kollekcii-mebeli/kollekciya-milu/');
    expect(html).not.toBeNull();
    expect(f2.networkRequests).toBe(0);
    expect(await f2.get('https://oliveeka.by/mebel-dlya-vannoy/?page=2')).toBeNull();
  });
});
