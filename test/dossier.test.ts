import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { demoSave } from './helpers/save';
import { DossierService, closeBrowser } from '../src/ai/dossier/service';
import { buildSpec } from '../src/ai/dossier/spec';
import { floorPlanSvg } from '../src/ai/dossier/floorplan';
import { validator, expectValid } from './helpers/contracts';

const f = fixtureIndex();

async function pdfText(file: string): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    text += c.items.map((i: any) => i.str).join(' ') + '\n';
  }
  return text.replace(/[  ]/g, ' ');
}

afterAll(() => closeBrowser());

describe('dossier (task 7)', () => {
  it('specification contains only planner booths of the instance, priced from the index', () => {
    const { save, config } = demoSave(f.catalog);
    const spec = buildSpec(save as any, f.catalog);
    expect(spec.source).toBe('boothStates');
    expect(spec.sets).toHaveLength(1); // the salon booth (no plannerInstanceId) is excluded
    expect(spec.sets[0].config).toEqual(config);
    expect(spec.total).toBe(f.catalog.quote(config).total);
    const withMetrics = buildSpec(demoSave(f.catalog, { withMetrics: true }).save as any, f.catalog);
    expect(withMetrics.source).toBe('metrics');
    expect(withMetrics.floorAreaM2).toBe(5);
  });

  it('draws the SVG floor plan from the layout JSON (walls, door, set)', () => {
    const { save } = demoSave(f.catalog);
    const svg = floorPlanSvg(save.planner, { setSizes: { 'set-1': { w: 115, d: 50, label: 'Milu 80', placement: { segmentId: 2, offsetCm: 125, side: 'left' } } } });
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<line /g) ?? []).length).toBeGreaterThanOrEqual(5); // 4 walls + door gap
    expect(svg).toContain('240 см'); // clear inner face: 250 centreline − 10 wall (QA-023)
    expect(svg).toContain('Milu 80');
    expect(svg).toContain('stroke-dasharray'); // door swing
  });

  it('produces a Russian PDF with the article codes and the BYN total; records the lead; short page and QR', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-'));
    const savesDir = path.join(tmp, 'saves');
    fs.mkdirSync(savesDir);
    const { save, config } = demoSave(f.catalog, { withMetrics: true });
    fs.writeFileSync(path.join(savesDir, 'anna.json'), JSON.stringify([save]));
    const svc = new DossierService(() => f.catalog, savesDir, path.join(tmp, 'renders'), () => 'http://expo.local:3000', path.join(tmp, 'dossiers'));
    const t0 = Date.now();
    const { response, spec } = await svc.build({ sessionId: 'inst-1:anna', username: 'anna' });
    const ms = Date.now() - t0;
    expectValid(validator('maximall/ai/dossier-api.schema.json#/$defs/dossierResponse'), response);
    expect(response.pdfUrl).toMatch(/^http:\/\/expo\.local:3000\/api\/dossier\/d-[a-z0-9-]+\.pdf$/);
    expect(response.dossierId).toMatch(/^d-[0-9a-f]{32}$/); // security review: 128-bit capability
    expect(response.shortUrl).toMatch(/\/d\/[A-Za-z0-9]{12}$/); // >= 64 bits
    const pdf = svc.pdfPath(response.dossierId)!;
    expect(fs.readFileSync(pdf).subarray(0, 4).toString()).toBe('%PDF');
    const text = await pdfText(pdf);
    const q = f.catalog.quote(config);
    for (const l of q.lines) expect(text, l.articleCode).toContain(l.articleCode);
    const totalStr = new Intl.NumberFormat('ru-RU').format(spec.total).replace(/[  ]/g, ' ');
    expect(text).toContain(`Итого: ${totalStr} BYN`);
    expect(text).toContain('Спецификация');
    expect(text).toContain('План помещения');
    if (q.unpriced.length) expect(text).toContain('цена уточняется');
    expect(text).not.toContain('Urban'); // salon booth is not in the spec
    const lead = fs.readFileSync(path.join(tmp, 'dossiers', 'leads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lead[0]).toMatchObject({ username: 'anna', saveId: 'save-demo-1', dossierId: response.dossierId });
    const shortId = response.shortUrl.split('/d/')[1];
    const page = svc.shortPage(shortId)!;
    expect(page).toContain('Скачать PDF');
    expect(page).toContain(response.pdfUrl);
    expect(svc.shortPage('nope')).toBeNull();
    expect(fs.readFileSync(svc.qrPath(response.dossierId)!).subarray(1, 4).toString()).toBe('PNG');
    expect(ms).toBeLessThan(30000);
  });

  it('rejects unsafe usernames and reports missing saves', async () => {
    const svc = new DossierService(() => f.catalog, os.tmpdir(), os.tmpdir(), () => '', fs.mkdtempSync(path.join(os.tmpdir(), 'd-')));
    await expect(svc.build({ sessionId: 's', username: '../x' })).rejects.toThrow(/invalid username/);
    await expect(svc.build({ sessionId: 's', username: 'nobody-here' })).rejects.toThrow(/no saves/);
  });
});

import { isGuest } from '../src/ai/util/identity';
describe('guests are never leads (v1.3: UE "guest_tester" = nobody logged in)', () => {
  it('isGuest covers the page guest id and the UE guest login', () => {
    expect(isGuest('guest_tester')).toBe(true);
    expect(isGuest('guest-3f9a')).toBe(true);
    expect(isGuest('')).toBe(true);
    expect(isGuest('anna')).toBe(false);
  });
  it('a guest_tester dossier is built but records no lead', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-g-'));
    const savesDir = path.join(tmp, 'saves');
    fs.mkdirSync(savesDir);
    fs.writeFileSync(path.join(savesDir, 'guest_tester.json'), JSON.stringify([demoSave(f.catalog, { withMetrics: true }).save]));
    const svc = new DossierService(() => f.catalog, savesDir, path.join(tmp, 'r'), () => 'http://x', path.join(tmp, 'd'));
    const { response, record } = await svc.build({ sessionId: 'inst-9:guest_tester', username: 'guest_tester' });
    expect(svc.pdfPath(response.dossierId)).not.toBeNull();
    expect(record.lead).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'd', 'leads.jsonl'))).toBe(false);
  });
});
