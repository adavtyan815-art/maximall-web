import sharp from 'sharp';
import { CostLedger } from '../util/costLedger';

export interface RenderInput {
  beautyPng: Buffer; // original frame
  depthPng: Buffer; // 8-bit normalised depth (near = white) for a depth ControlNet
  editMaskPng: Buffer; // white = may change, black = product (kept)
  prompt: string;
  width: number;
  height: number;
  sessionId?: string;
}
export interface RenderProvider {
  readonly name: string;
  readonly mock: boolean;
  /** Fast preview (target 3–5 s). Returns an image (any size; the compositor resizes it). */
  preview(i: RenderInput): Promise<Buffer>;
  /** High-quality depth-conditioned masked edit. */
  final(i: RenderInput): Promise<Buffer>;
  estimateUsd(kind: 'preview' | 'final', i: RenderInput): number;
}

/** Mock: deterministic "photo" filters of the beauty frame, so the pipeline (and the product composite) is testable. */
/**
 * TC-AI-06.2 test hook: a provider that never answers (QA verifies the give-up -> ai.render failed path).
 * Used only when LOCAL_MODE=1 and AI_RENDER_MOCK_HANG=1 (createProviders).
 */
export class HangingRender implements RenderProvider {
  readonly name = 'mock-hang';
  readonly mock = true;
  preview(): Promise<Buffer> {
    return new Promise<Buffer>(() => undefined);
  }
  final(): Promise<Buffer> {
    return new Promise<Buffer>(() => undefined);
  }
  estimateUsd() {
    return 0;
  }
}

export class MockRender implements RenderProvider {
  readonly name = 'mock';
  readonly mock = true;
  async preview(i: RenderInput) {
    return sharp(i.beautyPng).modulate({ brightness: 1.03, saturation: 1.06 }).png().toBuffer();
  }
  async final(i: RenderInput) {
    // QA-026: a light, warm photo grade (no gamma crush) so the no-key photo never looks broken.
    return sharp(i.beautyPng).modulate({ brightness: 1.05, saturation: 1.1 }).linear(1.02, 2).sharpen({ sigma: 0.6 }).png().toBuffer();
  }
  estimateUsd() {
    return 0;
  }
}

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const mp = (i: RenderInput, scale = 1) => Math.ceil(((i.width * scale) * (i.height * scale)) / 1e6);

/**
 * fal.ai render provider — only documented endpoints/fields (checked 2026-09-30):
 *
 * PREVIEW (target 3–5 s): FLUX.2 [klein] 4B edit — https://fal.ai/models/fal-ai/flux-2/klein/4b/edit/api
 *   POST https://fal.run/fal-ai/flux-2/klein/4b/edit
 *   { prompt, image_urls: [<beauty>], image_size: {width,height}, num_inference_steps: 4, output_format: 'png' }
 *   "Fast 4-step editing"; $0.01 per megapixel. No depth input: geometry is held by the prompt + our product composite.
 *
 * FINAL (15–40 s budget): FLUX.1 [dev] Control LoRA Depth, image-to-image —
 *   https://fal.ai/models/fal-ai/flux-control-lora-depth/image-to-image/api
 *   POST https://fal.run/fal-ai/flux-control-lora-depth/image-to-image
 *   { prompt, image_url: <beauty>, control_lora_image_url: <our 16→8-bit depth map>, control_lora_strength, strength,
 *     num_inference_steps: 28, image_size, output_format: 'png' } — $0.04 per megapixel (rounded up).
 *   The depth conditioning is built into this endpoint, so no ControlNet weights path is needed. The endpoint has no
 *   mask input; the product is protected by our composite (mask ∩ depth), which pastes the original pixels back.
 *
 * Alternative (FAL_FINAL_MODE=inpainting): fal-ai/flux-general/inpainting (mask_url + controlnets[{path,
 *   control_image_url}]) — https://fal.ai/models/fal-ai/flux-general/inpainting/api. fal does not document a depth
 *   ControlNet weights `path`, so this mode needs FAL_DEPTH_CONTROLNET_PATH and is off by default.
 *
 * Auth: `Authorization: Key $FAL_KEY` (https://fal.ai/docs/model-apis/model-endpoints/queue). File inputs accept base64
 * data URIs (flux-general API page: "You can pass a Base64 data URI as a file input").
 */
