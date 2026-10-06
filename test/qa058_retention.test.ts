import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { runRetention, refuseReason, retentionAgesFromEnv } from '../src/ai/util/retention';
import { createAiModule } from '../src/ai';
import { fixtureIndex } from './helpers/catalog';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';

/** QA-058: retention with temp dirs and fake mtimes (never the real data/ folder). */
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

function file(p: string, ageDays: number, body = 'x'.repeat(100)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ret-'));
  const d = (x: string) => path.join(root, x);
  const f = {
    renderOld: [file(d('renders/rn-old/beauty.png'), 8), file(d('renders/rn-old/final.png'), 8)],
    renderNew: file(d('renders/rn-new/final.png'), 2),
    clipOld: file(d('ai_clips/aaaaaaaaaaaaaaaa.pcm'), 2),
    clipNew: file(d('ai_clips/bbbbbbbbbbbbbbbb.pcm'), 0.5),
    dossierOld: [file(d('dossiers/d-old.pdf'), 31), file(d('dossiers/d-old.qr.png'), 31)],
    dossierNew: file(d('dossiers/d-new.pdf'), 10),
    dossierIndex: file(d('dossiers/index.json'), 90, '[]'),
    leads: file(d('dossiers/leads.jsonl'), 90, '{}\n'),
    logOld: file(d('ai_logs/inst_a.jsonl'), 40),
    logNew: file(d('ai_logs/inst_b.jsonl'), 5),
    arOld: [file(d('ar/0123456789abcdef01234567.glb'), 45), file(d('ar/0123456789abcdef01234567.json'), 45)],
    ledger: file(d('runtime/api_spend.jsonl'), 365),
    saves: file(d('saves/anna.json'), 365),
    catalog: file(d('catalog/index.json'), 365),
  };
  const targets = [
    { name: 'renders', dir: d('renders'), maxAgeDays: 7 },
    { name: 'clips', dir: d('ai_clips'), maxAgeDays: 1 },
    { name: 'dossiers', dir: d('dossiers'), maxAgeDays: 30 },
    { name: 'logs', dir: d('ai_logs'), maxAgeDays: 30 },
    { name: 'ar', dir: d('ar'), maxAgeDays: 30 },
  ];
  return { root, d, f, targets };
}
const exists = (p: string) => fs.existsSync(p);

describe('QA-058 retention', () => {
  it('defaults: renders 7, clips 1, dossiers 30, logs 30 days (AR 30)', () => {
    expect(retentionAgesFromEnv({})).toEqual({ renders: 7, clips: 1, dossiers: 30, logs: 30, ar: 30 });
    expect(retentionAgesFromEnv({ AI_RETENTION_RENDERS_DAYS: '3', AI_RETENTION_CLIPS_DAYS: '0' })).toMatchObject({ renders: 3, clips: 0 });
  });

  it('deletes only expired files inside the targets; leads, index, ledger, saves and catalog stay; counts and bytes', () => {
    const { f, d, targets } = tree();
    const logs: string[] = [];
    const res = runRetention(targets, { allowedRoots: targets.map((t) => t.dir), now: NOW, log: (m) => logs.push(m) });
    for (const p of [...f.renderOld, f.clipOld, ...f.dossierOld, f.logOld, ...f.arOld]) expect(exists(p), p).toBe(false);
    for (const p of [f.renderNew, f.clipNew, f.dossierNew, f.dossierIndex, f.leads, f.logNew, f.ledger, f.saves, f.catalog]) expect(exists(p), p).toBe(true);
    expect(exists(d('renders/rn-old'))).toBe(false); // the emptied render folder
    expect(exists(d('renders'))).toBe(true); // never the target itself
    const by = Object.fromEntries(res.map((r) => [r.name, r]));
    expect([by.renders.files, by.clips.files, by.dossiers.files, by.logs.files, by.ar.files]).toEqual([2, 1, 2, 1, 2]);
    expect(by.renders.bytes).toBe(200);
    expect(by.renders.dirsRemoved).toBe(1);
    expect(logs.some((l) => /\[Retention\] renders: deleted 2 files/.test(l))).toBe(true);
  });

  it('AI_RETENTION_DRY_RUN: logs what would be deleted, deletes nothing', () => {
    const { f, targets } = tree();
    const logs: string[] = [];
    const res = runRetention(targets, { allowedRoots: targets.map((t) => t.dir), now: NOW, dryRun: true, log: (m) => logs.push(m) });
    for (const p of [...f.renderOld, f.clipOld, ...f.dossierOld, f.logOld, ...f.arOld]) expect(exists(p), p).toBe(true);
    expect(res.reduce((a, r) => a + r.files, 0)).toBe(8);
    expect(logs.filter((l) => l.includes('DRY RUN')).length).toBe(8);
    expect(logs.some((l) => /renders: would delete 2 files/.test(l))).toBe(true);
  });

  it('refuses folders outside the configured data dirs, protected folders and the filesystem root', () => {
    const { d, f } = tree();
    const allowed = [d('renders')];
    expect(refuseReason(d('ai_logs'), allowed)).toMatch(/outside/);
    expect(refuseReason(d('renders/../saves'), allowed)).toMatch(/protected|outside/);
    expect(refuseReason(d('catalog'), [d('catalog')])).toMatch(/protected/);
    expect(refuseReason(d('saves'), [d('saves')])).toMatch(/protected/);
    const fsRoot = path.parse(d('x')).root;
    expect(refuseReason(fsRoot, [fsRoot])).toMatch(/root/);
    const logs: string[] = [];
    const res = runRetention(
      [
        { name: 'evil', dir: d('saves'), maxAgeDays: 1 },
        { name: 'out', dir: d('ai_logs'), maxAgeDays: 1 },
      ],
      { allowedRoots: allowed, now: NOW, log: (m) => logs.push(m) },
    );
    expect(res.every((r) => r.skipped?.startsWith('refused'))).toBe(true);
    expect(exists(f.saves) && exists(f.logOld)).toBe(true);
    expect(logs.filter((l) => l.includes('REFUSED')).length).toBe(2);
  });

  it('0 days disables a target', () => {
    const { f, targets } = tree();
    const res = runRetention(
      targets.map((t) => (t.name === 'clips' ? { ...t, maxAgeDays: 0 } : t)),
      { allowedRoots: targets.map((t) => t.dir), now: NOW, log: () => undefined },
    );
    expect(res.find((r) => r.name === 'clips')!.skipped).toBe('disabled');
    expect(exists(f.clipOld)).toBe(true);
  });
});

