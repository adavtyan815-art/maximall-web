import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { randomId62 } from '../util/rateLimit';
import QRCode from 'qrcode';
import type { Browser } from 'puppeteer-core';
import type { CatalogIndex } from '../catalog/index';
import { buildSpec, SaveRecord, Spec } from './spec';
import { floorPlanSvg, SetFootprint } from './floorplan';
import { isGuest } from '../util/identity';
import { consultantNotes, dossierHtml, expiredPageHtml, shortPageHtml } from './template';

/** Deploy: CHROME_PATH, else the Windows install, else the usual Linux / Alpine (apk chromium) locations. */
export const CHROME_PATH =
  process.env.CHROME_PATH ??
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((x) => fs.existsSync(x)) ?? '/usr/bin/chromium-browser');
/** Chrome refuses to run as root without --no-sandbox (the Docker image runs as root). CHROME_NO_SANDBOX=1 forces it. */
const CHROME_ARGS = ['--disable-gpu', '--no-first-run', ...(process.env.CHROME_NO_SANDBOX === '1' || (process.platform !== 'win32' && process.getuid?.() === 0) ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])];

export interface DossierRecord {
  dossierId: string;
  shortId: string;
  sessionId: string;
  username: string;
  saveId: string;
  saveName?: string;
  renderIds: string[];
  createdAt: string;
  total: number;
  sets: string[];
  hasFlags: boolean;
  /** false for guests (guest-*, guest_tester): the dossier is built but no lead is recorded. */
  lead: boolean;
  /** QA-060: the visitor asked on /d/:shortId for a salon visit (consent given), ISO time. */
  visitRequestedAt?: string;
}

/** QA-060: the consent text shown next to the checkbox; stored verbatim with the request. */
export const VISIT_CONSENT_RU = 'Согласен(на), чтобы салон связался со мной по этому проекту';

export type VisitResult = { ok: true; already: boolean; requestedAt: string } | { ok: false; status: number; code: string; message: string };
export interface DossierResponse {
  dossierId: string;
  pdfUrl: string;
  shortUrl: string;
  qrPngUrl: string;
}

let browserP: Promise<Browser> | null = null;
async function browser(): Promise<Browser> {
  if (!browserP) {
    const puppeteer = await import('puppeteer-core');
    browserP = puppeteer.launch({ executablePath: CHROME_PATH, headless: true, args: CHROME_ARGS });
    browserP.catch(() => (browserP = null));
  }
  return browserP;
}
export async function closeBrowser() {
  if (browserP) {
    const b = await browserP.catch(() => null);
    browserP = null;
    await b?.close().catch(() => undefined);
  }
}

export class DossierError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Dossier (task 7): save record (+ metrics) -> specification from the planner booths of this instance -> Russian HTML
 * (plan SVG, spec with BYN prices and «цена уточняется» flags, renders, notes, QR) -> PDF with the installed Chrome.
 * Lead record = username + saveId + dossierId + timestamp (data/dossiers/leads.jsonl). No contact form.
 */