export class FalFluxRender implements RenderProvider {
  readonly name = 'fal-flux';
  readonly mock = false;
  static readonly PREVIEW_MODEL = 'fal-ai/flux-2/klein/4b/edit';
  static readonly FINAL_MODEL = 'fal-ai/flux-control-lora-depth/image-to-image';
  static readonly INPAINT_MODEL = 'fal-ai/flux-general/inpainting';
  constructor(private ledger: CostLedger, private key = process.env.FAL_KEY ?? '') {}

  estimateUsd(kind: 'preview' | 'final', i: RenderInput) {
    if (kind === 'preview') return Number(process.env.FAL_PREVIEW_USD_PER_MP ?? 0.01) * mp(i, previewScale(i));
    const inpaint = process.env.FAL_FINAL_MODE === 'inpainting';
    return Number(process.env.FAL_FINAL_USD_PER_MP ?? (inpaint ? 0.075 : 0.04)) * mp(i);
  }

  /** Request body for a stage (exported for tests; no network). */
  body(kind: 'preview' | 'final', i: RenderInput): { model: string; body: Record<string, any> } {
    if (kind === 'preview') {
      const s = previewScale(i);
      return {
        model: FalFluxRender.PREVIEW_MODEL,
        body: { prompt: i.prompt, image_urls: [dataUri(i.beautyPng)], image_size: { width: round16(i.width * s), height: round16(i.height * s) }, num_inference_steps: 4, output_format: 'png' },
      };
    }
    if (process.env.FAL_FINAL_MODE === 'inpainting') {
      const path = process.env.FAL_DEPTH_CONTROLNET_PATH;
      if (!path) throw new Error('FAL_FINAL_MODE=inpainting needs FAL_DEPTH_CONTROLNET_PATH (depth ControlNet weights; not documented by fal)');
      return {
        model: FalFluxRender.INPAINT_MODEL,
        body: {
          prompt: i.prompt,
          image_url: dataUri(i.beautyPng),
          mask_url: dataUri(i.editMaskPng),
          strength: 0.75,
          num_inference_steps: 28,
          guidance_scale: 3.5,
          image_size: { width: round16(i.width), height: round16(i.height) },
          output_format: 'png',
          controlnets: [{ path, control_image_url: dataUri(i.depthPng), conditioning_scale: 0.8 }],
        },
      };
    }
    return {
      model: FalFluxRender.FINAL_MODEL,
      body: {
        prompt: i.prompt,
        image_url: dataUri(i.beautyPng),
        control_lora_image_url: dataUri(i.depthPng),
        control_lora_strength: 1,
        strength: 0.6,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        image_size: { width: round16(i.width), height: round16(i.height) },
        output_format: 'png',
      },
    };
  }

  private async run(kind: 'preview' | 'final', i: RenderInput): Promise<Buffer> {
    const { model, body } = this.body(kind, i);
    const est = this.estimateUsd(kind, i);
    const r = this.ledger.reserve('fal', `${model} ${kind}`, est, i.sessionId);
    try {
      const j: any = kind === 'preview' ? await this.runSync(model, body) : await this.runQueued(model, body);
      const url = j?.images?.[0]?.url;
      if (!url) throw new Error('fal: no image in response');
      const img = url.startsWith('data:') ? null : await fetch(url);
      const buf = img ? Buffer.from(await img.arrayBuffer()) : Buffer.from(url.split(',')[1], 'base64');
      r.settle(est, true);
      return buf;
    } catch (e) {
      r.settle(est, false);
      throw e;
    }
  }

