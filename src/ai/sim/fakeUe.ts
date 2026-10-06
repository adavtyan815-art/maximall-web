import type { CatalogIndex } from '../catalog/index';
import { fullConfig } from '../catalog/index';
import type { SetConfig } from '../catalog/types';

/**
 * In-process simulation of the UE server dispatcher (commands.schema.json) for tests, the phrase harness and the
 * WEB/QA fake page. It is NOT the real fit solver: it models walls as 1D spans (door openings block the floor span,
 * 2 cm corner clearance, no overlap with other sets). Results follow the envelope/commands result shapes.
 */
interface Wall {
  segmentId: number;
  lengthCm: number;
  heightCm: number;
  openings: { openingId: string; kind: 'door' | 'window'; offsetCm: number; widthCm: number; heightCm: number; sillCm?: number }[];
}
interface PlacedSet {
  setId: string;
  config: Required<SetConfig>;
  segmentId: number;
  side: 'left' | 'right';
  startCm: number;
  widthCm: number;
  /** v2.4: RAL/NCS colours and doors of the set (configure_set customColour / clearCustomColour / doors). */
  customColours?: { component: string; code: string }[];
  doors?: Doors;
}
type DoorState = 'open' | 'closed' | 'none';
interface Doors {
  cabinet: DoorState;
  closet: DoorState;
}
/** The fake's door model: every cabinet has doors; the wall cabinet has doors when present. */
const doorsFor = (cfg: Required<SetConfig>, prev?: Doors): Doors => ({
  cabinet: prev?.cabinet && prev.cabinet !== 'none' ? prev.cabinet : 'closed',
  closet: cfg.closetSizeIndex >= 0 ? (prev?.closet && prev.closet !== 'none' ? prev.closet : 'closed') : 'none',
});
const PART_COMPONENTS = new Set(['cabinet', 'closet', 'doors', 'countertop', 'sink', 'faucet', 'mirror']);
interface Snapshot {
  walls: Wall[];
  sets: PlacedSet[];
  finishes: Record<string, any>;
}

export interface EnvelopeResult {
  type: 'result';
  id: string;
  cmd: string;
  ok: boolean;
  reasonCode?: string;
  reason?: string;
  result?: any;
  state_rev: number;
  elapsedMs?: number;
}

const CORNER = 2;

/** v2.0 salon booth (stable level actor name). */
export interface FakeBooth {
  boothId: string;
  label: string;
  productId: string;
  config: Required<SetConfig>;
  customColours: { component: string; code: string }[];
  doors?: Doors;
  undo: { productId: string; config: Required<SetConfig>; customColours: { component: string; code: string }[]; doors?: Doors }[];
}

/** UE commands refused with NOT_IN_PLANNER outside «Конструктор» (contracts v2.0; v2.4 move_set / update_opening / remove_opening). */
const ROOM_CMDS = new Set(['build_room', 'add_opening', 'check_fit', 'apply_config', 'configure_set', 'swap_set', 'remove_set', 'finish_surface', 'undo', 'reset', 'save_project', 'capture', 'move_set', 'update_opening', 'remove_opening']);

export class FakeUe {
  walls: Wall[] = [];
  sets: PlacedSet[] = [];
  finishes: Record<string, any> = {};
  rev = 0;
  private undoStack: Snapshot[] = [];
  private first: Snapshot | null = null;
  private seq = 0;
  log: { cmd: string; args: any; ok: boolean }[] = [];
  /** CR-UE-02 simulation: another visitor owns the shared planner -> planner-changing commands return PLANNER_BUSY. */
  otherOwner = false;
  /** v2.0: the requesting player is in «Конструктор» (room commands allowed). Legacy tests default to true. */
  inPlanner = true;
  /** v2.0: salon booths and the booth in focus (selection.openBoothId / boothId). */
  booths: FakeBooth[] = [];
  focusBoothId = '';
  /** QA-074 simulation: booth_configure customColour answers ok but the colour is not applied */
  dropPaint = false;
  /** v2.0: UE events produced by commands (planner_mode), for the fake page to forward as ai.ue.event. */
  events: { type: 'event'; event: string; data: any; state_rev: number }[] = [];
  constructor(private catalog: CatalogIndex, opts: { widthCm?: number; depthCm?: number; inPlanner?: boolean } = {}) {
    if (opts.widthCm && opts.depthCm) this.buildRoom({ widthCm: opts.widthCm, depthCm: opts.depthCm });
    if (opts.inPlanner !== undefined) this.inPlanner = opts.inPlanner;
    // The salon: one booth per collection (+ a second Milu), default configuration of each product.
    const products = catalog.listProducts();
    const mk = (p: (typeof products)[number], n: number): FakeBooth => {
      const size = p.cabinet.sizes[0].index;
      const config = fullConfig({ productId: p.productId, sizeIndex: size, colourIndex: catalog.colourIndicesForSize(p, size)[0] ?? 0, ...(catalog.defaultsFor(p.productId, size) ?? {}) });
      return { boothId: `Booth_${p.productId}_${n}`, label: `${p.collection ?? p.productId} — стенд ${n}`, productId: p.productId, config, customColours: [], undo: [] };
    };
    this.booths = products.map((p) => mk(p, 1));
    const milu = products.find((p) => p.productId === 'Milu');
    if (milu) this.booths.push(mk(milu, 2));
  }

