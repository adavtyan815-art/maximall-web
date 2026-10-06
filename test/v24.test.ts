import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fixtureIndex } from './helpers/catalog';
import { validator } from './helpers/contracts';
import { fullConfig } from '../src/ai/catalog/index';
import { listParts, resolvePartChoice } from '../src/ai/orchestrator/parts';
import { planBoothChange } from '../src/ai/orchestrator/booth';
import { Orchestrator, AiSession } from '../src/ai/orchestrator/orchestrator';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { ClipStore, MockStt, MockTts } from '../src/ai/providers/voice';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { TOOLS } from '../src/ai/orchestrator/tools';
import { CONSTRUCTOR_TOOLS, SHOWROOM_TOOLS } from '../src/ai/orchestrator/modes';

/**
 * Contracts v2.4 (Phase 4, 2026-10-02): the manual functionality for the AI — parts by DataTable id, doors, paint removal,
 * move_set, door/window edits, baseboard / trim / clear finishes. $0: catalogue fixture + FakeUe, no provider calls.
 */
const f = fixtureIndex();
const c = f.catalog;

function milu(extra: Record<string, number> = {}) {
  const p = c.getProduct('Milu')!;
  return fullConfig({ productId: 'Milu', sizeIndex: 0, colourIndex: c.colourIndicesForSize(p, 0)[0] ?? 0, ...(c.defaultsFor('Milu', 0) ?? {}), ...extra });
}

function world(inPlanner: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v24-'));
  const o = new Orchestrator({ catalog: c, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'c')), logDir: dir });
  const ue = new FakeUe(c, { inPlanner });
  const s = new AiSession('i:v24', 'i', 'v24', new DirectChannel(ue), { emit: () => undefined });
  if (inPlanner) (s as any).mode = 'constructor';
  return { o, ue, s };
}

async function roomWithSet(widthCm = 300, depthCm = 250) {
  const w = world(true);
  expect((await w.o.runTool(w.s, 'build_room', { widthCm, depthCm }, 'model', 't-1')).ok).toBe(true);
  const cfg = milu();
  const r = await w.o.command(w.s, 'apply_config', { config: cfg, placement: { segmentId: 0 } }, 'model');
  expect(r.ok).toBe(true);
  const setId = r.result.setId as string;
  w.s.sets.set(setId, { setId, config: cfg, title: 'Milu 80' });
  w.s.lastSetId = setId;
  return { ...w, setId };
}