  private async runSync(model: string, body: Record<string, any>) {
    const res = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Key ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`fal HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Final stage through the fal queue (paid test 2026-10-01: inference 3.7 s, but 41 s waiting IN_QUEUE for a worker of this
   * model; the sync call hit its 90 s abort in 3/3 live runs and an aborted sync job may still run and bill). Polls the status
   * until AI_FAL_FINAL_TIMEOUT_MS (default 140 s), then cancels: a request cancelled while IN_QUEUE is not run.
   */
  private async runQueued(model: string, body: Record<string, any>) {
    const H = { Authorization: `Key ${this.key}`, 'Content-Type': 'application/json' };
    const deadline = Date.now() + Number(process.env.AI_FAL_FINAL_TIMEOUT_MS ?? 140_000);
    const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!sub.ok) throw new Error(`fal queue HTTP ${sub.status}`);
    const q: any = await sub.json();
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1500));
      const st = await fetch(q.status_url, { headers: H, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!st?.ok) continue;
      const s: any = await st.json();
      if (s.status === 'COMPLETED') {
        const out = await fetch(q.response_url, { headers: H, signal: AbortSignal.timeout(20000) });
        if (!out.ok) throw new Error(`fal result HTTP ${out.status}`);
        return out.json();
      }
    }
    await fetch(q.cancel_url, { method: 'PUT', headers: H, signal: AbortSignal.timeout(10000) }).catch(() => undefined);
    throw new Error('fal final timeout (cancelled)');
  }

  preview(i: RenderInput) {
    return this.run('preview', i);
  }
  final(i: RenderInput) {
    return this.run('final', i);
  }
}

const round16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
/** Preview at ~1 MP max (speed + $0.01). */
const previewScale = (i: RenderInput) => Math.min(1, Math.sqrt(1_000_000 / (i.width * i.height)));

/**
 * Gemini image editing fallback. Shape from ai.google.dev (2026-09-30): POST
 * https://generativelanguage.googleapis.com/v1beta/interactions, header `x-goog-api-key`, body
 * { model, input:[{type:'text',text},{type:'image',mime_type,data}], response_format:{type:'image',mime_type,image_size} };
 * the image comes back base64 in steps[].content[] (type 'image'). Price: gemini-3.1-flash-image $0.067 per 1K image.
 * No mask input: the product is protected by the composite afterwards.
 */
export class GeminiImageRender implements RenderProvider {
  readonly name = 'gemini-image';
  readonly mock = false;
  constructor(private ledger: CostLedger, private key = process.env.GEMINI_API_KEY ?? '', private model = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3.1-flash-image') {}
  estimateUsd() {
    return Number(process.env.GEMINI_USD_PER_IMAGE ?? 0.067) + 0.001; // + input image/text tokens
  }
  private async run(kind: 'preview' | 'final', i: RenderInput): Promise<Buffer> {
    const est = this.estimateUsd();
    const r = this.ledger.reserve('gemini', `${this.model} ${kind}`, est, i.sessionId);
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'x-goog-api-key': this.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: [
            { type: 'text', text: `${i.prompt} Keep the furniture, its shape, position and colour exactly as in the image; change only lighting, materials of walls and floor, and photographic quality.` },
            { type: 'image', mime_type: 'image/png', data: i.beautyPng.toString('base64') },
          ],
          response_format: { type: 'image', mime_type: 'image/png', image_size: '1K' },
        }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const b64 = findImageData(await res.json());
      if (!b64) throw new Error('Gemini: no image in response');
      r.settle(est, true);
      return Buffer.from(b64, 'base64');
    } catch (e) {
      r.settle(est, false);
      throw e;
    }
  }
  preview(i: RenderInput) {
    return this.run('preview', i);
  }
  final(i: RenderInput) {
    return this.run('final', i);
  }
}

/** Finds the first {type:'image', data:<base64>} object (steps[].content[] or output_image) in a Gemini response. */
export function findImageData(j: any): string | undefined {
  if (!j || typeof j !== 'object') return undefined;
  if (j.output_image?.data) return j.output_image.data;
  if ((j.type === 'image' || j.mime_type?.startsWith?.('image/')) && typeof j.data === 'string' && j.data.length > 100) return j.data;
  for (const v of Object.values(j)) {
    const r = Array.isArray(v) ? v.map(findImageData).find(Boolean) : findImageData(v);
    if (r) return r;
  }
  return undefined;
}

export { renderPrompt } from './prompts';
