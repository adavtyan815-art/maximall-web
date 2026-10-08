import { describe, it, expect } from 'vitest';
import { CatalogIndex } from '../src/ai/catalog/index';
import { CatalogLinks, cmToMm, isPartnerUrl, PARTNER_HOST } from '../src/ai/estimate/catalogLinks';
import { countsInTotal, isApproximate, lineAmount, lineStatus, round2, statusCounts, totalOf, unitPriceOf } from '../src/ai/estimate/status';
import type { CatalogIndexData } from '../src/ai/catalog/types';

/** MONTH2_SPEC m2.2 §11.4 / M1: the partner-link rule and the line-status rule, against the committed catalog index (2026-09-30). */

const catalog = CatalogIndex.load();
const links = CatalogLinks.fromIndex(catalog.data);

describe('M1 partner links (products[] membership + https + oliveeka.by)', () => {
  it('gives the bundle article MIL80A+CMA80W its own product page', () => {
    const own = catalog.data.products.find((p) => p.articleCode === 'MIL80A+CMA80W');
    expect(own).toBeDefined();
    expect(links.ownArticleUrl('MIL80A+CMA80W')).toBe(own!.url);
    expect(links.ownArticleUrl('MIL80A+CMA80W')).toMatch(/^https:\/\/oliveeka\.by\/.*kollekciya-milu/);
    const a = links.ownArticle('MIL80A+CMA80W')!;
    expect(a.priceBYN).toBe(own!.priceBYN);
    expect(a.priceBYN).toBeGreaterThan(0);
  });

  it('gives no link to articles that are not products of the site (borrowed prices, Terra/Tuma estimates, parts)', () => {
    for (const code of ['T795C2', 'TER70R', 'TUM70A', 'OL-20A']) {
      expect(catalog.data.products.some((p) => p.articleCode === code), code).toBe(false);
      expect(links.ownArticle(code), code).toBeUndefined();
      expect(links.ownArticleUrl(code), code).toBeUndefined();
    }
    // Their mappings / bundle lines DO carry a (sibling) URL — the rule must not use it.
    const sibling = catalog.data.mappings.find((m) => m.articleCode === 'T795C2' && m.url);
    expect(sibling?.url).toMatch(/^https:\/\/oliveeka\.by\//);
  });

  it('every link it gives is the own page of a products[] entry, https on oliveeka.by', () => {
    let n = 0;
    for (const p of catalog.data.products) {
      const url = links.ownArticleUrl(p.articleCode);
      expect(url, p.articleCode).toBe(p.url);
      const u = new URL(url!);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe(PARTNER_HOST);
      n++;
    }
    expect(n).toBe(catalog.data.products.length);
    expect(links.size).toBe(new Set(catalog.data.products.map((p) => p.articleCode)).size);
  });

  it('never uses ue.*.colours[].url (category pages) or mapping / bundle URLs', () => {
    const colourUrls = new Set<string>();
    for (const p of catalog.data.ue.products) for (const c of p.cabinet.colours) if (c.url) colourUrls.add(c.url);
    for (const s of catalog.data.ue.shared) for (const c of s.colours) if (c.url) colourUrls.add(c.url);
    expect(colourUrls.size).toBeGreaterThan(0);
    const given = new Set(catalog.data.products.map((p) => links.ownArticleUrl(p.articleCode)));
    for (const u of colourUrls) expect(given.has(u), u).toBe(false);

    // A code that exists only in ue colours (sku) and mappings: no link.
    const fixture: Pick<CatalogIndexData, 'products'> & Record<string, unknown> = {
      products: [],
      mappings: [{ articleCode: 'ONLYMAP1', url: 'https://oliveeka.by/x/' }],
      ue: { products: [{ cabinet: { colours: [{ index: 0, name: 'x', sku: 'ONLYMAP1', url: 'https://oliveeka.by/kollekciya/' }] } }] },
    };
    expect(CatalogLinks.fromIndex(fixture).ownArticleUrl('ONLYMAP1')).toBeUndefined();
  });

  it('refuses javascript:, http:, foreign hosts, look-alike hosts, ports and credentials', () => {
    const bad = [
      'javascript://oliveeka.by/%0aalert(1)',
      'http://oliveeka.by/santehnika/x/',
      'https://oliveeka.com/product/MIL80A',
      'https://evil.example/oliveeka.by/',
      'https://oliveeka.by.evil.example/x/',
      'https://shop.oliveeka.by/x/',
      'https://oliveeka.by:8443/x/',
      'https://user:pw@oliveeka.by/x/',
      '//oliveeka.by/x/',
      '/santehnika/x/',
      'data:text/html,<script>alert(1)</script>',
      '',
    ];
    for (const url of bad) expect(isPartnerUrl(url), url).toBe(false);
    expect(isPartnerUrl(undefined)).toBe(false);
    expect(isPartnerUrl(42)).toBe(false);
    expect(isPartnerUrl('https://oliveeka.by/')).toBe(true);
    expect(isPartnerUrl('https://OLIVEEKA.BY/x/')).toBe(true); // URL lower-cases the host

    const fixture = new CatalogLinks([
      { articleCode: 'JS1', name: 'js', priceBYN: 10, url: 'javascript://oliveeka.by/%0aalert(1)' },
      { articleCode: 'HTTP1', name: 'http', priceBYN: 10, url: 'http://oliveeka.by/x/' },
      { articleCode: 'COM1', name: 'com', priceBYN: 10, url: 'https://oliveeka.com/product/COM1' },
      { articleCode: 'OK1', name: 'ok', priceBYN: 10, url: 'https://oliveeka.by/ok/' },
    ]);
    expect(fixture.ownArticleUrl('JS1')).toBeUndefined();
    expect(fixture.ownArticleUrl('HTTP1')).toBeUndefined();
    expect(fixture.ownArticleUrl('COM1')).toBeUndefined();
    expect(fixture.ownArticleUrl('OK1')).toBe('https://oliveeka.by/ok/');
    // The article stays known (price, name) even when its URL is refused.
    expect(fixture.ownArticle('JS1')?.priceBYN).toBe(10);
  });

  it('keeps the first entry per code, trims codes, ignores junk and maps cm to mm', () => {
    const fixture = new CatalogLinks([
      { articleCode: ' A1 ', name: 'first', priceBYN: 100, url: 'https://oliveeka.by/a1/', dimensionsCm: { width: 79.6, depth: 46, height: 50 } },
      { articleCode: 'A1', name: 'second', priceBYN: 200, url: 'https://oliveeka.by/a1-dup/' },
      { articleCode: '', name: 'empty', priceBYN: 1, url: 'https://oliveeka.by/e/' },
      { articleCode: 'NEG', name: 'neg', priceBYN: -5, url: 'https://oliveeka.by/neg/' },
    ] as any);
    expect(fixture.size).toBe(2);
    expect(fixture.ownArticle('A1')).toEqual({ articleCode: 'A1', name: 'first', priceBYN: 100, url: 'https://oliveeka.by/a1/', dimensionsMm: { width: 796, depth: 460, height: 500 } });
    expect(fixture.ownArticle('NEG')?.priceBYN).toBe(0);
    expect(fixture.ownArticleUrl(undefined)).toBeUndefined();
    expect(cmToMm({ width: 80, depth: Number.NaN })).toEqual({ width: 800 });
    expect(cmToMm({})).toBeUndefined();
    expect(cmToMm(undefined)).toBeUndefined();
  });
});

describe('M1 line status (priced / estimated / unpriced) and totals', () => {
  it('applies the §11.4 table', () => {
    expect(lineStatus({ price: 2872 })).toBe('priced');
    expect(lineStatus({ price: 1297, estimated: true })).toBe('estimated');
    expect(lineStatus({ price: 0 })).toBe('unpriced');
    expect(lineStatus({ price: 0, estimated: true })).toBe('unpriced');
    expect(lineStatus({})).toBe('unpriced');
    expect(lineStatus({ price: null })).toBe('unpriced');
    expect(lineStatus({ price: Number.NaN })).toBe('unpriced');
    expect(lineStatus({ price: 500, unpriced: true })).toBe('unpriced');
    expect(isApproximate('estimated')).toBe(true);
    for (const s of ['priced', 'unpriced', 'info'] as const) expect(isApproximate(s)).toBe(false);
    expect(countsInTotal('priced')).toBe(true);
    expect(countsInTotal('estimated')).toBe(true);
    expect(countsInTotal('unpriced')).toBe(false);
    expect(countsInTotal('info')).toBe(false);
    expect(unitPriceOf({ price: 1297, estimated: true })).toBe(1297);
    expect(unitPriceOf({ price: 0 })).toBeNull();
  });

  it('prices the real quotes: Milu 80 default is priced with a link, Urban 80 is an estimate, the mirror is unpriced', () => {
    const milu = catalog.quote({ productId: 'Milu', sizeIndex: 0, colourIndex: 0, ...(catalog.defaultsFor('Milu', 0) ?? {}) });
    const miluBundle = milu.lines.find((l) => l.articleCode === 'MIL80A+CMA80W');
    expect(miluBundle).toBeDefined();
    expect(lineStatus(miluBundle!)).toBe('priced');
    expect(links.ownArticleUrl(miluBundle!.articleCode)).toBe(miluBundle!.url);
    const statuses = milu.lines.map((l) => lineStatus(l));
    const lines = milu.lines.map((l, i) => ({ status: statuses[i], amountBYN: lineAmount(statuses[i], unitPriceOf(l), 1) }));
    // Everything counted in quote().total is counted here too (unpriced lines have price 0 there).
    expect(totalOf(lines)).toBe(round2(milu.total));
    expect(milu.total).toBe(3230);

    const urban = catalog.quote({ productId: 'Urban', sizeIndex: 0, colourIndex: 0, ...(catalog.defaultsFor('Urban', 0) ?? {}) });
    const urb = urban.lines.find((l) => l.articleCode === 'URB80M');
    expect(urb).toBeDefined();
    expect(lineStatus(urb!)).toBe('estimated');
    expect(isApproximate(lineStatus(urb!))).toBe(true);
    // URB80M is itself a product of the site (a similar item), so it keeps its own link — flagged approximate by the estimate.
    expect(links.ownArticleUrl('URB80M')).toMatch(/^https:\/\/oliveeka\.by\//);

    const unpricedLines = [...milu.lines, ...urban.lines].filter((l) => l.unpriced || l.price === 0);
    for (const l of unpricedLines) expect(lineStatus(l), l.articleCode).toBe('unpriced');
  });

  it('computes amounts, totals and counts', () => {
    expect(lineAmount('priced', 2872, 2)).toBe(5744);
    expect(lineAmount('estimated', 19.99, 3)).toBe(59.97);
    expect(lineAmount('unpriced', 100, 1)).toBe(0);
    expect(lineAmount('info', 100, 1)).toBe(0);
    expect(lineAmount('priced', null, 1)).toBe(0);
    expect(lineAmount('priced', 10, -1)).toBe(0);
    const lines = [
      { status: 'priced' as const, amountBYN: 2872 },
      { status: 'estimated' as const, amountBYN: 0.1 },
      { status: 'estimated' as const, amountBYN: 0.2 },
      { status: 'unpriced' as const, amountBYN: 999 },
      { status: 'info' as const, amountBYN: 5 },
    ];
    expect(totalOf(lines)).toBe(2872.3);
    expect(statusCounts(lines)).toEqual({ pricedCount: 1, estimatedCount: 2, unpricedCount: 1 });
    expect(round2(1.005)).toBe(1.01);
  });
});
