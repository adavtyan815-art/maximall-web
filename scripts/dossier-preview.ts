/**
 * Builds a demo dossier from the real catalogue index and a demo save, then screenshots the HTML pages to PNG for a
 * visual check. Usage: npx tsx scripts/dossier-preview.ts [outDir]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CatalogIndex } from '../src/ai/catalog/index';
import { DossierService, closeBrowser, CHROME_PATH } from '../src/ai/dossier/service';
import { demoSave } from '../test/helpers/save';

(async () => {
  const out = process.argv[2] ?? path.join(os.tmpdir(), 'dossier-preview');
  fs.mkdirSync(out, { recursive: true });
  const catalog = CatalogIndex.load();
  const savesDir = path.join(out, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });
  fs.writeFileSync(path.join(savesDir, 'anna.json'), JSON.stringify([demoSave(catalog, { withMetrics: true }).save]));
  const svc = new DossierService(() => catalog, savesDir, path.join(out, 'renders'), () => 'http://localhost:3000', path.join(out, 'dossiers'));
  const t0 = Date.now();
  const { response } = await svc.build({ sessionId: 'demo:anna', username: 'anna' });
  console.log('built in', Date.now() - t0, 'ms', response);
  await closeBrowser();
  const puppeteer = await import('puppeteer-core');
  const b = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
  const page = await b.newPage();
  await page.setViewport({ width: 794, height: 1123 });
  await page.emulateMediaType('print');
  await page.goto('file:///' + path.join(out, 'dossiers', `${response.dossierId}.html`).replace(/\\/g, '/'));
  await page.screenshot({ path: path.join(out, 'dossier_full.png'), fullPage: true });
  await b.close();
  console.log('screenshot', path.join(out, 'dossier_full.png'));
})();
