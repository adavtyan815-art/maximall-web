import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { decodeCapture, productMask, compositeProduct } from '../src/ai/render/composite';
import { RenderService, checkMeta, RenderEvent } from '../src/ai/render/service';
import { MockRender, findImageData, RenderProvider } from '../src/ai/render/providers';

import { syntheticCapture, W, H } from './helpers/capture';

async function rawRgb(png: Buffer) {
  return (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
}

describe('render compositing (task 6)', () => {
  it('decodes 16-bit depth in centimetres and builds mask>127 AND |depth−maskDepth|<3 cm', async () => {
    const c = await syntheticCapture();
    const cap = await decodeCapture(c);
    expect(cap.depth[10 * W + 30]).toBe(200);
    expect(cap.depth[0]).toBe(400);
    const pm = productMask(cap);
    expect(pm[20 * W + 30]).toBe(255); // product, visible
    expect(pm[20 * W + 22]).toBe(0); // product occluded by the towel (depth 150 vs 200)
    expect(pm[5 * W + 5]).toBe(0); // room
    const withoutMaskDepth = productMask(await decodeCapture({ ...c, maskDepth: undefined }));
    expect(withoutMaskDepth[20 * W + 22]).toBe(255);
  });

  it('pastes the original product pixels back byte-identically; the rest comes from the generated image', async () => {
    const c = await syntheticCapture();
    const cap = await decodeCapture(c);
    const pm = productMask(cap);
    // a generated image of a different size and colour, as an image API might return
    const gen = await sharp({ create: { width: 128, height: 96, channels: 3, background: { r: 10, g: 200, b: 30 } } }).png().toBuffer();
    const out = await rawRgb(await compositeProduct(cap, gen, pm));
    let kept = 0;
    let replaced = 0;
    for (let i = 0; i < W * H; i++) {
      const same = out[i * 3] === c.raw.beauty[i * 3] && out[i * 3 + 1] === c.raw.beauty[i * 3 + 1] && out[i * 3 + 2] === c.raw.beauty[i * 3 + 2];
      if (pm[i]) {
        expect(same, `pixel ${i}`).toBe(true);
        kept++;
      } else if (out[i * 3 + 1] === 200) replaced++;
    }
    expect(kept).toBe(18 * 28); // x 26..43 (18) × y 10..37 (28)
    expect(replaced).toBe(W * H - kept);
  });

  it('runs the pipeline with the mock provider: preview then final, both with byte-identical product pixels; files and events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const events: RenderEvent[] = [];
    const svc = new RenderService(new MockRender(), null, (_s, e) => events.push(e), dir, () => 'http://x');
    const c = await syntheticCapture();
    const meta = { renderId: 'rn-test-1', sessionId: 'i1:anna', width: W, height: H, preset: 'corner' as const };
    expect(checkMeta(meta)).toBeNull();
    await svc.accept(meta, c);
    expect(events.map((e) => e.stage)).toEqual(['preview', 'final']);
    expect(events[1].url).toBe('http://x/api/render/rn-test-1/final.png');
    const cap = await decodeCapture(c);
    const pm = productMask(cap);
    for (const name of ['preview', 'final']) {
      const out = await rawRgb(fs.readFileSync(svc.filePath('rn-test-1', name)!));
      let diffOutside = 0;
      for (let i = 0; i < W * H; i++) {
        if (pm[i]) expect(out.subarray(i * 3, i * 3 + 3).equals(c.raw.beauty.subarray(i * 3, i * 3 + 3)), `${name} ${i}`).toBe(true);
        else if (!out.subarray(i * 3, i * 3 + 3).equals(c.raw.beauty.subarray(i * 3, i * 3 + 3))) diffOutside++;
      }
      expect(diffOutside).toBeGreaterThan(W * H * 0.3); // the "photo" filter changed the room
    }
    expect(svc.filePath('rn-test-1', '../../etc')).toBeNull();
  });

  it('uses the fallback provider when the primary fails, and reports failed with a Russian reason when both fail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const broken: RenderProvider = { name: 'broken', mock: false, preview: async () => Promise.reject(new Error('down')), final: async () => Promise.reject(new Error('down')), estimateUsd: () => 0 };
    const ev1: RenderEvent[] = [];
    await new RenderService(broken, new MockRender(), (_s, e) => ev1.push(e), dir).accept({ renderId: 'rn-fb', sessionId: 's', width: W, height: H }, await syntheticCapture());
    expect(ev1.map((e) => e.stage)).toEqual(['preview', 'final']);
    const ev2: RenderEvent[] = [];
    await new RenderService(broken, null, (_s, e) => ev2.push(e), dir).accept({ renderId: 'rn-fail', sessionId: 's', width: W, height: H }, await syntheticCapture());
    expect(ev2).toEqual([{ renderId: 'rn-fail', stage: 'failed', reason: 'Фото не получилось, попробуйте ещё раз.' }]);
  });

  it('validates meta and finds Gemini image data in both documented response shapes', () => {
    expect(checkMeta({ renderId: '../x', sessionId: 's', width: 10, height: 10 })).toMatch(/renderId/);
    expect(checkMeta({ renderId: 'rn-1', sessionId: 's', width: 1920, height: 1080, preset: 'top' })).toMatch(/preset/);
    const b64 = 'A'.repeat(200);
    expect(findImageData({ steps: [{ content: [{ type: 'text', text: 'ok' }, { type: 'image', mime_type: 'image/png', data: b64 }] }] })).toBe(b64);
    expect(findImageData({ output_image: { data: b64 } })).toBe(b64);
  });
});