describe('v2.4 parts by DataTable id (catalogue rules)', () => {
  it('lists every allowed model of a part with its DataTable row id, Russian label and colours', () => {
    const cfg = milu();
    const all = listParts(c, cfg);
    expect(all.map((l) => l.part)).toEqual(expect.arrayContaining(['cabinet', 'closet', 'countertop', 'faucet', 'mirror']));
    const sp = c.space('Milu', 0)!;
    const mirrors = all.find((l) => l.part === 'mirror')!;
    expect(mirrors.options.map((o) => o.id)).toEqual(sp.mirror.map((m) => m.rowId));
    expect(mirrors.options.every((o) => /Зеркало/.test(o.label))).toBe(true);
    const cabinet = all.find((l) => l.part === 'cabinet')!;
    expect(cabinet.options.map((o) => o.id)).toEqual(c.getProduct('Milu')!.cabinet.sizes.map((s) => s.name));
    expect(cabinet.options.filter((o) => o.current)).toHaveLength(1);
  });

  it('live finding: every option label is unique within a part (same-named sinks / faucets get the article or a number)', () => {
    for (const p of c.listProducts()) {
      const cfg = fullConfig({ productId: p.productId, sizeIndex: p.cabinet.sizes[0].index, colourIndex: c.colourIndicesForSize(p, p.cabinet.sizes[0].index)[0] ?? 0, ...(c.defaultsFor(p.productId, p.cabinet.sizes[0].index) ?? {}) });
      for (const l of listParts(c, cfg)) {
        const labels = l.options.map((o) => o.label);
        expect(new Set(labels).size, `${p.productId} ${l.part}: ${labels.join(' | ')}`).toBe(labels.length);
        if (l.part === 'faucet') expect(labels.some((x) => /\d+ см$/.test(x))).toBe(false);
      }
    }
  });

  it('a sink is chosen only with a surface-mounted countertop (the booth hides it on a built-in one)', () => {
    const sp = c.space('Milu', 0)!;
    const surface = sp.countertop.find((m) => m.kind !== 'BuiltIn')!;
    const builtIn = sp.countertop.find((m) => m.kind === 'BuiltIn');
    const onSurface = milu({ countertopSizeIndex: surface.index });
    const sink = sp.sink[sp.sink.length - 1];
    const ok = resolvePartChoice(c, onSurface, { part: 'sink', option: sink.rowId });
    expect(ok).toMatchObject({ change: { sinkSizeIndex: sink.index } });
    expect(c.validate(fullConfig({ ...onSurface, ...(ok as any).change }))).toBeNull();
    if (builtIn) {
      const onBuiltIn = milu({ countertopSizeIndex: builtIn.index });
      expect(listParts(c, onBuiltIn, 'sink')[0].options).toEqual([]);
      expect(resolvePartChoice(c, onBuiltIn, { part: 'sink', option: sink.rowId })).toMatchObject({ error: expect.stringMatching(/встроена/) });
    }
  });

  it('switching the countertop type resets the faucet into the new type list (as the configurator), colour by SKU', () => {
    const sp = c.space('Milu', 0)!;
    const builtIn = sp.countertop.find((m) => m.kind === 'BuiltIn');
    if (!builtIn) return;
    const res = resolvePartChoice(c, milu(), { part: 'countertop', option: builtIn.rowId });
    expect('change' in res).toBe(true);
    const next = fullConfig({ ...milu(), ...(res as any).change });
    expect(c.topKind(next)).toBe('BuiltIn');
    expect(next.faucetSizeIndex).toBe(sp.faucet.BuiltIn[0].index);
    expect(c.validate(next)).toBeNull();
    // a surface-mounted countertop colour by its SKU
    const surface = sp.countertop.find((m) => m.kind !== 'BuiltIn')!;
    const col = surface.colours[surface.colours.length - 1];
    const bySku = resolvePartChoice(c, milu(), { part: 'countertop', option: surface.rowId, colour: col.sku });
    expect(bySku).toMatchObject({ change: { countertopSizeIndex: surface.index, countertopColourIndex: col.index } });
  });

  it('a model the catalogue does not allow is refused with the real list; nothing to change = empty change', () => {
    expect(resolvePartChoice(c, milu(), { part: 'mirror', option: 'NoSuchRow' })).toMatchObject({ error: expect.stringMatching(/Такого варианта.*Есть:/) });
    const cur = milu();
    const curMirror = c.space('Milu', 0)!.mirror.find((m) => m.index === cur.mirrorSizeIndex)!;
    expect(resolvePartChoice(c, cur, { part: 'mirror', option: curMirror.rowId })).toEqual({ change: {}, what: '' });
    // a collection without a wall cabinet
    const terra = c.getProduct('Terra');
    if (terra && !terra.closetModels.length) {
      const t = fullConfig({ productId: 'Terra', sizeIndex: terra.cabinet.sizes[0].index, colourIndex: c.colourIndicesForSize(terra, terra.cabinet.sizes[0].index)[0] ?? 0, ...(c.defaultsFor('Terra', terra.cabinet.sizes[0].index) ?? {}) });
      expect(resolvePartChoice(c, t, { part: 'closet', present: true })).toMatchObject({ error: expect.stringMatching(/навесного шкафа нет/i) });
    }
  });

  it('booth planner: doors and paint removal are planned only when they change something', () => {
    const st = { boothId: 'B', productId: 'Milu', config: milu(), customColours: [] as any[], doors: { cabinet: 'closed', closet: 'none' } };
    expect(planBoothChange(c, st, { doors: 'open' })).toMatchObject({ kind: 'configure', args: { doors: { cabinet: 'open' } } });
    expect(planBoothChange(c, { ...st, doors: { cabinet: 'open', closet: 'none' } }, { doors: 'open' })).toMatchObject({ kind: 'say', noChange: true });
    expect(planBoothChange(c, st, { part: 'closet', doors: 'open' })).toMatchObject({ kind: 'say', ok: false });
    expect(planBoothChange(c, st, { clearPaint: true })).toMatchObject({ kind: 'say', noChange: true });
    expect(planBoothChange(c, { ...st, customColours: [{ component: 'cabinet', code: 'RAL 3020' }] }, { clearPaint: true })).toMatchObject({ kind: 'configure', args: { clearCustomColour: 'cabinet' } });
  });
});

