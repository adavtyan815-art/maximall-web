import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { decodeCapture, productMask } from '../src/ai/render/composite';
import { RenderService, RenderEvent } from '../src/ai/render/service';
import { MockRender } from '../src/ai/render/providers';

/**
 * TA bake-off set (11 GPU frames × beauty/depth16/mask/maskdepth16, 1280×720) through the mock render pipeline.
 * Outside the repo (14 MB): D:/AI_Consultant_Workspace/ta_renders/bakeoff_set (override with BAKEOFF_DIR); skipped if absent.
 */
const DIR = process.env.BAKEOFF_DIR ?? 'D:/AI_Consultant_Workspace/ta_renders/bakeoff_set';
const frames = fs.existsSync(DIR)
  ? fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('_beauty.png'))
      .map((f) => f.replace(/_beauty\.png$/, ''))
      .sort()
  : [];

describe.skipIf(frames.length === 0)('render composite invariants on the TA bake-off set (mock provider)', () => {
  it('has the 11 frames', () => {
    expect(frames).toHaveLength(11);
  });

  it.each(frames)('%s: product mask ⊆ mask>127 and depth-consistent; product (incl. mirror reflection) pixels byte-identical in preview and final', async (name) => {
    const read = (p: string) => fs.readFileSync(path.join(DIR, `${name}_${p}.png`));
    const parts = { beauty: read('beauty'), depth: read('depth16'), mask: read('mask'), maskDepth: read('maskdepth16') };
    const cap = await decodeCapture(parts);
    expect([cap.width, cap.height]).toEqual([1280, 720]);
    const pm = productMask(cap);
    const n = cap.width * cap.height;
    let inMask = 0;
    let masked = 0;
    let rejectedByDepth = 0;
    for (let i = 0; i < n; i++) {
      if (cap.mask[i] > 127) masked++;
      if (!pm[i]) {
        if (cap.mask[i] > 127) rejectedByDepth++;
        continue;
      }
      inMask++;
      expect(cap.mask[i]).toBeGreaterThan(127);
      expect(Math.abs(cap.depth[i] - cap.maskDepth![i])).toBeLessThan(3);
    }
    expect(inMask).toBeGreaterThan(n * 0.005); // the product is visible
    expect(inMask).toBeLessThan(n * 0.9); // and the room is not all product
    expect(inMask + rejectedByDepth).toBe(masked);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-'));
    const events: RenderEvent[] = [];
    const svc = new RenderService(new MockRender(), null, (_s, e) => events.push(e), dir);
    await svc.accept({ renderId: `bk-${name}`, sessionId: 'bakeoff', width: 1280, height: 720, preset: /wide/.test(name) ? 'wide' : /frontal/.test(name) ? 'frontal' : 'corner' }, parts);
    expect(events.map((e) => e.stage)).toEqual(['preview', 'final']);
    const beauty = (await sharp(parts.beauty).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
    for (const stage of ['preview', 'final']) {
      const { data: out, info } = await sharp(fs.readFileSync(svc.filePath(`bk-${name}`, stage)!)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([1280, 720]);
      let changedOutside = 0;
      for (let i = 0; i < n; i++) {
        const same = out[i * 3] === beauty[i * 3] && out[i * 3 + 1] === beauty[i * 3 + 1] && out[i * 3 + 2] === beauty[i * 3 + 2];
        if (pm[i]) {
          if (!same) throw new Error(`${name} ${stage}: product pixel ${i} changed`);
        } else if (!same) changedOutside++;
      }
      expect(changedOutside).toBeGreaterThan((n - inMask) * 0.5); // the mock "photo" filter changed the room
    }
  }, 60000);
});
