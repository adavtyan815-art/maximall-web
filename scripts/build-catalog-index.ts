/**
 * X2: joins the UE DataTable export with the scraped oliveeka.by products.
 * Usage: npx tsx scripts/build-catalog-index.ts [ueExportDir] [--report <file>]
 * Inputs : D:/AI_Consultant_Workspace/catalog/ue_export/raw (default), data/catalog/scraped_products.json
 * Outputs: data/catalog/index.json, docs/AI_Consultant_Expo/catalog_coverage.md (or --report path)
 */
import fs from 'fs';
import path from 'path';
import { buildCatalogIndex, loadUeExport } from '../src/ai/catalog/mapping';

const args = process.argv.slice(2);
const ri = args.indexOf('--report');
const report = ri >= 0 ? args[ri + 1] : 'D:/awsTemplate_GameLift/docs/AI_Consultant_Expo/catalog_coverage.md';
const ueDir = args.find((a, i) => !a.startsWith('--') && i !== ri + 1) ?? process.env.UE_EXPORT_DIR ?? 'D:/AI_Consultant_Workspace/catalog/ue_export/raw';
const root = path.join(__dirname, '..');
const scraped = JSON.parse(fs.readFileSync(path.join(root, 'data', 'catalog', 'scraped_products.json'), 'utf8'));
const ue = loadUeExport(ueDir);
const { index, report: md } = buildCatalogIndex(ue, scraped);
const out = path.join(root, 'data', 'catalog', 'index.json');
fs.writeFileSync(out, JSON.stringify(index, null, 1), 'utf8');
fs.writeFileSync(report, md, 'utf8');
const count = (k: string) => index.mappings.filter((m) => m.match === k).length;
console.log(JSON.stringify({ out, report, ueProducts: ue.products.length, shared: ue.shared.length, mappings: index.mappings.length, bundles: index.bundles.length, exact_sku: count('exact_sku'), name_size_colour: count('name_size_colour'), estimated: count('estimated'), unmapped: index.unmapped.length }, null, 2));