  /** v2.0 helper for tests: focus a booth (what UE reports with booth_focus). */
  focusEvent(boothId: string) {
    this.focusBoothId = boothId;
    const b = this.booths.find((x) => x.boothId === boothId);
    return { type: 'event' as const, event: 'booth_focus', state_rev: this.rev, data: b ? { boothId, productId: b.productId, collection: this.catalog.getProduct(b.productId)?.collection ?? b.productId, label: b.label } : { boothId: '' } };
  }
  drainEvents() {
    return this.events.splice(0);
  }

  private boothState(b: FakeBooth) {
    const p = this.catalog.getProduct(b.productId)!;
    const options: Record<string, any> = {
      cabinet: { sizes: p.cabinet.sizes.map((s) => ({ index: s.index, name: s.name })), colours: this.catalog.colourIndicesForSize(p, b.config.sizeIndex).map((i) => ({ index: i, name: p.cabinet.colours.find((c) => c.index === i)?.name })) },
      closet: { models: p.closetModels.map((m) => ({ index: m.index, colours: m.colours.map((c) => ({ index: c.index, name: c.name })) })), noneAllowed: true },
    };
    // v2.4: the shared parts as the booth resolves them (models in the resolved space of the cabinet size)
    const sp = this.catalog.space(b.productId, b.config.sizeIndex);
    const models = (list: any[]) => list.map((m: any) => ({ index: m.index, colours: m.colours.map((c: any) => ({ index: c.index, name: c.name, sku: c.sku })), ...(m.kind ? { type: m.kind === 'BuiltIn' ? 'builtIn' : 'surfaceMounted' } : {}) }));
    if (sp) {
      if (sp.countertop.length) options.countertop = { models: models(sp.countertop) };
      if (sp.sink.length) options.sink = { models: models(sp.sink) };
      const kind = this.catalog.topKind(b.config);
      if (sp.faucet[kind].length) options.faucet = { models: models(sp.faucet[kind]) };
      if (sp.mirror.length) options.mirror = { models: models(sp.mirror) };
    }
    return {
      boothId: b.boothId,
      label: b.label,
      productId: b.productId,
      collection: p.collection,
      config: b.config,
      customColours: b.customColours,
      doors: doorsFor(b.config, b.doors),
      options,
      products: this.catalog.listProducts().map((x) => x.productId),
      undoAvailable: b.undo.length > 0,
    };
  }

  private snap(): Snapshot {
    return JSON.parse(JSON.stringify({ walls: this.walls, sets: this.sets, finishes: this.finishes }));
  }
  private restore(s: Snapshot) {
    this.walls = s.walls;
    this.sets = s.sets;
    this.finishes = s.finishes;
  }
  private mutate() {
    const s = this.snap();
    if (!this.first) this.first = s;
    this.undoStack.push(s);
  }

  state() {
    return {
      state_rev: this.rev,
      rooms: this.walls.length ? [{ roomId: 0, areaM2: (this.walls[0].lengthCm * this.walls[1].lengthCm) / 1e4, perimeterM: this.walls.reduce((a, w) => a + w.lengthCm, 0) / 100 }] : [],
      walls: this.walls.map((w) => ({
        segmentId: w.segmentId,
        lengthCm: w.lengthCm,
        heightCm: w.heightCm,
        roomSide: 'left',
        openings: w.openings,
        freeSpansCm: this.freeSpans(w).map((s) => ({ side: 'left', startCm: s[0], endCm: s[1] })),
      })),
      sets: this.sets.map((s) => this.setSummary(s)),
      finishes: this.finishes,
      undoDepth: this.undoStack.length,
      owner: { isYou: !this.otherOwner, active: true },
    };
  }