export class DossierService {
  readonly dir: string;
  constructor(
    private catalog: () => CatalogIndex | null,
    private savesDir: string,
    private renderDir: string,
    private publicBaseUrl: () => string,
    dir = path.join(process.cwd(), 'data', 'dossiers'),
  ) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private indexFile() {
    return path.join(this.dir, 'index.json');
  }
  records(): DossierRecord[] {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile(), 'utf8'));
    } catch {
      return [];
    }
  }
  find(idOrShort: string) {
    return this.records().find((r) => r.dossierId === idOrShort || r.shortId === idOrShort);
  }
  pdfPath(dossierId: string) {
    if (!/^[a-z0-9-]{6,40}$/.test(dossierId)) return null;
    const f = path.join(this.dir, `${dossierId}.pdf`);
    return fs.existsSync(f) ? f : null;
  }
  qrPath(dossierId: string) {
    if (!/^[a-z0-9-]{6,40}$/.test(dossierId)) return null;
    const f = path.join(this.dir, `${dossierId}.qr.png`);
    return fs.existsSync(f) ? f : null;
  }

  loadSave(username: string, saveId?: string): SaveRecord {
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username) || username.startsWith('.')) throw new DossierError(400, 'invalid username');
    const f = path.join(this.savesDir, `${username}.json`);
    if (!fs.existsSync(f)) throw new DossierError(404, 'no saves for this user');
    const saves: SaveRecord[] = JSON.parse(fs.readFileSync(f, 'utf8'));
    const s = saveId ? saves.find((x) => x.saveId === saveId) : saves[saves.length - 1];
    if (!s) throw new DossierError(404, 'save not found');
    return s;
  }

  private images(renderIds: string[], save: SaveRecord) {
    const out: { src: string; caption: string }[] = [];
    for (const id of renderIds) {
      if (!/^[A-Za-z0-9_.-]{3,80}$/.test(id)) continue;
      // v2.2 P3-02: a salon booth photo is the clean 3D capture of that booth (no AI render).
      let booth = false;
      try {
        booth = JSON.parse(fs.readFileSync(path.join(this.renderDir, id, 'meta.json'), 'utf8'))?.preset === 'booth';
      } catch {
        /* no meta: a constructor render */
      }
      for (const [name, caption] of [
        ['final', 'Фото проекта (ИИ-визуализация, мебель — исходные пиксели из 3D)'],
        ['preview', 'Фото проекта (предпросмотр)'],
        ['beauty', 'Кадр из 3D-комнаты'],
      ] as const) {
        const f = path.join(this.renderDir, id, `${name}.png`);
        if (fs.existsSync(f)) {
          out.push({ src: `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`, caption: booth ? 'Фото стенда в салоне (кадр из 3D)' : caption });
          break;
        }
      }
    }
    if (!out.length && typeof save.thumbnail === 'string' && save.thumbnail.length > 100) {
      const src = save.thumbnail.startsWith('data:') ? save.thumbnail : `data:image/png;base64,${save.thumbnail}`;
      out.push({ src, caption: 'Кадр из 3D-комнаты' });
    }
    return out;
  }

  async build(req: { sessionId: string; username: string; saveId?: string; renderIds?: string[]; conversationNotes?: string[]; placements?: Record<string, any> }): Promise<{ response: DossierResponse; record: DossierRecord; spec: Spec }> {
    const catalog = this.catalog();
    if (!catalog) throw new DossierError(503, 'catalog index not built');
    const save = this.loadSave(req.username, req.saveId);
    const spec = buildSpec(save, catalog);
    // Security review: both ids are capabilities (the PDF / mobile page of a visitor's project) -> unguessable.
    const dossierId = `d-${crypto.randomBytes(16).toString('hex')}`; // 128 bits
    const shortId = randomId62(70); // 12 base62 chars, ~71 bits
    const base = this.publicBaseUrl();
    const shortUrl = `${base}/d/${shortId}`;
    const qr = await QRCode.toBuffer(shortUrl, { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M' });
    fs.writeFileSync(path.join(this.dir, `${dossierId}.qr.png`), qr);
    const setSizes: Record<string, SetFootprint> = {};
    for (const s of spec.sets) setSizes[s.setId] = { w: catalog.footprintWidthCm(s.config) ?? 80, d: 50, label: s.title.split(',')[0].replace('Oliveeka ', '') };
    // QA-038: real footprint + placement from UE (get_state at save time, or metrics.sets[].placement) when known
    const placements: Record<string, any> = { ...(req.placements ?? {}) };
    for (const m of save.metrics?.sets ?? []) if (m.setId && (m as any).placement && !placements[m.setId]) placements[m.setId] = (m as any).placement;
    for (const [id, p] of Object.entries(placements)) {
      const fp = p?.footprintCm ?? {};
      const prod = (spec.layout?.cabinetSets ?? []).find((c: any) => String(c.id) === id)?.product;
      setSizes[id] = { ...(setSizes[id] ?? { w: 80, d: 50, label: prod ? String(prod) : undefined }), ...(fp.width ? { w: Number(fp.width) } : {}), ...(fp.depth ? { d: Number(fp.depth) } : {}), placement: { segmentId: Number(p.segmentId), offsetCm: Number(p.offsetCm), side: p.side } };
    }
    const html = dossierHtml({
      dossierId,
      username: req.username,
      createdAt: new Date(),
      catalogSyncedAt: catalog.syncedAt,
      spec,
      floorPlanSvg: floorPlanSvg(spec.layout, { widthPx: 620, setSizes }),
      images: this.images(req.renderIds ?? [], save),
      qrDataUri: `data:image/png;base64,${qr.toString('base64')}`,
      shortUrl,
      notes: [...(req.conversationNotes ?? []), ...consultantNotes(spec, catalog.data.products)],
      consultantName: 'Ольга',
    });
    fs.writeFileSync(path.join(this.dir, `${dossierId}.html`), html, 'utf8');
    const b = await browser();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(path.join(this.dir, `${dossierId}.pdf`), pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
    const record: DossierRecord = {
      dossierId,
      shortId,
      sessionId: req.sessionId,
      username: req.username,
      saveId: save.saveId,
      saveName: save.saveName,
      renderIds: req.renderIds ?? [],
      createdAt: new Date().toISOString(),
      total: spec.total,
      sets: spec.sets.map((s) => `${s.title} — ${s.quote.total} BYN`),
      hasFlags: spec.hasEstimated || spec.hasUnpriced,
      lead: !isGuest(req.username),
    };
    fs.writeFileSync(this.indexFile(), JSON.stringify([...this.records(), record], null, 1), 'utf8');
    // Lead record (decision 6): username + saveId + dossierId + timestamp. Guests (guest-*, UE guest_tester) are never leads.
    if (!isGuest(record.username)) fs.appendFileSync(path.join(this.dir, 'leads.jsonl'), JSON.stringify({ ts: record.createdAt, username: record.username, saveId: record.saveId, dossierId, sessionId: req.sessionId, total: spec.total }) + '\n', 'utf8');
    return { response: { dossierId, pdfUrl: `${base}/api/dossier/${dossierId}.pdf`, shortUrl, qrPngUrl: `${base}/api/dossier/${dossierId}/qr.png` }, record, spec };
  }

  /** QA-058: the record is known but its PDF was removed by the retention job. */
  isExpired(idOrShort: string): boolean {
    const r = this.find(idOrShort);
    return !!r && !fs.existsSync(path.join(this.dir, `${r.dossierId}.pdf`));
  }
  expiredPage(): string {
    return expiredPageHtml();
  }

  shortPage(shortId: string): string | null {
    const r = this.find(shortId);
    if (!r || r.shortId !== shortId) return null;
    if (this.isExpired(shortId)) return null;
    return shortPageHtml({
      username: r.username,
      pdfUrl: `${this.publicBaseUrl()}/api/dossier/${r.dossierId}.pdf`,
      total: r.total,
      sets: r.sets,
      hasFlags: r.hasFlags,
      saveName: r.saveName,
      shortId: r.shortId,
      canRequestVisit: r.lead !== false && !isGuest(r.username),
      visitRequestedAt: r.visitRequestedAt,
      consentText: VISIT_CONSENT_RU,
    });
  }

  /**
   * QA-060 (Blueprint 4b #8 / 4c #7, decision 6): «Записаться на визит» records a visit request on the existing lead
   * (username + dossierId + time + consent) — no new personal-data form. Guests cannot (no lead identity). Idempotent.
   */
  requestVisit(shortId: string, consent: unknown): VisitResult {
    const all = this.records();
    const r = all.find((x) => x.shortId === shortId);
    if (!r) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Проект не найден.' };
    if (this.isExpired(shortId)) return { ok: false, status: 410, code: 'EXPIRED', message: 'Ссылка устарела — позвоните в салон, мы поможем.' };
    if (r.lead === false || isGuest(r.username))
      return { ok: false, status: 403, code: 'LOGIN_REQUIRED', message: 'Чтобы записаться на визит, войдите в приложение MaxiMall под своим логином и сохраните проект — так салон узнает, о каком проекте речь.' };
    if (consent !== true) return { ok: false, status: 400, code: 'CONSENT_REQUIRED', message: 'Отметьте согласие, чтобы салон мог связаться с вами.' };
    if (r.visitRequestedAt) return { ok: true, already: true, requestedAt: r.visitRequestedAt };
    r.visitRequestedAt = new Date().toISOString();
    fs.writeFileSync(this.indexFile(), JSON.stringify(all, null, 1), 'utf8');
    fs.appendFileSync(
      path.join(this.dir, 'leads.jsonl'),
      JSON.stringify({ ts: r.visitRequestedAt, type: 'visit_request', username: r.username, saveId: r.saveId, dossierId: r.dossierId, consent: true, consentText: VISIT_CONSENT_RU }) + '\n',
      'utf8',
    );
    return { ok: true, already: false, requestedAt: r.visitRequestedAt };
  }
}