describe('v2.4 tools on the FakeUe (salon booth)', () => {
  it('list_options + booth_configure a mirror by its row id; doors; paint removal', async () => {
    const { o, ue, s } = world(false);
    const b = ue.booths.find((x) => x.productId === 'Milu')!;
    const list = await o.runTool(s, 'list_options', { boothId: b.boothId, part: 'mirror' }, 'model', 't-1');
    expect(list.ok).toBe(true);
    const target = list.parts[0].options.find((x: any) => !x.current);
    const r = await o.runTool(s, 'booth_configure', { boothId: b.boothId, part: 'mirror', option: target.id }, 'model', 't-1');
    expect(r).toMatchObject({ ok: true });
    expect(b.config.mirrorSizeIndex).toBe(c.space('Milu', b.config.sizeIndex)!.mirror.find((m) => m.rowId === target.id)!.index);
    expect(await o.runTool(s, 'booth_configure', { boothId: b.boothId, part: 'mirror', option: 'Nope' }, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/Есть:/) });
    expect(await o.runTool(s, 'booth_configure', { boothId: b.boothId, doors: 'open' }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/Открыла дверцы/) });
    expect(b.doors?.cabinet).toBe('open');
    expect(await o.runTool(s, 'booth_configure', { boothId: b.boothId, paintCode: '3020' }, 'model', 't-1')).toMatchObject({ ok: true });
    expect(b.customColours.length).toBe(1);
    expect(await o.runTool(s, 'booth_configure', { boothId: b.boothId, clearPaint: true }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/цвет из каталога/) });
    expect(b.customColours).toEqual([]);
    // the salon never gets room tools
    expect(await o.runTool(s, 'move_set', { direction: 'left', distanceCm: 10 }, 'model', 't-1')).toMatchObject({ ok: false, reasonCode: 'NOT_IN_PLANNER' });
    expect(ue.log.some((x) => x.cmd === 'move_set')).toBe(false);
  });
});

