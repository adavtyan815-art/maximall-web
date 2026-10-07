import fs from 'fs';
import path from 'path';
import { compositeProduct, decodeCapture, modelInputs, productMask } from './composite';
import { renderPrompt, RenderProvider } from './providers';
import { t } from '../i18n';

export interface RenderMeta {
  renderId: string;
  sessionId: string;
  username?: string;
  preset?: 'corner' | 'frontal' | 'wide' | 'booth';
  /** v2.2: the salon booth (level actor name) of a preset "booth" capture. */
  boothId?: string;
  width: number;
  height: number;
  fovDeg?: number;
  camera?: any;
  products?: any[];
  finishes?: any;
  roomAreaM2?: number;
  /** modern | classic | scandi | loft (render prompt style); the backend fills it from the visitor preference. */
  style?: string;
  /** Filled by the backend from the session (build_room / get_state); false when unknown (most planner rooms). */
  hasWindow?: boolean;
}
export type RenderStage = 'capturing' | 'preview' | 'final' | 'failed';
export interface RenderEvent {
  renderId: string;
  stage: RenderStage;
  url?: string;
  beautyUrl?: string;
  reason?: string;
  /** v2.2: "capture" = the clean UE capture is the photo (salon booths); "ai" = AI render (constructor). */
  source?: 'ai' | 'capture';
}

/** Validates meta (render-api.schema.json#/$defs/meta required fields). Returns a reason or null. */
export function checkMeta(m: any): string | null {
  if (!m || typeof m !== 'object') return 'meta must be a JSON object';
  if (typeof m.renderId !== 'string' || !/^[A-Za-z0-9_.-]{3,80}$/.test(m.renderId)) return 'meta.renderId must be [A-Za-z0-9_.-]{3,80}';
  if (typeof m.sessionId !== 'string' || !m.sessionId) return 'meta.sessionId required';
  if (!Number.isInteger(m.width) || !Number.isInteger(m.height) || m.width < 16 || m.height < 16 || m.width > 8192 || m.height > 8192) return 'meta.width/height must be integers 16..8192';
  if (m.preset !== undefined && !['corner', 'frontal', 'wide', 'booth'].includes(m.preset)) return 'meta.preset must be corner|frontal|wide|booth';
  if (m.boothId !== undefined && (typeof m.boothId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(m.boothId))) return 'meta.boothId must be a booth actor name';
  return null;
}

/**
 * Render pipeline (task 6): store the capture, build the product mask (mask>127 AND |depth−maskDepth|<3 cm), run a fast
 * preview and then the high-quality edit, and paste the ORIGINAL beauty pixels back into both. The fallback provider is
 * used when the primary fails. Files: data/renders/<renderId>/{beauty,depth,mask,maskDepth,preview,final}.png + meta.json.
 */
/** TC-AI-06.2: the whole pipeline (preview + final, incl. fallback) gives up after this long. */
export const RENDER_GIVEUP_MS = Number(process.env.AI_RENDER_GIVEUP_MS ?? 60_000);
export const RENDER_GIVEUP_RU = t('ru', 'render.giveUp');
/** The other visitor-facing failure line (v2.5: index.ts renders both in the session language). */
export const RENDER_FAILED_RU = t('ru', 'render.failed');

export class RenderService {
  giveUpMs = RENDER_GIVEUP_MS;
  constructor(
    private primary: RenderProvider,
    private fallback: RenderProvider | null,
    private emit: (sessionId: string, ev: RenderEvent) => void,
    public readonly dir = path.join(process.cwd(), 'data', 'renders'),
    private publicBaseUrl: () => string = () => '',
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fileUrl(renderId: string, name: string) {
    return `${this.publicBaseUrl()}/api/render/${renderId}/${name}.png`;
  }
  filePath(renderId: string, name: string): string | null {
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(renderId) || !/^(beauty|preview|final|mask|depth|productMask)$/.test(name)) return null;
    const f = path.join(this.dir, renderId, `${name}.png`);
    return fs.existsSync(f) ? f : null;
  }