import { FalFluxRender } from '../src/ai/render/providers';
import { renderPrompt, styleFromPreference, PRESERVE, STYLES } from '../src/ai/render/prompts';
import { CostLedger } from '../src/ai/util/costLedger';

describe('fal request bodies (documented endpoints only) and the prompt style guide', () => {
  const input = { beautyPng: Buffer.from('b'), depthPng: Buffer.from('d'), editMaskPng: Buffer.from('m'), prompt: 'p', width: 1920, height: 1080 };
  const fal = new FalFluxRender(new CostLedger({ file: path.join(os.tmpdir(), 'x-spend.jsonl') }), 'no-key');
  it('preview = FLUX.2 klein 4B edit, 4 steps, ≤ 1 MP; final = Control LoRA Depth img2img with our depth map', () => {
    const p = fal.body('preview', input);
    expect(p.model).toBe('fal-ai/flux-2/klein/4b/edit');
    expect(p.body.num_inference_steps).toBe(4);
    expect(p.body.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(p.body.image_size.width * p.body.image_size.height).toBeLessThanOrEqual(1_100_000);
    const f = fal.body('final', input);
    expect(f.model).toBe('fal-ai/flux-control-lora-depth/image-to-image');
    expect(Object.keys(f.body).sort()).toEqual(['control_lora_image_url', 'control_lora_strength', 'guidance_scale', 'image_size', 'image_url', 'num_inference_steps', 'output_format', 'prompt', 'strength']);
    expect(fal.estimateUsd('final', input)).toBeCloseTo(0.04 * 3, 6); // 2.07 MP -> 3 MP
    expect(fal.estimateUsd('preview', input)).toBeCloseTo(0.01, 6);
  });
  it('inpainting mode refuses without a documented depth ControlNet path', () => {
    const save = process.env.FAL_FINAL_MODE;
    process.env.FAL_FINAL_MODE = 'inpainting';
    try {
      expect(() => fal.body('final', input)).toThrow(/FAL_DEPTH_CONTROLNET_PATH/);
    } finally {
      if (save === undefined) delete process.env.FAL_FINAL_MODE;
      else process.env.FAL_FINAL_MODE = save;
    }
  });
  it('every style prompt carries the geometry/colour preservation clause; preferences map to styles', () => {
    for (const s of Object.keys(STYLES)) {
      const p = renderPrompt({ style: s });
      expect(p).toContain(PRESERVE);
      expect(p).toContain(STYLES[s as keyof typeof STYLES].en);
    }
    expect(styleFromPreference('white')).toBe('scandi');
    expect(styleFromPreference('wood')).toBe('classic');
    expect(styleFromPreference('dark')).toBe('loft');
    expect(styleFromPreference(undefined, [{ type: 'tile', tileId: 'Tile_Grey60' }])).toBe('loft');
    expect(styleFromPreference()).toBe('modern');
  });
});

describe('TA look-dev review (prompts)', () => {
  it('no window wording unless the room has one; mirrors untouched; duplicate avoid-terms; low wide view', () => {
    const p = renderPrompt({ style: 'modern' });
    expect(p).not.toMatch(/from the window/);
    expect(p).toContain('bright ceiling');
    expect(renderPrompt({ style: 'modern', hasWindow: true })).toMatch(/daylight from the window/);
    expect(p).toContain('Leave the mirror and what it reflects unchanged');
    for (const t of ['extra mirrors', 'extra basins', 'objects on the countertop covering the basin', 'new windows']) expect(p).toContain(t);
    expect(renderPrompt({ style: 'scandi', preset: 'wide' })).toContain('low wide-angle view');
  });
});