describe('v2.4 tools on the FakeUe (Constructor)', () => {
  it('configure_set: a part by id, doors; a closet door without a closet is refused before UE', async () => {
    const { o, ue, s, setId } = await roomWithSet();
    const list = await o.runTool(s, 'list_options', { part: 'faucet' }, 'model', 't-1');
    expect(list).toMatchObject({ ok: true, target: { kind: 'set', setId } });
    const faucet = list.parts[0].options.find((x: any) => !x.current) ?? list.parts[0].options[0];
    const colour = faucet.colours[faucet.colours.length - 1];
    const r = await o.runTool(s, 'configure_set', { part: 'faucet', option: faucet.id, colourId: colour.id }, 'model', 't-1');
    expect(r).toMatchObject({ ok: true, setId });
    const set = ue.sets.find((x) => x.setId === setId)!;
    expect(c.resolvedModel(set.config, 'faucet')!.rowId).toBe(faucet.id);
    expect(await o.runTool(s, 'configure_set', { doors: 'open' }, 'model', 't-1')).toMatchObject({ ok: true });
    expect(set.doors?.cabinet).toBe('open');
    const before = ue.log.length;
    expect(await o.runTool(s, 'configure_set', { part: 'closet', doors: 'open' }, 'model', 't-1')).toMatchObject({ ok: false });
    expect(ue.log.slice(before).some((x) => x.cmd === 'configure_set')).toBe(false);
  });

  it('move_set: left / right as the visitor sees it, too far → maxShiftCm, another wall; results match the contract', async () => {
    const { o, ue, s, setId } = await roomWithSet(300, 250);
    const set = ue.sets.find((x) => x.setId === setId)!;
    const start0 = set.startCm;
    expect(await o.runTool(s, 'move_set', { direction: 'left', distanceCm: 10 }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/10 см левее/) });
    expect(set.startCm).toBeCloseTo(start0 - 10, 5);
    const far = await o.runTool(s, 'move_set', { direction: 'right', distanceCm: 900 }, 'model', 't-1');
    expect(far).toMatchObject({ ok: false, reasonCode: 'NO_FIT', maxShiftCm: expect.any(Number), say: expect.stringMatching(/Можно сдвинуть на \d+ см/) });
    const ok = await o.runTool(s, 'move_set', { direction: 'right', distanceCm: far.maxShiftCm }, 'model', 't-1');
    expect(ok.ok).toBe(true);
    expect(await o.runTool(s, 'move_set', { segmentId: 1, position: 'start' }, 'model', 't-1')).toMatchObject({ ok: true });
    expect(set.segmentId).toBe(1);
    expect(set.setId).toBe(setId);
    const raw = await o.command(s, 'move_set', { setId, direction: 'left', distanceCm: 5 }, 'model');
    expect(validator('maximall/ai/_command_args.json#/$defs/args_move_set')({ setId, direction: 'left', distanceCm: 5 })).toBe(true);
    expect(validator('maximall/ai/commands.schema.json#/$defs/setSummary')(raw.result)).toBe(true);
    expect(await o.runTool(s, 'move_set', {}, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/Куда передвинуть/) });
  });

  it('doors and windows: add, move, resize, remove; ambiguity and a door over the set', async () => {
    const { o, ue, s, setId } = await roomWithSet(300, 250);
    expect(await o.runTool(s, 'add_opening', { kind: 'window' }, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/На какую стену/) });
    expect(await o.runTool(s, 'add_opening', { kind: 'window', segmentId: 2 }, 'model', 't-1')).toMatchObject({ ok: true, say: 'Добавила окно.' });
    expect(await o.runTool(s, 'update_opening', { kind: 'window', widthCm: 90, sillCm: 100 }, 'model', 't-1')).toMatchObject({ ok: true });
    const win = ue.walls[2].openings[0];
    expect(win).toMatchObject({ widthCm: 90, sillCm: 100 });
    const off = win.offsetCm;
    expect(await o.runTool(s, 'update_opening', { kind: 'window', direction: 'right', distanceCm: 20 }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/20 см правее/) });
    expect(ue.walls[2].openings[0].offsetCm).toBe(off + 20);
    // a door on the set's wall over the set → refused with the obstacle
    const set = ue.sets.find((x) => x.setId === setId)!;
    expect(await o.runTool(s, 'add_opening', { kind: 'door', segmentId: set.segmentId, offsetCm: set.startCm }, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/перекрывает гарнитур/) });
    expect(await o.runTool(s, 'add_opening', { kind: 'window', segmentId: 3 }, 'model', 't-1')).toMatchObject({ ok: true });
    expect(await o.runTool(s, 'remove_opening', { kind: 'window' }, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/уточните/) });
    expect(await o.runTool(s, 'remove_opening', { kind: 'window', segmentId: 3 }, 'model', 't-1')).toMatchObject({ ok: true, say: 'Убрала окно.' });
    expect(await o.runTool(s, 'remove_opening', { kind: 'door' }, 'model', 't-1')).toMatchObject({ ok: false, say: expect.stringMatching(/нет двери/) });
  });

  it('finish_surface: baseboard, a door frame, clear; a tile on a frame is refused', async () => {
    const { o, ue, s } = await roomWithSet(300, 250);
    await o.runTool(s, 'add_opening', { kind: 'door', segmentId: 2, offsetCm: 20 }, 'model', 't-1');
    expect(await o.runTool(s, 'finish_surface', { target: 'baseboard', paintCode: 'RAL 9010' }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/плинтус/) });
    expect(ue.finishes.baseboard).toMatchObject({ type: 'paint', code: 'RAL 9010' });
    expect(await o.runTool(s, 'finish_surface', { target: 'opening_trim', kind: 'door', paintCode: 'RAL 7016' }, 'model', 't-1')).toMatchObject({ ok: true });
    expect(await o.runTool(s, 'finish_surface', { target: 'opening_trim', kind: 'door', tileId: 'Tile_White30' }, 'model', 't-1')).toMatchObject({ ok: false });
    expect(await o.runTool(s, 'finish_surface', { target: 'baseboard', clear: true }, 'model', 't-1')).toMatchObject({ ok: true, say: expect.stringMatching(/исходная/) });
    expect(ue.finishes.baseboard).toBeUndefined();
    expect(s.finishes.some((x) => x.surface === 'плинтус')).toBe(false);
  });
});

