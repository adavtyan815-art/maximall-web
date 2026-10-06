import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RenderService, RenderEvent, RENDER_GIVEUP_MS, RENDER_GIVEUP_RU } from '../src/ai/render/service';
import { HangingRender, MockRender, RenderProvider } from '../src/ai/render/providers';
import { createProviders } from '../src/ai/providers';
import { CostLedger } from '../src/ai/util/costLedger';
import { syntheticCapture, W, H } from './helpers/capture';

/** TC-AI-06.2: render give-up -> ai.render failed (Russian), late provider output ignored; LOCAL_MODE test hook. */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'giveup-'));

describe('render give-up (TC-AI-06.2)', () => {
  it('default is 60 s', () => {
    expect(RENDER_GIVEUP_MS).toBe(60_000);
  });

  it('a provider that never answers -> one failed event with the Russian reason after the give-up time', async () => {
    const ev: RenderEvent[] = [];
    const svc = new RenderService(new HangingRender(), null, (_s, e) => ev.push(e), tmp());
    svc.giveUpMs = 300;
    const t0 = Date.now();
    await svc.accept({ renderId: 'rn-hang-1', sessionId: 's', width: W, height: H }, await syntheticCapture());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(ev).toEqual([{ renderId: 'rn-hang-1', stage: 'failed', reason: RENDER_GIVEUP_RU }]);
    expect(RENDER_GIVEUP_RU).toMatch(/^Фото не успело подготовиться/);
  });

  it('a preview in time, a final too late: preview stays, failed once, the late final is ignored', async () => {
    const ev: RenderEvent[] = [];
    const slowFinal: RenderProvider = Object.assign(Object.create(new MockRender()), {
      name: 'slow',
      final: (i: any) => new Promise<Buffer>((r) => setTimeout(() => r(new MockRender().final(i)), 500)),
    });
    const dir = tmp();
    const svc = new RenderService(slowFinal, null, (_s, e) => ev.push(e), dir);
    svc.giveUpMs = 250;
    await svc.accept({ renderId: 'rn-slow-1', sessionId: 's', width: W, height: H }, await syntheticCapture());
    await new Promise((r) => setTimeout(r, 600)); // the late final arrives
    expect(ev.map((e) => e.stage)).toEqual(['preview', 'failed']);
    expect(fs.existsSync(path.join(dir, 'rn-slow-1', 'final.png'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'rn-slow-1', 'preview.png'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'rn-slow-1', 'log.json'), 'utf8')).gaveUpMs).toBeGreaterThanOrEqual(240);
  });

  it('the final fails before the give-up: the preview becomes the photo (stage final), no failed event', async () => {
    const ev: RenderEvent[] = [];
    const failingFinal: RenderProvider = Object.assign(Object.create(new MockRender()), {
      name: 'final-timeout',
      final: () => Promise.reject(new Error('fal final timeout (cancelled)')),
    });
    const dir = tmp();
    const svc = new RenderService(failingFinal, null, (_s, e) => ev.push(e), dir);
    await svc.accept({ renderId: 'rn-pvfinal-1', sessionId: 's', width: W, height: H }, await syntheticCapture());
    expect(ev.map((e) => e.stage)).toEqual(['preview', 'final']);
    const d = path.join(dir, 'rn-pvfinal-1');
    expect(fs.readFileSync(path.join(d, 'final.png')).equals(fs.readFileSync(path.join(d, 'preview.png')))).toBe(true);
    const log = JSON.parse(fs.readFileSync(path.join(d, 'log.json'), 'utf8'));
    expect(log.finalProvider).toBe('preview-as-final');
    expect(log.finalError).toMatch(/timeout/);
  });

  it('AI_RENDER_MOCK_HANG=1 selects the hanging provider only in LOCAL_MODE', () => {
    const saved = { ...process.env };
    try {
      const ledger = new CostLedger({ file: path.join(tmp(), 'spend.jsonl') });
      process.env.AI_RENDER_MOCK_HANG = '1';
      delete process.env.LOCAL_MODE;
      expect(createProviders({ ledger, skipWindowsEnv: true }).render!.name).not.toBe('mock-hang');
      process.env.LOCAL_MODE = '1';
      const p = createProviders({ ledger, skipWindowsEnv: true });
      expect(p.render!.name).toBe('mock-hang');
      expect(p.renderFallback).toBeNull();
      expect(p.mock.renderHang).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
