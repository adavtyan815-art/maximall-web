import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { parseTurn } from '../src/ai/orchestrator/intents';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel, EnvelopeRequest } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { fullConfig } from '../src/ai/catalog/index';

/** QA-056: never claim a change that did not happen (closet already there / not there / UE no-op). */
const f = fixtureIndex();

function setup(channelFor?: (ue: FakeUe) => DirectChannel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q56-'));
  const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
  const ue = new FakeUe(f.catalog, { widthCm: 300, depthCm: 250 });
  const said: string[] = [];
  const s = new AiSession('i:q56', 'i', 'q56', channelFor ? channelFor(ue) : new DirectChannel(ue), { emit: (e, p) => e === 'ai.say' && said.push(p.text) }, 'constructor');
  // a set whose collection has a wall cabinet, placed without one
  const p = f.catalog.listProducts().find((x) => x.closetModels.length > 0 && f.catalog.isCollectionEnabled(x.collection ?? ''))!;
  const sz = p.cabinet.sizes[0].index;
  const cfg = fullConfig({ productId: p.productId, sizeIndex: sz, colourIndex: f.catalog.colourIndicesForSize(p, sz)[0] });
  expect(f.catalog.validate(cfg)).toBeNull();
  const r = ue.execute({ id: 'r0', cmd: 'apply_config', args: { config: cfg, placement: { segmentId: 0 } } });
  expect(r.ok).toBe(true);
  const setId = r.result.setId;
  s.sets.set(setId, { setId, config: cfg, title: p.collection ?? p.productId });
  s.lastSetId = setId;
  const cfgCmds = () => ue.log.filter((l) => l.cmd === 'configure_set').length;
  return { o, ue, s, said, setId, cfgCmds };
}

describe('QA-056: truthful closet answers', () => {
  it('parses «Добавь пенал» as an add request', () => {
    expect(parseTurn('Добавь пенал').calls).toEqual([{ name: 'configure_set', input: { config: { closetSizeIndex: 0 }, addCloset: true } }]);
    expect(parseTurn('Убери пенал').calls[0].input.config.closetSizeIndex).toBe(-1);
  });

  it('add when present / remove when absent: the truth and no command; real changes still happen', async () => {
    const { o, ue, s, said, cfgCmds } = setup();
    await o.handleTurn(s, 'Добавь пенал');
    expect(cfgCmds()).toBe(1);
    expect(said.at(-1)).toMatch(/^Добавила навесной шкаф/);
    expect(ue.sets[0].config.closetSizeIndex).toBeGreaterThanOrEqual(0);

    await o.handleTurn(s, 'Добавь пенал');
    expect(cfgCmds()).toBe(1); // nothing sent
    expect(said.at(-1)).toBe('Навесной шкаф уже в комплекте — можно поменять его цвет или размер.');

    await o.handleTurn(s, 'Убери пенал');
    expect(cfgCmds()).toBe(2);
    expect(said.at(-1)).toMatch(/^Убрала навесной шкаф/);

    await o.handleTurn(s, 'Убери пенал');
    expect(cfgCmds()).toBe(2);
    expect(said.at(-1)).toBe('Навесного шкафа в комплекте нет — убирать нечего.');
  });

  it('uses the room as it is now: a closet added in UE meanwhile is seen (get_state), no command, no false claim', async () => {
    const { o, ue, s, said, cfgCmds, setId } = setup();
    ue.sets[0].config = fullConfig({ ...ue.sets[0].config, closetSizeIndex: 0, closetColourIndex: 0 }); // e.g. a manual edit / card tap
    expect(s.sets.get(setId)!.config.closetSizeIndex).toBe(-1); // the session still thinks there is none
    await o.handleTurn(s, 'Добавь пенал');
    expect(cfgCmds()).toBe(0);
    expect(said.at(-1)).toMatch(/уже в комплекте/);
    expect(s.sets.get(setId)!.config.closetSizeIndex).toBe(0);
  });

  it('a UE result that shows no change is never announced as a change', async () => {
    class NoOpUe extends DirectChannel {
      async send(req: EnvelopeRequest) {
        if (req.cmd !== 'configure_set') return super.send(req);
        const cur = this.ue.sets.find((x) => x.setId === req.args.setId)!;
        return { type: 'result', id: req.id, cmd: req.cmd, ok: true, result: { setId: cur.setId, config: cur.config }, state_rev: this.ue.rev } as any;
      }
    }
    const { o, s, said, cfgCmds } = setup((ue) => new NoOpUe(ue));
    await o.handleTurn(s, 'Добавь пенал');
    expect(cfgCmds()).toBe(0); // NoOpUe answers without executing
    expect(said.at(-1)).toBe('Изменение не применилось — комплект остался прежним.');
    expect([...s.sets.values()][0].config.closetSizeIndex).toBe(-1);
  });
});
