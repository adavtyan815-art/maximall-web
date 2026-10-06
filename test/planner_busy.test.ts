import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { expectValid, validator } from './helpers/contracts';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';

const f = fixtureIndex();
const PLANNER_CHANGING = ['build_room', 'add_opening', 'apply_config', 'configure_set', 'swap_set', 'remove_set', 'finish_surface', 'undo', 'reset'];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-'));
  const o = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
  // Visitor A built a 2 x 2.5 m room and owns the shared planner of this server; we are visitor B.
  const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
  ue.otherOwner = true;
  const said: string[] = [];
  const cards: any[][] = [];
  const s = new AiSession('i:visitorB', 'i', 'visitorB', new DirectChannel(ue), {
    emit: (e, p) => {
      if (e === 'ai.say') said.push(p.text);
      if (e === 'ai.cards') cards.push(p.cards);
    },
  }, 'constructor');
  const sent = (cmd: string) => ue.log.filter((l) => l.cmd === cmd).length;
  const changing = () => ue.log.filter((l) => PLANNER_CHANGING.includes(l.cmd)).length;
  return { o, ue, s, said, cards, sent, changing };
}

describe('CR-UE-02 / contracts v1.6: PLANNER_BUSY', () => {
  it('the v1.6 contract carries PLANNER_BUSY and get_state owner.isYou; the fake UE speaks it', () => {
    expectValid(validator('maximall/ai/commands.schema.json#/$defs/reasonCode'), 'PLANNER_BUSY');
    const ue = new FakeUe(f.catalog, { widthCm: 200, depthCm: 250 });
    ue.otherOwner = true;
    const st = ue.execute({ id: 'r1', cmd: 'get_state', args: {} });
    expectValid(validator('maximall/ai/commands.schema.json#/$defs/state'), st.result);
    expect(st.result.owner.isYou).toBe(false);
    const r = ue.execute({ id: 'r2', cmd: 'build_room', args: { widthCm: 300, depthCm: 300 } });
    expect(r).toMatchObject({ ok: false, reasonCode: 'PLANNER_BUSY' });
    expect(ue.execute({ id: 'r3', cmd: 'check_fit', args: { candidates: [] } }).ok).toBe(true);
  });

  it('explains it honestly in Russian, never retries, never overwrites, and still shows cards (check_fit is read-only)', async () => {
    const { o, ue, s, said, cards, sent, changing } = setup();
    const roomBefore = JSON.stringify(ue.walls);

    await o.handleTurn(s, 'Ванная 3 на 3 метра, бюджет 3000 BYN');
    expect(sent('build_room')).toBe(1); // tried once, refused, not repeated
    expect(sent('check_fit')).toBe(1); // proposing still works
    expect(cards.at(-1)!.length).toBeGreaterThan(0);
    const reply = said.at(-1)!;
    expect(reply).toMatch(/Конструктор сейчас занят другим посетителем на этом сервере/);
    expect(reply).toMatch(/подождать/);
    expect(reply).toMatch(/без установки в комнату/);
    expect(reply).not.toMatch(/Нажмите на карточку, и я поставлю/);
    expect(reply.match(/занят другим посетителем/g)!.length).toBe(1); // one explanation per turn
    expect(s.plannerBusy).toBe(true);

    // The visitor tries to place a card: one read-only owner look, the apply is held back (never sent).
    await o.handleTurn(s, 'Поставь первый вариант');
    expect(sent('apply_config')).toBe(0);
    expect(said.at(-1)).toMatch(/занят другим посетителем/);

    // "Start over" / "undo" / wall paint must not touch the other visitor's room.
    await o.handleTurn(s, 'Начнём сначала');
    await o.handleTurn(s, 'Отмени');
    await o.handleTurn(s, 'Подбери отделку стен и пол');
    expect(changing()).toBe(1); // still only the very first build_room ever reached UE
    expect(JSON.stringify(ue.walls)).toBe(roomBefore);
    expect(ue.finishes).toEqual({});
    for (const t of said.slice(-3)) expect(t).toMatch(/занят другим посетителем/);

    // Photo and dossier would show / save the other visitor's project -> not sent either.
    await o.handleTurn(s, 'Сделай фото');
    expect(sent('capture')).toBe(0);
    expect(said.at(-1)).toMatch(/проект другого посетителя/);

    // Each later turn costs at most one get_state; there is no loop.
    const gs = sent('get_state');
    expect(gs).toBeLessThanOrEqual(6);

    // A leaves the planner -> the next request goes through once and the busy state clears.
    ue.otherOwner = false;
    await o.handleTurn(s, 'Поставь первый вариант');
    expect(sent('apply_config')).toBe(1);
    expect(s.plannerBusy).toBe(false);
    expect(ue.sets.length).toBe(1);
    expect(said.at(-1)).toMatch(/Поставила/);
  });

  it('a card tap that UE refused with PLANNER_BUSY gets the honest answer, not a retry', async () => {
    const { o, ue, s, said, cards, sent } = setup();
    await o.handleTurn(s, 'Покажи варианты');
    const card = cards.at(-1)![0];
    const r = ue.execute({ id: 'tap1', cmd: 'apply_config', args: { config: card.config, placement: card.placement, cardId: card.cardId } });
    const before = ue.log.filter((l) => l.cmd !== 'consultant_say').length;
    await o.handleCardTap(s, { cardId: card.cardId, requestId: 'tap1', result: r });
    expect(ue.log.filter((l) => l.cmd !== 'consultant_say').length - before).toBe(0); // nothing re-sent, no get_state lookup
    expect(said.at(-1)).toMatch(new RegExp(`Поставить «${card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}» сейчас не получится: конструктор занят другим посетителем`));
    expect(s.sets.size).toBe(0);
    expect(sent('apply_config')).toBe(1); // only the page's own tap
  });

  it('get_state owner.isYou=false marks the planner busy before any change is attempted', async () => {
    const { o, s, sent } = setup();
    const out = await o.runTool(s, 'get_state', {}, 'model', 't-9');
    expect(out.state.owner).toEqual({ isYou: false, active: true });
    expect(s.plannerBusy).toBe(true);
    const b = await o.runTool(s, 'build_room', { widthCm: 300, depthCm: 300 }, 'model', 't-9');
    expect(b).toMatchObject({ ok: false, reasonCode: 'PLANNER_BUSY', retry: false });
    expect(b.say).toMatch(/занят другим посетителем/);
    expect(sent('build_room')).toBe(0);
  });

  it('QA-050: a held dossier / photo sends no ai.dossier or ai.render stage at all, only the consultant promise', async () => {
    const { o, s, said, sent } = setup();
    const ev: [string, any][] = [];
    const emit0 = s.io.emit;
    s.io = { emit: (e: string, p: any) => { ev.push([e, p]); emit0(e, p); } };
    await o.handleTurn(s, 'Ванная 3 на 3 метра'); // PLANNER_BUSY found
    await o.handleTurn(s, 'Пришли мне всё');
    await o.handleTurn(s, 'Сделай фото');
    expect(sent('save_project')).toBe(0);
    expect(sent('capture')).toBe(0);
    expect(ev.filter(([e]) => e === 'ai.dossier' || e === 'ai.render')).toEqual([]);
    expect(said.at(-2)).toMatch(/фото и досье сделаю, когда он освободится/);
    expect(said.at(-1)).toMatch(/фото и досье сделаю, когда он освободится/);
    // same within one turn (held without a get_state look)
    const out = await o.runTool(s, 'save_project', {}, 'model', `t-${s.turnSeq}`);
    expect(out).toMatchObject({ ok: false, reasonCode: 'PLANNER_BUSY', retry: false });
    expect(ev.filter(([e]) => e === 'ai.dossier')).toEqual([]);
  });
});