  /** Accepts a capture; returns immediately (the pipeline continues in the background). */
  accept(meta: RenderMeta, parts: { beauty: Buffer; depth: Buffer; mask: Buffer; maskDepth?: Buffer }): Promise<void> {
    const d = path.join(this.dir, meta.renderId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'beauty.png'), parts.beauty);
    fs.writeFileSync(path.join(d, 'depth.png'), parts.depth);
    fs.writeFileSync(path.join(d, 'mask.png'), parts.mask);
    if (parts.maskDepth) fs.writeFileSync(path.join(d, 'maskDepth.png'), parts.maskDepth);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 1));
    if (meta.preset === 'booth') return this.boothCapture(meta, d);
    return this.run(meta, parts, d);
  }

  /**
   * v2.2 P3-02 (Artur 2026-10-02): a salon booth photo is the clean UE capture (dedicated booth camera, salon lighting).
   * No AI render and no provider call at all — also when paid providers are enabled: the beauty image is the final photo.
   */
  private async boothCapture(meta: RenderMeta, d: string) {
    const beautyUrl = this.fileUrl(meta.renderId, 'beauty');
    fs.writeFileSync(path.join(d, 'log.json'), JSON.stringify({ renderId: meta.renderId, t0: Date.now(), source: 'capture', boothId: meta.boothId ?? null, finalMs: 0, finalProvider: 'capture' }, null, 1));
    this.emit(meta.sessionId, { renderId: meta.renderId, stage: 'final', url: beautyUrl, beautyUrl, source: 'capture' });
  }

  private async withFallback(kind: 'preview' | 'final', input: Parameters<RenderProvider['preview']>[0]) {
    try {
      return { img: await this.primary[kind](input), provider: this.primary.name };
    } catch (e) {
      if (!this.fallback) throw e;
      return { img: await this.fallback[kind](input), provider: this.fallback.name, primaryError: (e as Error).message };
    }
  }

  private async run(meta: RenderMeta, parts: { beauty: Buffer; depth: Buffer; mask: Buffer; maskDepth?: Buffer }, d: string) {
    const log: any = { renderId: meta.renderId, t0: Date.now() };
    // TC-AI-06.2: a provider that never answers must not leave the visitor waiting: after giveUpMs the photo is
    // reported failed (Russian reason); anything the provider delivers later is ignored (preview / beauty stay).
    let gaveUp = false;
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        gaveUp = true;
        log.gaveUpMs = Date.now() - log.t0;
        this.emit(meta.sessionId, { renderId: meta.renderId, stage: 'failed', reason: RENDER_GIVEUP_RU });
        resolve();
      }, this.giveUpMs);
    });
    await Promise.race([this.work(meta, parts, d, log, () => gaveUp), giveUp]);
    clearTimeout(timer);
    if (gaveUp) fs.writeFileSync(path.join(d, 'log.json'), JSON.stringify(log, null, 1));
  }

  private async work(meta: RenderMeta, parts: { beauty: Buffer; depth: Buffer; mask: Buffer; maskDepth?: Buffer }, d: string, log: any, gaveUp: () => boolean) {
    try {
      const cap = await decodeCapture(parts);
      if (cap.width !== meta.width || cap.height !== meta.height) throw new Error(`image ${cap.width}x${cap.height} ≠ meta ${meta.width}x${meta.height}`);
      const pm = productMask(cap);
      const inputs = await modelInputs(cap, pm);
      fs.writeFileSync(path.join(d, 'productMask.png'), inputs.editMaskPng);
      const input = { ...inputs, prompt: renderPrompt(meta), width: cap.width, height: cap.height, sessionId: meta.sessionId };
      const pv = await this.withFallback('preview', input);
      if (gaveUp()) return;
      fs.writeFileSync(path.join(d, 'preview.png'), await compositeProduct(cap, pv.img, pm));
      log.previewMs = Date.now() - log.t0;
      log.previewProvider = pv.provider;
      this.emit(meta.sessionId, { renderId: meta.renderId, stage: 'preview', url: this.fileUrl(meta.renderId, 'preview'), beautyUrl: this.fileUrl(meta.renderId, 'beauty'), source: 'ai' });
      // Paid test 2026-10-01: the fal final model waited 41 s and > 140 s for a worker (inference 3.7 s). When the final
      // does not come, the preview the visitor already sees (same composite rule: original product pixels) becomes the photo.
      let fin: { img: Buffer; provider: string };
      try {
        fin = await this.withFallback('final', input);
      } catch (e: any) {
        if (gaveUp()) return;
        log.finalError = e.message;
        fin = { img: pv.img, provider: 'preview-as-final' };
      }
      if (gaveUp()) return;
      fs.writeFileSync(path.join(d, 'final.png'), await compositeProduct(cap, fin.img, pm));
      log.finalMs = Date.now() - log.t0;
      log.finalProvider = fin.provider;
      this.emit(meta.sessionId, { renderId: meta.renderId, stage: 'final', url: this.fileUrl(meta.renderId, 'final'), beautyUrl: this.fileUrl(meta.renderId, 'beauty'), source: 'ai' });
    } catch (e: any) {
      log.error = e.message;
      if (!gaveUp()) this.emit(meta.sessionId, { renderId: meta.renderId, stage: 'failed', reason: RENDER_FAILED_RU });
    } finally {
      if (!gaveUp()) fs.writeFileSync(path.join(d, 'log.json'), JSON.stringify(log, null, 1));
    }
  }
}
