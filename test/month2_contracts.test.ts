import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * MONTH2_SPEC m2.2 §7.10 / §11.6 / M1: the new contract files compile (with every other contract, as the app loads them) and the
 * §7 / §11 examples validate; malformed messages are refused.
 */

const dir = path.join(__dirname, '..', 'contracts');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of files) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const P = 'maximall/ai/placement.schema.json';
const E = 'maximall/ai/estimate-api.schema.json';
const v = (ref: string) => {
  const fn = ajv.getSchema(ref);
  if (!fn) throw new Error('no schema ' + ref);
  return fn;
};
const ok = (ref: string, data: unknown) => {
  const fn = v(ref);
  const res = fn(data);
  if (!res) throw new Error(`${ref} rejected ${JSON.stringify(data).slice(0, 300)}: ${JSON.stringify(fn.errors?.slice(0, 3))}`);
};
const bad = (ref: string, data: unknown) => expect(v(ref)(data), JSON.stringify(data).slice(0, 200)).toBe(false);

const MILU_CONFIG = {
  productId: 'Milu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 0, closetSizeIndex: -1, closetColourIndex: 0,
  sinkSizeIndex: 0, sinkColourIndex: 0, faucetSizeIndex: 0, faucetColourIndex: 0, mirrorSizeIndex: 3, mirrorColourIndex: 0,
};
const env = (cmd: string, args: object, extra: object = {}) => ({ type: 'MaxiMallPlacement', v: 1, id: 'p-1759935600123-7', cmd, origin: 'ui', args, ...extra });
const ev = (event: string, data: object) => ({ type: 'event', event, data });

describe('M1 contracts: schemas', () => {
  it('every contract compiles, the new ones included', () => {
    expect(files).toContain('placement.schema.json');
    expect(files).toContain('estimate-api.schema.json');
    for (const f of files) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(() => ajv.getSchema(s.$id), f).not.toThrow();
      expect(ajv.getSchema(s.$id), f).toBeTruthy();
    }
    for (const ref of ['request', 'result', 'event', 'reasonCode']) expect(v(`${P}#/$defs/${ref}`)).toBeTruthy();
    for (const ref of ['request', 'response', 'line', 'basket']) expect(v(`${E}#/$defs/${ref}`)).toBeTruthy();
  });

  it('the envelope event enum lists the four m2.2 events', () => {
    const envSchema = JSON.parse(fs.readFileSync(path.join(dir, 'envelope.schema.json'), 'utf8'));
    const names: string[] = envSchema.$defs.event.properties.event.enum;
    for (const n of ['placement_result', 'placement_preview_state', 'room_roster_update', 'room_estimate_state']) expect(names).toContain(n);
    for (const n of ['ready', 'state_changed', 'consultant_speaking', 'capture_progress', 'selection_changed', 'planner_mode', 'booth_focus']) expect(names).toContain(n);
    ok('maximall/ai/envelope.schema.json#/$defs/event', ev('room_roster_update', {}));
    ok('maximall/ai/envelope.schema.json#/$defs/event', { type: 'event', event: 'planner_mode', state_rev: 3, data: { inPlanner: true, view: '3D' } });
  });
});

