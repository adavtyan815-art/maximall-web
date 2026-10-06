import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseUeText } from '../src/ai/catalog/ueText';
import { fixtureIndex } from './helpers/catalog';
import { validator, expectValid } from './helpers/contracts';
import type { ResolvedModel } from '../src/ai/catalog/types';

describe('UE ExportText parser', () => {
  it('parses structs, arrays, NSLOCTEXT, numbers and empty values', () => {
    const v = parseUeText('(Sizes=("/Game/a.a","/Game/b.b"),SizeNames=(NSLOCTEXT("[x]", "k", "80"),NSLOCTEXT("[x]", "k2", "100")),Colors=,Flag=True,N=-2.5,Arr=((SKU="A",SizeIndices=(0,1)),(SKU="B",SizeIndices=())))');
    expect(v.Sizes).toEqual(['/Game/a.a', '/Game/b.b']);
    expect(v.SizeNames).toEqual(['80', '100']);
    expect(v.Colors).toBe('');
    expect(v.Flag).toBe(true);
    expect(v.N).toBe(-2.5);
    expect(v.Arr[0]).toEqual({ SKU: 'A', SizeIndices: [0, 1] });
    expect(v.Arr[1].SizeIndices).toEqual([]);
  });
});

describe('X2 mapping builder (real UE export + real scrape fixtures)', () => {
  const f = fixtureIndex();

  it('loads the five collections and skips non-bathroom rows', () => {
    expect(f.ue.products.map((p) => p.productId).sort()).toEqual(['Avenu', 'Milu', 'Terra', 'Tuma', 'Urban']);
    expect(f.ue.skipped.map((s) => s.productId)).toContain('Divan');
  });

  it('covers every option of the resolved space: mapped exactly once or listed as unmapped with a reason', () => {
    let n = 0;
    for (const p of f.ue.products) {
      const keys: { component: string; cab?: number; kind?: string; si: number; ci: number }[] = [];
      for (const s of p.cabinet.sizes) for (const c of p.cabinet.colours.filter((x) => !x.sizeIndices?.length || x.sizeIndices.includes(s.index))) keys.push({ component: 'cabinet', si: s.index, ci: c.index });
      for (const m of p.closetModels) for (const c of m.colours) keys.push({ component: 'closet', si: m.index, ci: c.index });
      for (const s of p.cabinet.sizes) {
        const sp = p.resolved[String(s.index)];
        const add = (component: string, list: ResolvedModel[], kind?: string) => {
          for (const m of list) for (const c of m.colours.length ? m.colours : [{ index: 0 }]) keys.push({ component, cab: s.index, kind, si: m.index, ci: c.index });
        };
        add('countertop', sp.countertop);
        add('sink', sp.sink);
        add('faucet', sp.faucet.SurfaceMounted, 'SurfaceMounted');
        add('faucet', sp.faucet.BuiltIn, 'BuiltIn');
        add('mirror', sp.mirror);
      }
      for (const k of keys) {
        const mapped = f.index.mappings.filter(
          (m) => m.productId === p.productId && m.component === k.component && m.sizeIndex === k.si && m.colourIndex === k.ci && m.cabinetSizeIndex === k.cab && (k.component !== 'faucet' || m.topKind === k.kind),
        );
        const un = f.index.unmapped.filter((u) => u.productId === p.productId && u.component === k.component && u.sizeIndex === k.si && u.colourIndex === k.ci && u.cabinetSizeIndex === k.cab);
        expect(mapped.length + un.length, `${p.productId} ${JSON.stringify(k)}`).toBe(1);
        n++;
      }
    }
    expect(n).toBeGreaterThan(400);
  });

  it('every mapping validates against catalog-mapping.schema.json and has a BYN price >= 0', () => {
    const v = validator('maximall/ai/catalog-mapping.schema.json#/$defs/mapping');
    for (const m of f.index.mappings) {
      expectValid(v, m);
      expect(m.priceBYN).toBeGreaterThanOrEqual(0);
    }
    const sp = validator('maximall/ai/catalog-mapping.schema.json#/$defs/scrapedProduct');
    for (const p of f.index.products) expectValid(sp, p);
  });

  it('matches real article codes: Milu 80 + white countertop -> bundle MIL80A+CMA80W at the scraped price', () => {
    const q = f.catalog.quote({ productId: 'Milu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 0, closetSizeIndex: -1 });
    const cab = q.lines.find((l) => l.component === 'cabinet')!;
    expect(cab.articleCode).toBe('MIL80A+CMA80W');
    expect(cab.price).toBe(f.scraped.products.find((p: any) => p.articleCode === 'MIL80A+CMA80W').priceBYN);
    expect(cab.estimated).toBe(false);
    // the countertop is inside the bundle: never priced twice
    expect(q.lines.filter((l) => l.component === 'countertop')).toHaveLength(0);
    const m = f.index.mappings.find((x) => x.productId === 'Milu' && x.component === 'cabinet' && x.sizeIndex === 0)!;
    expect(m.match).toBe('exact_sku');
    expect(m.articleCode).toBe('MIL80A');
  });

  it('prices a built-in basin top from the single parts in the UE SKUs and skips the vessel sink', () => {
    const basin = f.catalog.space('Milu', 1)!.countertop.findIndex((m) => m.kind === 'BuiltIn');
    const q = f.catalog.quote({ productId: 'Milu', sizeIndex: 1, colourIndex: 0, countertopSizeIndex: basin, countertopColourIndex: 0 });
    expect(q.lines.slice(0, 2).map((l) => l.articleCode)).toEqual(['MIL100A', 'U100WF']);
    expect(q.lines.some((l) => l.component === 'sink')).toBe(false);
    expect(q.lines.find((l) => l.component === 'faucet')!.articleCode).toMatch(/^OL-869003-/); // integrated faucet on a basin top
  });

  it('adds the wall cabinet (closet) article with its scraped price', () => {
    const q = f.catalog.quote({ productId: 'Avenu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 0, closetSizeIndex: 0, closetColourIndex: 0 });
    const closet = q.lines.find((l) => l.component === 'closet')!;
    expect(closet.articleCode).toBe('APR110');
    expect(closet.price).toBe(1258);
    expect(q.total).toBe(q.lines.reduce((a, l) => a + l.price, 0));
  });

  it('flags Terra/Tuma (not on oliveeka.by) as estimated and records data issues', () => {
    const terra = f.index.mappings.filter((m) => m.collection === 'Terra' && m.component === 'cabinet');
    expect(terra.length).toBeGreaterThan(0);
    expect(terra.every((m) => m.match === 'estimated' && !!m.estimatedFrom)).toBe(true);
    expect(f.report).toContain('Tuma: CombinationsMetadata size 1 carries a SKU of another collection (QA-002)');
    expect(f.report).toMatch(/\| Milu \| cabinet \| 2 \|/);
  });

  it('rejects countertop colours outside the resolved (size-filtered) list', () => {
    expect(f.catalog.validate({ productId: 'Milu', sizeIndex: 1, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 3 })).toMatch(/не подходит/);
    expect(f.catalog.validate({ productId: 'Milu', sizeIndex: 1, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 2 })).toBeNull();
    // resolved colour 0 of the Milu 100 countertop is the 1000 mm white top
    expect(f.catalog.space('Milu', 1)!.countertop[0].colours[0].sku).toBe('CMA100W');
  });
});

describe('QA-007: mapping keys live in the booth-resolved option space', () => {
  const f = fixtureIndex();
  const qa = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qa_catalog_matrix_ue.json'), 'utf8'));

  it("every option in QA's UE option matrix has exactly one mapping, with the same article code where QA saw one", () => {
    let checked = 0;
    for (const r of qa.rows) {
      const m0 = String(r.productId).match(/^([^@]+)(?:@size(\d+))?(?:@top\d+-(surface|builtin))?$/)!;
      const productId = m0[1];
      const cab = m0[2] === undefined ? undefined : Number(m0[2]);
      const kind = m0[3] === 'builtin' ? 'BuiltIn' : 'SurfaceMounted';
      const shared = !['cabinet', 'closet'].includes(r.component);
      const ms = f.index.mappings.filter(
        (m) =>
          m.productId === productId &&
          m.component === r.component &&
          m.sizeIndex === r.sizeIndex &&
          m.colourIndex === r.colourIndex &&
          (!shared || m.cabinetSizeIndex === cab) &&
          (r.component !== 'faucet' || m.topKind === kind),
      );
      expect(ms.length, JSON.stringify(r)).toBe(1);
      const qaSku = /(?:^| )sku=([A-Z0-9+-]+)/.exec(r.ident ?? '')?.[1];
      if (qaSku && ['countertop', 'sink'].includes(r.component)) expect(ms[0].partCode ?? ms[0].articleCode, JSON.stringify(r)).toBe(qaSku);
      checked++;
    }
    expect(checked).toBe(qa.rows.length);
  });

  it('skips dangling ids (QA-001) and never offers a wall cabinet for Terra/Tuma (QA-003)', () => {
    expect(f.index.unmapped.some((u) => u.productId === 'Milu' && u.component === 'mirror' && /NewRow_8/.test(u.reason))).toBe(true);
    expect(f.index.unmapped.some((u) => u.productId === 'Tuma' && /ForTumaNerkarucvoxFlowBrown/.test(u.reason))).toBe(true);
    expect(f.catalog.space('Milu', 0)!.mirror).toHaveLength(9);
    expect(f.catalog.validate({ productId: 'Terra', sizeIndex: 0, colourIndex: 0, closetSizeIndex: 0 })).toMatch(/навесного шкафа нет/);
    expect(f.index.mappings.some((m) => (m.productId === 'Terra' || m.productId === 'Tuma') && m.component === 'closet')).toBe(false);
  });

  it('QA-002: does not trust the Tuma size-1 SKU (URB100M) or the Urban closet metadata (URB80M)', () => {
    expect(f.index.mappings.filter((m) => m.productId === 'Tuma' && m.component === 'cabinet').every((m) => !m.articleCode.startsWith('URB'))).toBe(true);
    expect(f.index.mappings.filter((m) => m.productId === 'Urban' && m.component === 'closet').every((m) => m.articleCode === 'UPM110')).toBe(true);
  });

  it('faucet options follow the countertop type (Standard on surface-mounted, Integrated on built-in basins)', () => {
    const sp = f.catalog.space('Milu', 0)!;
    expect(sp.faucet.SurfaceMounted).toHaveLength(4);
    expect(sp.faucet.BuiltIn).toHaveLength(3);
    const basin = sp.countertop.findIndex((m) => m.kind === 'BuiltIn');
    expect(f.catalog.validate({ productId: 'Milu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: basin, countertopColourIndex: 0, faucetSizeIndex: 3 })).toMatch(/смеситель/);
    expect(f.catalog.validate({ productId: 'Milu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 0, faucetSizeIndex: 3 })).toBeNull();
  });
});