describe('v2.4 scripted policy (mock / LLM-timeout fallback)', () => {
  it('maps the new manual actions; older phrases keep their tools', async () => {
    const { parseTurn } = await import('../src/ai/orchestrator/intents');
    const one = (t: string, m: 'showroom' | 'constructor' = 'constructor') => parseTurn(t, m).calls;
    expect(one('Сдвинь комплект левее на 20 см')).toEqual([{ name: 'move_set', input: { direction: 'left', distanceCm: 20 } }]);
    expect(one('Подвинь тумбу чуть правее')).toEqual([{ name: 'move_set', input: { direction: 'right', distanceCm: 10 } }]);
    expect(one('Сдвинь окно вправо на 30 сантиметров')).toEqual([{ name: 'update_opening', input: { kind: 'window', direction: 'right', distanceCm: 30 } }]);
    expect(one('Убери окно')).toEqual([{ name: 'remove_opening', input: { kind: 'window' } }]);
    expect(one('Открой дверцы')).toEqual([{ name: 'configure_set', input: { doors: 'open' } }]);
    expect(one('Открой дверцы шкафа', 'showroom')).toEqual([{ name: 'booth_configure', input: { doors: 'open', part: 'closet' } }]);
    expect(one('Ну открой двери.', 'showroom')).toEqual([{ name: 'booth_configure', input: { doors: 'open' } }]);
    expect(one('Какие есть раковины?', 'showroom')).toEqual([{ name: 'list_options', input: { part: 'sink' } }]);
    expect(one('Покажи варианты зеркал')).toEqual([{ name: 'list_options', input: { part: 'mirror' } }]);
    expect(one('Покрась плинтус в белый')).toEqual([{ name: 'finish_surface', input: { target: 'baseboard', paintSystem: 'RAL', paintCode: 'RAL 9010' } }]);
    expect(one('Покрась стены в белый')[0]).toMatchObject({ name: 'finish_surface', input: { target: 'all_walls' } });
    expect(one('Закрой конструктор')).toEqual([{ name: 'exit_constructor', input: {} }]);
    expect(one('Покажи варианты')[0]).toMatchObject({ name: 'propose_sets' });
  });

  it('live finding: «дверцы» (cabinet doors) in the salon is not a room action (no Constructor offer); a room door still is', async () => {
    const { isRoomAction } = await import('../src/ai/orchestrator/modes');
    for (const t of ['Открой дверцы', 'Закрой дверцы', 'Открой дверки шкафа', 'Ну открой двери.', 'Открой дверь тумбе «Milu».']) expect(isRoomAction(t), t).toBeNull(); // live 2026-10-03
    for (const t of ['Где будет дверь?', 'Поставь дверь слева', 'У меня окно напротив']) expect(isRoomAction(t), t).toBe('room');
  });
});

describe('v2.4 tool surface', () => {
  it('every tool of a mode exists; the new tools are where they belong; schemas know the new commands', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const t of [...SHOWROOM_TOOLS, ...CONSTRUCTOR_TOOLS]) expect(names.has(t), t).toBe(true);
    for (const t of ['list_options', 'move_set', 'add_opening', 'update_opening', 'remove_opening']) expect(CONSTRUCTOR_TOOLS.has(t), t).toBe(true);
    expect(SHOWROOM_TOOLS.has('list_options')).toBe(true);
    for (const t of ['move_set', 'add_opening', 'update_opening', 'remove_opening']) expect(SHOWROOM_TOOLS.has(t), t).toBe(false);
    const cmd = validator('maximall/ai/commands.schema.json#/$defs/commandName');
    for (const x of ['move_set', 'update_opening', 'remove_opening']) expect(cmd(x), x).toBe(true);
    expect(validator('maximall/ai/commands.schema.json#/$defs/reasonCode')('NO_OPENING')).toBe(true);
    expect(validator('maximall/ai/_command_args.json#/$defs/args_configure_set')({ setId: 's', doors: { cabinet: 'open' } })).toBe(true);
    expect(validator('maximall/ai/commands.schema.json#/$defs/finish')({ type: 'none' })).toBe(true);
  });
});