describe('M1 contracts: placement requests (§7.2, §7.3)', () => {
  const R = `${P}#/$defs/request`;
  it('accepts one example per command', () => {
    ok(R, env('m2_hello', {}));
    ok(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_preview', args: { dragId: 'd-1', seq: 0, kind: 'set', itemId: 'Milu', sku: 'MIL80A', x: 0.5412, y: 0.62, snapEnabled: true, yawDeg: 0 } });
    ok(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_cancel', args: { dragId: 'd-1' } });
    ok(R, env('placement_commit', { dragId: 'd-1', kind: 'set', itemId: 'Milu', x: 0.54, y: 0.62, snapEnabled: false, config: MILU_CONFIG }));
    ok(R, env('placement_commit', { kind: 'object', itemId: 'Chair_Dining02', x: 0.4, y: 0.7, yawDeg: 90, finishId: 'RAL 9010' }, { origin: 'model' }));
    ok(R, env('object_transform', { instanceId: 'AB12CD34', location: { x: 120, y: 45, z: 82.5 }, rotation: { pitch: 0, yaw: 90, roll: 0 } }));
    ok(R, env('object_transform', { instanceId: 'AB12CD34', location: { x: 120, y: 45, z: 0 }, yawDeg: 45, snapEnabled: false }));
    ok(R, env('object_delete', { instanceId: 'AB12CD34' }));
    ok(R, env('delete', { instanceId: 'AB12CD34' }));
    ok(R, env('object_select', { instanceId: '' }));
    ok(R, env('object_replace', { instanceId: 'AB12CD34', itemId: 'Armchair_Modern01' }));
    ok(R, env('object_finish', { instanceId: 'AB12CD34', finishId: '#A1B2C3' }));
  });

  it('refuses malformed requests', () => {
    bad(R, { ...env('m2_hello', {}), type: 'MaxiMallAI' });
    bad(R, { ...env('m2_hello', {}), v: 2 }); // BAD_VERSION
    bad(R, { ...env('m2_hello', {}), id: 'r-1-1' }); // AI id
    bad(R, env('m2_hello', { extra: 1 })); // UNKNOWN_FIELD
    bad(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_commit', args: { kind: 'set', itemId: 'Milu', x: 0.5, y: 0.5 } }); // id required
    bad(R, env('placement_commit', { kind: 'tile', itemId: 'Tile_Grey60', x: 0.5, y: 0.5 }));
    bad(R, env('placement_commit', { kind: 'object', itemId: 'x'.repeat(65), x: 0.5, y: 0.5 }));
    bad(R, env('placement_commit', { kind: 'set', itemId: 'Milu', x: 0.5, y: 0.5, config: { ...MILU_CONFIG, bogus: 1 } }));
    bad(R, env('placement_commit', { kind: 'object', itemId: 'Chair_Dining02', x: 0.5, y: 0.5, finishId: 'x'.repeat(41) }));
    bad(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_preview', args: { dragId: 'd', seq: -1, kind: 'set', itemId: 'Milu', x: 0, y: 0 } });
    bad(R, env('object_transform', { instanceId: 'A', location: { x: 1, y: 2 } }));
    bad(R, env('unknown_cmd', {}));
    bad(R, { ...env('m2_hello', {}), origin: 'card_tap' });
  });
});

describe('M1 contracts: UE -> page events (§7.4, §7.6, §10.3, §11.2)', () => {
  const EV = `${P}#/$defs/event`;
  it('accepts the spec examples', () => {
    ok(EV, ev('placement_result', { id: 'p-1759935600123-7', cmd: 'placement_commit', ok: false, reasonCode: 'OVERLAP', reason: 'Место занято другим предметом', reasonParams: { detail: 'PENETRATION', depthCm: 12 }, result: {}, stateRev: -1, elapsedMs: 143 }));
    ok(EV, ev('placement_result', { id: 'p-1-1', cmd: 'placement_commit', ok: true, reasonCode: '', reason: '', result: { instanceId: 'AB12CD34', kind: 'set', itemId: 'Milu', target: 'wall', segmentId: 2, side: 'left', heightCm: 0, location: { x: 1, y: 2, z: 0 }, yawDeg: 90, snapped: ['wall'] }, stateRev: 7 }));
    ok(EV, ev('placement_preview_state', { dragId: 'd-1', seq: 4, valid: false, reasonCode: 'NO_FIT', detail: 'WALL_EXTENT', kind: 'set', itemId: 'Milu', target: 'wall', category: 'SinkVanity', heightCm: 0, snapped: ['wall', 'height'] }));
    ok(EV, ev('selection_changed', { kind: 'object', instanceId: 'AB12CD34', itemId: 'Chair_Dining02', category: 'Other', mount: 'floor', lockedByPlayerId: -1, view: '3D' }));
    ok(EV, ev('selection_changed', { kind: 'none', instanceId: '', itemId: '', category: '', mount: '', lockedByPlayerId: -1, view: '2D' }));
    ok(EV, ev('room_roster_update', {
      rev: '3f2a91c0', count: 2, hostId: 'p256', youId: 'p257',
      participants: [
        { id: 'p256', playerId: 256, name: 'artur', isHost: true, isGuest: false, guestIndex: 0, isYou: false, isEditing: false },
        { id: 'p257', playerId: 257, name: '', isHost: false, isGuest: true, guestIndex: 1, isYou: true, isEditing: true },
      ],
    }));
    ok(EV, ev('room_estimate_state', {
      rev: '9b1e44d2', plannerInstanceId: 'planner', units: { area: 'm2', length: 'm', height: 'cm' },
      sets: [{ instanceIds: ['AB12CD34'], qty: 1, productId: 'Milu', config: MILU_CONFIG, productName: 'Oliveeka Milu', sku: 'MIL80A', customColours: [] }],
      objects: [{ assetId: 'Chair_Dining02', name: 'Стул', category: 'Other', mount: 'floor', qty: 1 }],
      surfaces: [
        { kind: 'wall', finish: 'tile:Tile_Grey60', faces: 1, grossM2: 8.1, openingsM2: 1.89, areaM2: 6.21 },
        { kind: 'floor', finish: 'RAL 9010', faces: 1, areaM2: 7.5 },
        { kind: 'ceiling', finish: '', faces: 1, areaM2: 7.5 },
      ],
      baseboards: [{ finish: '', lengthM: 10.1 }],
      rooms: [{ roomId: 0, areaM2: 7.5, perimeterM: 11.0, ceilingHeightCm: 270 }],
      counts: { sets: 1, objects: 1 }, truncated: false,
    }));
    // §7.3 result shapes
    ok(`${P}#/$defs/result_m2_hello`, { contract: 'm2.2', features: ['placement', 'gizmo', 'roster', 'estimate'], inPlanner: true, view: '3D' });
    ok(`${P}#/$defs/result_m2_hello`, { contract: 'm2.2', features: [], inPlanner: false, view: null });
    ok(`${P}#/$defs/result_object_transform`, { instanceId: 'A', location: { x: 0, y: 0, z: 0 }, yawDeg: 0, heightCm: 120 });
    ok(`${P}#/$defs/result_object_select`, { selected: null });
  });

  it('refuses malformed events', () => {
    bad(EV, ev('placement_result', { id: 'p-1-1', cmd: 'placement_commit', ok: false, reasonCode: 'NOT_A_CODE', stateRev: -1 }));
    bad(EV, ev('placement_result', { id: 'p-1-1', cmd: 'placement_commit', ok: true, stateRev: -2 }));
    bad(EV, ev('placement_result', { id: 'p-1-1', cmd: 'placement_commit', ok: true, stateRev: 1, state_rev: 1 })); // no state_rev in m2 events
    bad(EV, { ...ev('room_roster_update', { rev: '1', count: 0, hostId: '', youId: '', participants: [] }), state_rev: 3 });
    bad(EV, ev('room_roster_update', { rev: '1', count: 1, hostId: '', youId: '', participants: [{ id: 'p1', playerId: 1, name: 'x'.repeat(33), isHost: true, isGuest: false, guestIndex: 0, isYou: true, isEditing: false }] }));
    bad(EV, ev('placement_preview_state', { dragId: 'd', seq: 0, valid: true, kind: 'set', itemId: 'Milu', target: 'ceiling', category: 'SinkVanity', snapped: [] }));
    bad(EV, ev('room_estimate_state', { rev: '1', plannerInstanceId: 'planner', units: {}, sets: [], objects: [], surfaces: [], baseboards: [], counts: { sets: 0, objects: 0 }, truncated: false, layoutJson: '{}' }));
  });

  it('lists every §7.9 reason code', () => {
    const codes = (v(`${P}#/$defs/reasonCode`).schema as any).enum as string[];
    for (const c of ['BAD_ARGS', 'UNKNOWN_ITEM', 'NO_TARGET', 'WALL_ONLY', 'OUTSIDE_ROOM', 'OVERLAP', 'WALL_COLLISION', 'OPENING_CONFLICT', 'HEIGHT_OUT_OF_RANGE',
      'LIMIT_REACHED', 'NO_ITEM', 'ITEM_LOCKED', 'NOT_IN_PLANNER', 'NOT_IN_ROOM', 'NOT_ANALOG', 'NO_FIT', 'CATALOG_OPTION_INVALID', 'NOT_SUPPORTED', 'PLANNER_BUSY',
      'RATE_LIMITED', 'TIMEOUT', 'INTERNAL', 'NO_WALL']) expect(codes).toContain(c);
  });
});

describe('M1 contracts: estimate API (§11.3 – §11.6)', () => {
  const REQ = `${E}#/$defs/request`;
  const RES = `${E}#/$defs/response`;
  const request = {
    lang: 'ru', rev: '9b1e44d2', truncated: false,
    sets: [{ setIds: ['AB12CD34'], qty: 1, config: MILU_CONFIG }],
    objects: [{ assetId: 'Chair_Dining02', name: 'Стул', qty: 1 }],
    surfaces: [{ kind: 'wall', areaM2: 6.21, finish: 'tile:Tile_Grey60' }],
    baseboards: [{ lengthM: 10.1, finish: '' }],
  };
  const response = {
    ok: true, currency: 'BYN', vatIncluded: true, catalogSyncedAt: '2026-09-30T14:49:19.875Z', source: 'https://oliveeka.by', lang: 'ru', rev: '9b1e44d2', truncated: false,
    sections: [
      {
        id: 'sanitary', title: 'Сантехника и мебель', subtotalBYN: 3230, lines: [
          { key: 'art:MIL80A+CMA80W', kind: 'article', articleCode: 'MIL80A+CMA80W', name: 'Тумба со столешницей Oliveeka Milu 80 …', component: 'cabinet', includes: ['cabinet', 'countertop'], setIds: ['AB12CD34'], qty: 1, unitPriceBYN: 2872, amountBYN: 2872, status: 'priced', approximate: false, url: 'https://oliveeka.by/mebel-dlya-vannoy/…', dimensionsMm: { width: 800, depth: 460, height: 500 } },
          { key: 'part:mirror:Зеркало 79 × 57 см', kind: 'part', component: 'mirror', name: 'Зеркало 79 × 57 см', setIds: ['AB12CD34'], qty: 1, unitPriceBYN: null, amountBYN: 0, status: 'unpriced' },
          { key: 'obj:Chair_Dining02', kind: 'object', assetId: 'Chair_Dining02', name: 'Стул', qty: 1, unitPriceBYN: null, amountBYN: 0, status: 'unpriced' },
        ],
      },
      {
        id: 'finishing', title: 'Отделочные материалы', subtotalBYN: 0, lines: [
          { key: 'fin:tile:Tile_Grey60:wall', kind: 'finish', finish: 'tile:Tile_Grey60', surface: 'wall', label: 'Плитка «Серый керамогранит 60×60»', unit: 'm2', quantity: 6.21, unitPriceBYN: null, amountBYN: 0, status: 'unpriced' },
          { key: 'info:unfinished', kind: 'info', label: 'Без отделки: 15 м²', unit: 'm2', quantity: 15, unitPriceBYN: null, amountBYN: 0, status: 'info' },
        ],
      },
    ],
    totalBYN: 3230, pricedCount: 2, estimatedCount: 0, unpricedCount: 2,
    partner: { name: 'oliveeka.by', url: 'https://oliveeka.by/', items: [{ articleCode: 'MIL80A+CMA80W', name: '…', qty: 1, priceBYN: 2872, approximate: false, url: 'https://oliveeka.by/…' }] },
  };

  it('accepts the §11.3 request and response and the §11.5 basket', () => {
    ok(REQ, request);
    ok(REQ, {}); // empty room
    ok(RES, response);
    for (const e of ['BAD_REQUEST', 'TOO_LARGE', 'RATE_LIMITED', 'CATALOG_UNAVAILABLE']) ok(RES, { ok: false, error: e });
    ok(RES, { ok: false, error: 'BAD_REQUEST', field: 'sets[0].qty' });
    ok(`${E}#/$defs/basket`, {
      format: 'maximall.basket.v1', partner: 'oliveeka.by', createdAt: '2026-10-08T15:00:00.000Z', currency: 'BYN', vatIncluded: true,
      items: [{ articleCode: 'MIL80A+CMA80W', name: '…', qty: 1, priceBYN: 2872, approximate: false, url: 'https://oliveeka.by/…' }], totalBYN: 2872, unpricedCount: 2,
    });
    ok(`${E}#/$defs/line`, { key: 'art:URB80M', kind: 'article', articleCode: 'URB80M', name: 'Тумба Urban 80', qty: 1, unitPriceBYN: 1297, amountBYN: 1297, status: 'estimated', approximate: true, url: 'https://oliveeka.by/x/' });
  });

  it('enforces the request limits', () => {
    bad(REQ, { ...request, lang: 'de' });
    bad(REQ, { ...request, rev: 'x'.repeat(17) });
    bad(REQ, { ...request, sets: Array.from({ length: 31 }, () => ({ qty: 1, config: MILU_CONFIG })) });
    bad(REQ, { ...request, sets: [{ qty: 0, config: MILU_CONFIG }] });
    bad(REQ, { ...request, sets: [{ qty: 101, config: MILU_CONFIG }] });
    bad(REQ, { ...request, sets: [{ qty: 1, config: { ...MILU_CONFIG, sizeIndex: 100 } }] });
    bad(REQ, { ...request, sets: [{ qty: 1, config: { ...MILU_CONFIG, mirrorSizeIndex: -2 } }] });
    bad(REQ, { ...request, sets: [{ qty: 1, config: { ...MILU_CONFIG, sizeIndex: 1.5 } }] });
    bad(REQ, { ...request, sets: [{ qty: 1, setIds: ['x'.repeat(65)], config: MILU_CONFIG }] });
    bad(REQ, { ...request, objects: Array.from({ length: 201 }, () => ({ assetId: 'A', qty: 1 })) });
    bad(REQ, { ...request, objects: [{ assetId: 'A', name: 'x'.repeat(81), qty: 1 }] });
    bad(REQ, { ...request, surfaces: [{ kind: 'roof', areaM2: 1 }] });
    bad(REQ, { ...request, surfaces: [{ kind: 'wall', areaM2: 10001 }] });
    bad(REQ, { ...request, surfaces: [{ kind: 'wall', areaM2: -1 }] });
    bad(REQ, { ...request, surfaces: [{ kind: 'wall', areaM2: 1, finish: 'x'.repeat(41) }] });
    bad(REQ, { ...request, baseboards: Array.from({ length: 51 }, () => ({ lengthM: 1 })) });
    bad(REQ, { ...request, layoutJson: '{}' });
  });

  it('keeps internal catalog fields and foreign links out of responses', () => {
    const line = response.sections[0].lines[0];
    for (const k of ['note', 'estimatedFrom', 'unmapped', 'match', 'image']) bad(`${E}#/$defs/line`, { ...line, [k]: 'x' });
    for (const url of ['http://oliveeka.by/x/', 'https://oliveeka.com/product/MIL80A', 'javascript://oliveeka.by/%0aalert(1)', 'https://evil.example/']) {
      bad(`${E}#/$defs/line`, { ...line, url });
      bad(`${E}#/$defs/partnerItem`, { ...response.partner.items[0], url });
    }
    bad(RES, { ...response, vatIncluded: false });
    bad(RES, { ...response, currency: 'RUB' });
    bad(`${E}#/$defs/line`, { ...line, status: 'free' });
  });
});