describe('QA-058 in the module: expired dossier links, start policy', () => {
  const saved = { ...process.env };
  let server: http.Server | null = null;
  afterAll(async () => {
    process.env = saved;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  it('expired dossier -> /d/:shortId and the PDF link show «Ссылка устарела» (410), fresh ones still work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retmod-'));
    const fx = fixtureIndex();
    delete process.env.AI_RETENTION_DRY_RUN;
    const mod = createAiModule({
      catalog: fx.catalog,
      logDir: path.join(root, 'ai_logs'),
      clips: new ClipStore(path.join(root, 'ai_clips')),
      renderDir: path.join(root, 'renders'),
      savesDir: path.join(root, 'saves'),
      dossierDir: path.join(root, 'dossiers'),
      arDir: path.join(root, 'ar'),
      providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), ledger: new CostLedger({ file: path.join(root, 'spend.jsonl') }), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} } as any,
    });
    const rec = (id: string, short: string) => ({ dossierId: id, shortId: short, sessionId: 's', username: 'olga', saveId: 's1', renderIds: [], createdAt: new Date().toISOString(), total: 1, sets: ['Milu 80 — 1 BYN'], hasFlags: false, lead: true });
    const oldId = 'd-' + '1'.repeat(32);
    const newId = 'd-' + '2'.repeat(32);
    fs.writeFileSync(path.join(mod.dossier.dir, 'index.json'), JSON.stringify([rec(oldId, 'OldShortId12'), rec(newId, 'NewShortId12')]));
    file(path.join(mod.dossier.dir, `${oldId}.pdf`), 31, '%PDF-1.4');
    file(path.join(mod.dossier.dir, `${newId}.pdf`), 1, '%PDF-1.4');
    mod.runRetention();
    expect(exists(path.join(mod.dossier.dir, 'index.json'))).toBe(true);
    const app = express();
    app.use(mod.router);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const oldPage = await fetch(`${url}/d/OldShortId12`);
    expect(oldPage.status).toBe(410);
    expect(await oldPage.text()).toContain('Ссылка устарела');
    const oldPdf = await fetch(`${url}/api/dossier/${oldId}.pdf`);
    expect(oldPdf.status).toBe(410);
    expect(await oldPdf.text()).toContain('Ссылка устарела');
    expect((await fetch(`${url}/d/NewShortId12`)).status).toBe(200);
    expect((await fetch(`${url}/d/NoSuchShort1`)).status).toBe(404);
    const visit = await fetch(`${url}/d/OldShortId12/visit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: true }) });
    expect(visit.status).toBe(410);
    // start policy: off by default in LOCAL_MODE, on with AI_RETENTION_ENABLED=1 (or outside LOCAL_MODE)
    process.env.LOCAL_MODE = '1';
    delete process.env.AI_RETENTION_ENABLED;
    expect(mod.startRetention()).toBeNull();
    process.env.AI_RETENTION_ENABLED = '1';
    const stop = mod.startRetention();
    expect(typeof stop).toBe('function');
    stop!();
  });
});