  private buildRoom(a: { widthCm: number; depthCm: number; heightCm?: number; openings?: any[] }) {
    const h = a.heightCm ?? 260;
    const lens = [a.widthCm, a.depthCm, a.widthCm, a.depthCm];
    this.walls = lens.map((l, i) => ({ segmentId: i, lengthCm: l, heightCm: h, openings: [] }));
    this.sets = [];
    for (const o of a.openings ?? []) {
      const w = this.walls[o.wallIndex ?? 0];
      const width = o.widthCm ?? (o.kind === 'door' ? 80 : 100);
      const offset = o.offsetCm ?? Math.max(CORNER, (w.lengthCm - width) / 2);
      if (offset + width > w.lengthCm) return false;
      w.openings.push({ openingId: `o${++this.seq}`, kind: o.kind, offsetCm: offset, widthCm: width, heightCm: o.heightCm ?? (o.kind === 'door' ? 205 : 120), sillCm: o.kind === 'window' ? o.sillCm ?? 90 : undefined });
    }
    return true;
  }

  /** Free floor spans of a wall: minus doors (plus 10 cm swing clearance each side) and placed sets. */
  private freeSpans(w: Wall, exceptSetId?: string): [number, number][] {
    const blocks: [number, number][] = [];
    for (const o of w.openings) if (o.kind === 'door') blocks.push([o.offsetCm - 10, o.offsetCm + o.widthCm + 10]);
    for (const s of this.sets) if (s.segmentId === w.segmentId && s.setId !== exceptSetId) blocks.push([s.startCm, s.startCm + s.widthCm]);
    blocks.sort((a, b) => a[0] - b[0]);
    const spans: [number, number][] = [];
    let cur = CORNER;
    for (const [a, b] of blocks) {
      if (a > cur) spans.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (w.lengthCm - CORNER > cur) spans.push([cur, w.lengthCm - CORNER]);
    return spans;
  }
  private spareAround(s: PlacedSet): number {
    const w = this.walls.find((x) => x.segmentId === s.segmentId);
    if (!w) return 0;
    return this.freeSpans(w).reduce((a, sp) => a + (sp[1] - sp[0]), 0);
  }

  private setSummary(s: PlacedSet) {
    return {
      setId: s.setId,
      config: s.config,
      placement: { segmentId: s.segmentId, side: s.side, offsetCm: s.startCm + s.widthCm / 2, spareCm: this.spareAround(s) },
      customColours: s.customColours ?? [],
      doors: doorsFor(s.config, s.doors),
    };
  }

  /** v2.4 customColour / clearCustomColour / doors on a set or booth: everything checked first (UE refuses before changing). */
  private extras(t: { customColours?: { component: string; code: string }[]; doors?: Doors }, a: any, after: Required<SetConfig>): { ok: true; apply: () => void } | { ok: false; reasonCode: string; reason: string } {
    const bad = (reasonCode: string, reason: string) => ({ ok: false as const, reasonCode, reason });
    const cc = a.customColour;
    if (cc) {
      if (!PART_COMPONENTS.has(cc.component) || !cc.code || !['RAL', 'NCS'].includes(cc.system)) return bad('BAD_ARGS', 'customColour: component, system RAL|NCS, code');
      if (cc.component === 'closet' && after.closetSizeIndex < 0) return bad('CATALOG_OPTION_INVALID', 'Навесного шкафа нет — красить нечего');
    }
    if (a.clearCustomColour !== undefined && !PART_COMPONENTS.has(a.clearCustomColour)) return bad('BAD_ARGS', `Неизвестная часть «${a.clearCustomColour}»`);
    const d = a.doors;
    if (d) {
      const okv = (v: any) => v === undefined || v === 'open' || v === 'closed';
      if (!okv(d.cabinet) || !okv(d.closet) || (d.cabinet === undefined && d.closet === undefined)) return bad('BAD_ARGS', 'doors: cabinet|closet = open|closed');
      if (d.closet && after.closetSizeIndex < 0) return bad('CATALOG_OPTION_INVALID', 'Навесного шкафа нет');
    }
    return {
      ok: true,
      apply: () => {
        if (a.clearCustomColour) {
          const drop = a.clearCustomColour === 'cabinet' || a.clearCustomColour === 'doors' ? ['cabinet', 'doors'] : [a.clearCustomColour];
          t.customColours = (t.customColours ?? []).filter((x) => !drop.includes(x.component));
        }
        if (cc) t.customColours = (t.customColours ?? []).filter((x) => x.component !== cc.component).concat({ component: cc.component, code: `${cc.system === 'RAL' && !/^ral/i.test(cc.code) ? 'RAL ' : ''}${cc.code}` });
        if (d) {
          const cur = doorsFor(after, t.doors);
          t.doors = { cabinet: d.cabinet ?? cur.cabinet, closet: d.closet ?? cur.closet };
        }
      },
    };
  }

  /** v2.4: the free span of a wall that contains [a, b] (the set itself ignored), if any. */
  private spanContaining(w: Wall, a: number, b: number, exceptSetId: string): [number, number] | undefined {
    return this.freeSpans(w, exceptSetId).find((sp) => sp[0] <= a + 1e-6 && sp[1] >= b - 1e-6);
  }

  private width(cfg: SetConfig) {
    return this.catalog.footprintWidthCm(cfg) ?? 80;
  }

  fit(cfg: SetConfig, placement?: { segmentId?: number }, replaceSetId?: string) {
    if (this.walls.length === 0) return { fits: false, reasonCode: 'NO_ROOM', reason: 'Сначала нужно построить комнату' };
    const invalid = this.catalog.validate(cfg);
    if (invalid) return { fits: false, reasonCode: 'CATALOG_OPTION_INVALID', reason: invalid };
    const width = this.width(cfg);
    const walls = placement?.segmentId !== undefined ? this.walls.filter((w) => w.segmentId === placement.segmentId) : this.walls;
    if (walls.length === 0) return { fits: false, reasonCode: 'NO_WALL', reason: 'Такой стены нет' };
    let best: { w: Wall; span: [number, number] } | null = null;
    for (const w of walls) for (const sp of this.freeSpans(w, replaceSetId)) if (sp[1] - sp[0] >= width && (!best || sp[1] - sp[0] > best.span[1] - best.span[0])) best = { w, span: sp };
    if (!best) {
      const door = walls.flatMap((w) => w.openings.filter((o) => o.kind === 'door').map((o) => o.openingId))[0];
      const p = this.catalog.getProduct(cfg.productId);
      const fitting = (p?.cabinet.sizes ?? []).filter((s) => walls.some((w) => this.freeSpans(w, replaceSetId).some((sp) => sp[1] - sp[0] >= this.width({ ...cfg, sizeIndex: s.index })))).map((s) => s.index);
      return { fits: false, reasonCode: 'NO_FIT', reason: 'Не помещается на свободном участке стены', fittingSizeIndices: fitting, ...(door ? { obstacle: { kind: 'opening', id: door } } : {}) };
    }
    const start = best.span[0] + (best.span[1] - best.span[0] - width) / 2;
    return {
      fits: true,
      placement: { segmentId: best.w.segmentId, side: 'left' as const, offsetCm: Math.round((start + width / 2) * 10) / 10, footprintCm: { width }, spareCm: Math.round(best.span[1] - best.span[0] - width) },
      _start: start,
    };
  }

  execute(req: { id: string; cmd: string; args: any }): EnvelopeResult {
    const t0 = Date.now();
    const r = this.run(req.cmd, req.args ?? {});
    this.log.push({ cmd: req.cmd, args: req.args, ok: r.ok });
    return { type: 'result', id: req.id, cmd: req.cmd, ok: r.ok, ...(r.ok ? {} : { reasonCode: r.reasonCode, reason: r.reason }), result: r.result ?? {}, state_rev: this.rev, elapsedMs: Date.now() - t0 };
  }

  private run(cmd: string, a: any): { ok: boolean; result?: any; reasonCode?: string; reason?: string } {
    const fail = (reasonCode: string, reason: string) => ({ ok: false, reasonCode, reason });
    const guarded =
      ['build_room', 'add_opening', 'apply_config', 'configure_set', 'swap_set', 'remove_set', 'finish_surface', 'undo', 'reset', 'move_set', 'update_opening', 'remove_opening'].includes(cmd) ||
      (cmd === 'consultant_summon' && a.mode === 'planner');
    if (this.otherOwner && (guarded || cmd === 'enter_constructor')) return fail('PLANNER_BUSY', 'Конструктор сейчас занят другим посетителем. Подождите немного или попросите консультанта в салоне.');
    // v2.2 P3-02: capture preset "booth" = a salon booth with its own camera: only outside «Конструктор», boothId required.
    if (cmd === 'capture' && a.preset === 'booth') {
      if (this.inPlanner) return fail('BAD_ARGS', 'Фото стенда делается в салоне');
      if (!a.boothId || !this.booths.some((x) => x.boothId === a.boothId)) return fail('NO_BOOTH', 'Стенд не найден');
      return { ok: true, result: { renderId: a.renderId, uploaded: true } };
    }
    if (!this.inPlanner && ROOM_CMDS.has(cmd)) return fail('NOT_IN_PLANNER', 'Откройте «Конструктор», чтобы менять комнату');
    const booth = () => this.booths.find((x) => x.boothId === (a.boothId || this.focusBoothId));
    switch (cmd) {
      case 'enter_constructor': {
        const already = this.inPlanner;
        this.inPlanner = true;
        // CR-UE-03: carry = {placed:true, setId, placement} or {placed:false, reasonCode} (NO_ROOM: the AI places it after build_room)
        let carry: any;
        if (a.carryConfig?.productId) {
          const cfg = fullConfig(a.carryConfig);
          const f: any = this.fit(cfg);
          if (f.fits) {
            this.mutate();
            const setId = `set-${++this.seq}`;
            this.sets.push({ setId, config: cfg, segmentId: f.placement.segmentId, side: 'left', startCm: f._start, widthCm: this.width(cfg) });
            this.rev++;
            carry = { placed: true, setId, placement: { segmentId: f.placement.segmentId, side: 'left', offsetCm: f._start + this.width(cfg) / 2 } };
          } else carry = { placed: false, reasonCode: f.reasonCode ?? 'NO_FIT', reason: f.reason };
        }
        this.events.push({ type: 'event', event: 'planner_mode', data: { inPlanner: true, view: '3D' }, state_rev: this.rev });
        return { ok: true, result: { ...this.state(), enteredPlanner: !already, alreadyInPlanner: already, ...(carry ? { carry } : {}) } };
      }
      case 'exit_constructor': {
        const was = this.inPlanner;
        this.inPlanner = false;
        this.events.push({ type: 'event', event: 'planner_mode', data: { inPlanner: false, view: null }, state_rev: this.rev });
        return { ok: true, result: { exited: was, wasInPlanner: was } };
      }
      case 'booth_get': {
        const b = booth();
        return b ? { ok: true, result: this.boothState(b) } : fail('NO_BOOTH', 'Стенд не выбран');
      }
      case 'booth_configure': {
        const b = booth();
        if (!b) return fail('NO_BOOTH', 'Стенд не выбран');
        const snap = { productId: b.productId, config: { ...b.config }, customColours: [...b.customColours], doors: b.doors ? { ...b.doors } : undefined };
        // v2.4: clearCustomColour / doors (alone or with a config change; customColour keeps its own path below)
        if ((a.clearCustomColour !== undefined || a.doors) && !a.productId && !a.customColour) {
          const next = fullConfig({ ...b.config, ...(a.config ?? {}), productId: b.productId });
          const invalid = a.config ? this.catalog.validate(next) : null;
          if (invalid) return fail('CATALOG_OPTION_INVALID', invalid);
          const ex = this.extras(b, a, next);
          if (!ex.ok) return fail(ex.reasonCode, ex.reason);
          b.undo.push(snap);
          b.config = next;
          ex.apply();
          return { ok: true, result: this.boothState(b) };
        }
        if (a.productId) {
          const p = this.catalog.getProduct(a.productId);
          if (!p) return fail('CATALOG_OPTION_INVALID', 'Нет такого товара');
          const size = p.cabinet.sizes[0].index;
          b.undo.push(snap);
          b.productId = p.productId;
          b.config = fullConfig({ productId: p.productId, sizeIndex: size, colourIndex: this.catalog.colourIndicesForSize(p, size)[0] ?? 0, ...(this.catalog.defaultsFor(p.productId, size) ?? {}) });
          b.customColours = [];
          return { ok: true, result: this.boothState(b) };
        }
        if (a.customColour?.code) {
          if (this.dropPaint) return { ok: true, result: this.boothState(b) };
          b.undo.push(snap);
          b.customColours = b.customColours.filter((x) => x.component !== a.customColour.component).concat({ component: a.customColour.component ?? 'cabinet', code: a.customColour.code });
          return { ok: true, result: this.boothState(b) };
        }
        const next = fullConfig({ ...b.config, ...(a.config ?? {}), productId: b.productId });
        const invalid = this.catalog.validate(next);
        if (invalid) return fail('CATALOG_OPTION_INVALID', invalid);
        b.undo.push(snap);
        b.config = next;
        return { ok: true, result: this.boothState(b) };
      }
      case 'booth_undo': {
        const b = booth();
        if (!b) return fail('NO_BOOTH', 'Стенд не выбран');
        const prev = b.undo.pop();
        if (!prev) return fail('NOTHING_TO_UNDO', 'Возвращать нечего');
        b.productId = prev.productId;
        b.config = prev.config;
        b.customColours = prev.customColours;
        b.doors = prev.doors;
        return { ok: true, result: this.boothState(b) };
      }
      case 'get_state':
        return { ok: true, result: this.state() };
      case 'build_room': {
        this.mutate();
        if (!this.buildRoom(a)) {
          this.restore(this.undoStack.pop()!);
          return fail('OPENING_CONFLICT', 'Проём не помещается на стене');
        }
        this.rev++;
        return { ok: true, result: this.state() };
      }
      case 'check_fit': {
        const results = (a.candidates ?? []).slice(0, 40).map((c: any, i: number) => {
          const f: any = this.fit(c.config, c.placement, c.replaceSetId);
          delete f._start;
          return { key: c.key ?? String(i), ...f };
        });
        return { ok: true, result: { results } };
      }
      case 'apply_config': {
        const f: any = this.fit(a.config, a.placement, a.replaceSetId);
        if (!f.fits) return fail(f.reasonCode, f.reason);
        this.mutate();
        if (a.replaceSetId) this.sets = this.sets.filter((s) => s.setId !== a.replaceSetId);
        const setId = `set-${++this.seq}`;
        const cfg = fullConfig(a.config);
        this.sets.push({ setId, config: cfg, segmentId: f.placement.segmentId, side: 'left', startCm: f._start, widthCm: this.width(cfg) });
        this.rev++;
        return { ok: true, result: { setId, config: cfg, placement: f.placement } };
      }
      case 'configure_set':
      case 'swap_set': {
        const s = this.sets.find((x) => x.setId === (a.setId ?? (this.sets.length === 1 ? this.sets[0].setId : undefined)));
        if (!s) return fail('NO_SET', 'Такого комплекта нет в комнате');
        // v2.4: configure_set config is optional (customColour / clearCustomColour / doors)
        const hasExtras = cmd === 'configure_set' && (a.customColour || a.clearCustomColour !== undefined || a.doors);
        if (cmd === 'configure_set' && !a.config && !hasExtras) return fail('BAD_ARGS', 'Укажите config, customColour, clearCustomColour или doors');
        const cfg = fullConfig(cmd === 'swap_set' ? a.config : { ...s.config, ...(a.config ?? {}) });
        const invalid = this.catalog.validate(cfg);
        if (invalid) return fail('CATALOG_OPTION_INVALID', invalid);
        const ex = hasExtras ? this.extras(s, a, cfg) : null;
        if (ex && !ex.ok) return fail(ex.reasonCode, ex.reason);
        const f: any = this.fit(cfg, { segmentId: s.segmentId }, s.setId);
        if (!f.fits) return fail('NO_FIT', f.reason);
        this.mutate();
        s.config = cfg;
        s.widthCm = this.width(cfg);
        s.startCm = Math.min(s.startCm, f._start + (f.placement.spareCm ?? 0));
        if (cmd === 'swap_set') s.customColours = [];
        if (ex?.ok) ex.apply();
        this.rev++;
        return { ok: true, result: this.setSummary(s) };
      }
      case 'move_set': {
        // v2.4: the same set moves (id, config, colours, doors kept); direction = as seen facing the set (left face: right = +along)
        const s = this.sets.find((x) => x.setId === (a.setId ?? (this.sets.length === 1 ? this.sets[0].setId : undefined)));
        if (!s) return fail('NO_SET', 'Такого комплекта нет в комнате');
        const hasShift = a.direction !== undefined;
        if (hasShift === !!a.placement) return fail('BAD_ARGS', 'Укажите либо placement, либо direction + distanceCm');
        if (hasShift && !(a.distanceCm >= 1 && a.distanceCm <= 1000)) return fail('BAD_ARGS', 'Не указано поле «distanceCm»');
        const from = { segmentId: s.segmentId, side: s.side, offsetCm: s.startCm + s.widthCm / 2 };
        let seg = s.segmentId;
        let start: number;
        if (hasShift) {
          const delta = (a.direction === 'right' ? 1 : -1) * a.distanceCm;
          start = s.startCm + delta;
          const w = this.walls.find((x) => x.segmentId === seg)!;
          if (!this.spanContaining(w, start, start + s.widthCm, s.setId)) {
            const own = this.spanContaining(w, s.startCm, s.startCm + s.widthCm, s.setId);
            const max = own ? (delta > 0 ? own[1] - (s.startCm + s.widthCm) : s.startCm - own[0]) : 0;
            return { ok: false, reasonCode: 'NO_FIT', reason: 'Дальше комплект не сдвинуть: мешает стена, проём или другой комплект', result: max >= 1 ? { maxShiftCm: Math.floor(max) } : {} };
          }
        } else {
          const p = a.placement;
          seg = p.segmentId ?? s.segmentId;
          const w = this.walls.find((x) => x.segmentId === seg);
          if (!w) return fail('NO_WALL', `Стены ${seg} нет в плане`);
          const spans = this.freeSpans(w, s.setId).filter((sp) => sp[1] - sp[0] >= s.widthCm);
          if (!spans.length) return fail('NO_FIT', 'На этой стене комплект не помещается');
          if (p.offsetCm !== undefined) start = p.offsetCm - s.widthCm / 2;
          else if (p.anchor === 'start') start = spans[0][0];
          else if (p.anchor === 'end') start = spans[spans.length - 1][1] - s.widthCm;
          else {
            const best = spans.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
            start = best[0] + (best[1] - best[0] - s.widthCm) / 2;
          }
          if (!this.spanContaining(w, start, start + s.widthCm, s.setId)) return fail('NO_FIT', 'Там комплект не помещается');
        }
        this.mutate();
        const before = from.offsetCm;
        s.segmentId = seg;
        s.startCm = start;
        this.rev++;
        const moved = seg === from.segmentId ? Math.abs(s.startCm + s.widthCm / 2 - before) : Math.abs(s.startCm + s.widthCm / 2 - before) + 1;
        return { ok: true, result: { ...this.setSummary(s), from, movedCm: Math.round(moved * 10) / 10 } };
      }
      case 'remove_set': {
        if (!this.sets.some((x) => x.setId === a.setId)) return fail('NO_SET', 'Такого комплекта нет в комнате');
        this.mutate();
        this.sets = this.sets.filter((x) => x.setId !== a.setId);
        this.rev++;
        return { ok: true, result: {} };
      }
      case 'finish_surface': {
        if (this.walls.length === 0) return fail('NO_ROOM', 'Сначала нужно построить комнату');
        const kind = a.target?.kind;
        if (!['wall_face', 'all_walls', 'floor', 'ceiling', 'baseboard', 'opening_trim'].includes(kind)) return fail('BAD_ARGS', 'target.kind');
        if (!['paint', 'tile', 'none'].includes(a.finish?.type)) return fail('BAD_ARGS', 'finish.type');
        if (kind === 'opening_trim') {
          if (!a.target.openingId) return fail('BAD_ARGS', 'Не указано поле «openingId»');
          if (!this.walls.some((w) => w.openings.some((o) => o.openingId === a.target.openingId))) return fail('NO_OPENING', `Проёма «${a.target.openingId}» нет в плане`);
          if (a.finish.type === 'tile') return fail('BAD_ARGS', 'Наличник проёма красится, плитка на него не кладётся');
        }
        this.mutate();
        const k = kind === 'wall_face' ? `wall_${a.target.segmentId}_${a.target.side}` : kind === 'opening_trim' ? `trim_${a.target.openingId}` : kind;
        if (a.finish.type === 'none') delete this.finishes[k];
        else this.finishes[k] = a.finish;
        this.rev++;
        return { ok: true, result: { applied: kind === 'all_walls' ? this.walls.length : 1 } };
      }
      case 'undo': {
        const s = this.undoStack.pop();
        if (!s) return fail('NOTHING_TO_UNDO', 'Нечего отменять');
        this.restore(s);
        this.rev++;
        return { ok: true, result: this.state() };
      }
      case 'reset': {
        if (this.first) this.restore(this.first);
        this.undoStack = [];
        this.rev++;
        return { ok: true, result: this.state() };
      }
      case 'save_project':
        return { ok: true, result: { saveId: `save-${Date.now()}`, username: a.username ?? '' } };
      case 'capture':
        return { ok: true, result: { renderId: a.renderId, uploaded: true } };
      case 'consultant_say':
      case 'consultant_summon':
        return { ok: true, result: cmd === 'consultant_summon' ? { consultantId: 'consultant-0' } : {} };
      case 'add_opening':
      case 'update_opening': {
        // v2.4 simulation: same wall, near-edge offset, no overlap with another opening, a door never over a set
        let w: Wall | undefined;
        let op: Wall['openings'][number] | undefined;
        if (cmd === 'update_opening') {
          w = this.walls.find((x) => (a.segmentId === undefined || x.segmentId === a.segmentId) && x.openings.some((o) => o.openingId === a.openingId)) ?? this.walls.find((x) => x.openings.some((o) => o.openingId === a.openingId));
          op = w?.openings.find((o) => o.openingId === a.openingId);
          if (!w || !op) return fail('NO_OPENING', `Проёма «${a.openingId}» нет в плане`);
          if (a.sillCm !== undefined && op.kind === 'door') return fail('BAD_ARGS', 'У двери нет подоконника');
          if (a.offsetCm === undefined && a.direction === undefined && a.widthCm === undefined && a.heightCm === undefined && a.sillCm === undefined) return fail('BAD_ARGS', 'Укажите, что изменить');
        } else {
          if (!['door', 'window'].includes(a.kind)) return fail('BAD_ARGS', 'kind');
          w = this.walls.find((x) => x.segmentId === a.segmentId);
          if (!w) return fail('NO_WALL', `Стены ${a.segmentId} нет в плане`);
        }
        const kind = op?.kind ?? a.kind;
        const width = a.widthCm ?? op?.widthCm ?? (kind === 'door' ? 80 : 100);
        let offset = a.offsetCm ?? op?.offsetCm ?? (w.lengthCm - width) / 2;
        if (cmd === 'update_opening' && a.direction) offset += (a.direction === 'right' ? 1 : -1) * (a.distanceCm ?? 0);
        const cand = { openingId: op?.openingId ?? `o${++this.seq}`, kind, offsetCm: offset, widthCm: width, heightCm: a.heightCm ?? op?.heightCm ?? (kind === 'door' ? 205 : 120), sillCm: kind === 'window' ? a.sillCm ?? op?.sillCm ?? 90 : undefined };
        if (offset < 0 || offset + width > w.lengthCm) return fail('OPENING_CONFLICT', 'Проём не помещается на стене');
        if (w.openings.some((o) => o.openingId !== cand.openingId && o.offsetCm < offset + width && offset < o.offsetCm + o.widthCm)) return fail('OPENING_CONFLICT', 'Проём перекрывает другой проём');
        const hit = this.sets.find((s) => s.segmentId === w!.segmentId && s.startCm < offset + width && offset < s.startCm + s.widthCm);
        if (hit && kind === 'door') return { ok: false, reasonCode: 'OPENING_CONFLICT', reason: 'Дверь перекрывает гарнитур у этой стены', result: { obstacle: { kind: 'set', id: hit.setId } } };
        this.mutate();
        if (op) Object.assign(op, cand);
        else w.openings.push(cand);
        this.rev++;
        return { ok: true, result: cmd === 'add_opening' ? { openingId: cand.openingId, segmentId: w.segmentId } : { ...cand, segmentId: w.segmentId } };
      }
      case 'remove_opening': {
        const w = this.walls.find((x) => x.openings.some((o) => o.openingId === a.openingId));
        if (!w) return fail('NO_OPENING', `Проёма «${a.openingId}» нет в плане`);
        this.mutate();
        w.openings = w.openings.filter((o) => o.openingId !== a.openingId);
        this.rev++;
        return { ok: true, result: { removedOpeningId: a.openingId, segmentId: w.segmentId } };
      }
      default:
        return fail('UNKNOWN_CMD', `Неизвестная команда ${cmd}`);
    }
  }
}
