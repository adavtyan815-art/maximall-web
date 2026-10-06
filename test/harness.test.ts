import { describe, it, expect } from 'vitest';
import { fixtureIndex } from './helpers/catalog';
import { runHarness, estimateRunCost } from '../src/ai/harness/run';
import { PHRASES } from '../src/ai/harness/phrases';

describe('X4 Day-1 phrase harness (mock policy)', () => {
  it('has the 50 Day-1 phrases + at least 25 two-mode (v2.0) cases and the scripted policy passes them; the live-run cost estimate is computed', async () => {
    const v2 = PHRASES.filter((p) => p.mode !== undefined); // v2.0 cases (salon or explicit constructor mode)
    expect(PHRASES.length - v2.length).toBe(50);
    expect(v2.length).toBeGreaterThanOrEqual(25);
    expect(new Set(PHRASES.map((p) => p.id)).size).toBe(PHRASES.length);
    // all five collections in the booth dialogue, consent positive and negative, «верни как было»
    for (const c of ['Milu', 'Urban', 'Avenu', 'Terra', 'Tuma']) expect(v2.some((p) => p.group === 'booth' && p.focus === c)).toBe(true);
    expect(v2.filter((p) => p.expect.modeAfter === 'constructor').length).toBeGreaterThanOrEqual(4);
    expect(v2.filter((p) => p.expect.notCmds?.includes('enter_constructor')).length).toBeGreaterThanOrEqual(5);
    expect(v2.some((p) => /верни как было/i.test(p.text))).toBe(true);
    const f = fixtureIndex();
    const r = await runHarness(f.catalog);
    const failed = r.results.filter((x) => !x.pass).map((x) => `${x.id}: ${x.why.join('; ')}`);
    expect(failed).toEqual([]);
    const c = estimateRunCost(r.meter);
    expect(c['claude-sonnet-5-5'].usdCached).toBeGreaterThan(0);
    expect(c['claude-haiku-4-5'].usdCached).toBeLessThan(c['claude-sonnet-5-5'].usdCached);
  }, 120000);
});
