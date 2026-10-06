import fs from 'fs';
import path from 'path';
import { buildCatalogIndex, loadUeExport } from '../../src/ai/catalog/mapping';
import { CatalogIndex } from '../../src/ai/catalog/index';

/** Builds the catalogue index from the committed fixtures (real UE export 2026-09-30 + real scrape). */
export function fixtureIndex() {
  const ue = loadUeExport(path.join(__dirname, '..', 'fixtures', 'ue_export'));
  const scraped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'catalog', 'scraped_products.json'), 'utf8'));
  const built = buildCatalogIndex(ue, scraped);
  return { ue, scraped, ...built, catalog: new CatalogIndex(built.index) };
}
