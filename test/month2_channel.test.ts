import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * MONTH2_SPEC m2.2 §7 / M3: the MaxiMallPlacement channel as the UE client really speaks it. The UE events below are copied verbatim
 * from the M3 real run (local dedicated server + client, D:\AI_Consultant_Workspace\month2\evidence\M3\realrun\clientA.log, "[M2] page
 * event …") and from the UE channel tests (malformed id / unknown cmd echoes); the page requests are the shapes the M3 drag bridge sends.
 */

const dir = path.join(__dirname, '..', 'contracts');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const P = 'maximall/ai/placement.schema.json';
const ok = (ref: string, data: unknown) => {
  const fn = ajv.getSchema(ref);
  if (!fn) throw new Error('no schema ' + ref);
  if (!fn(data)) throw new Error(`${ref} rejected ${JSON.stringify(data).slice(0, 300)}: ${JSON.stringify(fn.errors?.slice(0, 3))}`);
};
const bad = (ref: string, data: unknown) => expect(ajv.getSchema(ref)!(data), JSON.stringify(data).slice(0, 200)).toBe(false);

/** Real UE → page strings of the M3 run (without the "MaxiMallAI:" prefix). */
const UE_EVENTS = [
  '{"type":"event","event":"placement_preview_state","data":{"dragId":"d-1","seq":3,"valid":true,"kind":"object","itemId":"Table_Side01","target":"floor","category":"Other","heightCm":0,"snapped":[]}}',
  '{"type":"event","event":"placement_preview_state","data":{"dragId":"d-2","seq":0,"valid":true,"kind":"set","itemId":"Urban","target":"wall","category":"SinkVanity","heightCm":90,"snapped":[]}}',
  '{"type":"event","event":"placement_preview_state","data":{"dragId":"d-3","seq":0,"valid":false,"reasonCode":"NO_TARGET","detail":"NO_HIT","kind":"object","itemId":"Table_Side01","target":"none","category":"Other","snapped":[]}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-1","cmd":"m2_hello","ok":true,"reasonCode":"","reason":"","result":{"contract":"m2.2","features":["placement"],"inPlanner":true,"view":"2D"},"stateRev":-1,"elapsedMs":0}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-2","cmd":"placement_commit","ok":true,"reasonCode":"","reason":"","result":{"instanceId":"BQULIUDfCBhz5_innV5d-g","kind":"object","itemId":"Table_Side01","target":"floor","heightCm":0,"location":{"x":-10049.5,"y":-40.400000000000006,"z":0},"yawDeg":0,"snapped":[]},"stateRev":-1,"elapsedMs":43}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-3","cmd":"placement_commit","ok":false,"reasonCode":"OVERLAP","reason":"Место занято другим предметом","reasonParams":{"detail":"PENETRATION","otherId":"BQULIUDfCBhz5_innV5d-g","depthCm":44.800000000000004},"result":{},"stateRev":-1,"elapsedMs":0}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-4","cmd":"placement_commit","ok":false,"reasonCode":"NO_TARGET","reason":"Наведите на пол или стену комнаты","reasonParams":{"detail":"OVER_UI"},"result":{},"stateRev":-1,"elapsedMs":0}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-5","cmd":"object_transform","ok":true,"reasonCode":"","reason":"","result":{"instanceId":"BQULIUDfCBhz5_innV5d-g","location":{"x":-10020,"y":-40,"z":0},"yawDeg":0,"heightCm":0},"stateRev":-1,"elapsedMs":31}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-6","cmd":"placement_commit","ok":true,"reasonCode":"","reason":"","result":{"instanceId":"CEH9OUEcSs6uezuFhkSKnA","kind":"set","itemId":"Urban","target":"wall","segmentId":3,"side":"left","heightCm":90,"location":{"x":-9999.4000000000015,"y":124.90000000000001,"z":90},"yawDeg":180,"snapped":[]},"stateRev":3,"elapsedMs":32}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-7","cmd":"placement_commit","ok":false,"reasonCode":"NOT_SUPPORTED","reason":"Это действие недоступно для этого предмета","reasonParams":{"detail":"TILE_IS_FINISH","field":"kind"},"result":{},"stateRev":-1,"elapsedMs":0}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-9","cmd":"placement_commit","ok":false,"reasonCode":"NO_TARGET","reason":"Наведите на пол или стену комнаты","reasonParams":{"detail":"NO_HIT"},"result":{},"stateRev":-1,"elapsedMs":0}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-10","cmd":"object_delete","ok":true,"reasonCode":"","reason":"","result":{"instanceId":"CEH9OUEcSs6uezuFhkSKnA"},"stateRev":-1,"elapsedMs":42}}',
  '{"type":"event","event":"placement_result","data":{"id":"p-1790000000000-11","cmd":"placement_commit","ok":false,"reasonCode":"NOT_IN_PLANNER","reason":"Откройте «Конструктор»","reasonParams":{"detail":"PLANNER_CLOSED"},"result":{},"stateRev":-1,"elapsedMs":0}}',
];

describe('M3: UE → page placement events (real run)', () => {
  it('every event UE sent validates; none carries state_rev', () => {
    for (const s of UE_EVENTS) {
      const e = JSON.parse(s);
      ok(`${P}#/$defs/event`, e);
      expect(s.includes('state_rev'), s.slice(0, 80)).toBe(false);
      ok('maximall/ai/envelope.schema.json#/$defs/event', e); // the envelope's event enum lists them
    }
  });

  it('ok results carry the command result shape (§7.3)', () => {
    const byCmd: Record<string, string> = { m2_hello: 'result_m2_hello', placement_commit: 'result_placement_commit', object_transform: 'result_object_transform', object_delete: 'result_object_delete' };
    for (const s of UE_EVENTS) {
      const d = JSON.parse(s).data;
      if (d.ok !== true || !byCmd[d.cmd]) continue;
      ok(`${P}#/$defs/${byCmd[d.cmd]}`, d.result);
    }
  });

  it('a model op carries the AI revision; ui ops and client refusals -1', () => {
    const results = UE_EVENTS.map((s) => JSON.parse(s)).filter((e) => e.event === 'placement_result').map((e) => e.data);
    expect(results.find((d) => d.id === 'p-1790000000000-6').stateRev).toBe(3);
    for (const d of results.filter((d) => d.id !== 'p-1790000000000-6')) expect(d.stateRev).toBe(-1);
  });

  it('malformed ids and unknown commands are echoed (BAD_ARGS), so the sender can match them', () => {
    const E = `${P}#/$defs/event`;
    ok(E, { type: 'event', event: 'placement_result', data: { id: 'abc', cmd: 'placement_commit', ok: false, reasonCode: 'BAD_ARGS', reason: 'Некорректная команда', reasonParams: { detail: 'BAD_ID', field: 'id', maxLength: 40 }, result: {}, stateRev: -1, elapsedMs: 0 } });
    ok(E, { type: 'event', event: 'placement_result', data: { id: 'p-9-1', cmd: 'teleport', ok: false, reasonCode: 'BAD_ARGS', reason: 'Некорректная команда', reasonParams: { detail: 'UNKNOWN_CMD', field: 'cmd' }, result: {}, stateRev: -1, elapsedMs: 0 } });
    bad(E, { type: 'event', event: 'placement_result', data: { id: 'x'.repeat(41), cmd: 'placement_commit', ok: false, reasonCode: 'BAD_ARGS', result: {}, stateRev: -1 } });
    bad(E, { type: 'event', event: 'placement_result', data: { id: '', cmd: 'placement_commit', ok: false, reasonCode: 'BAD_ARGS', result: {}, stateRev: -1 } });
  });
});

describe('M3: page → UE requests (drag bridge, AI path)', () => {
  const R = `${P}#/$defs/request`;
  const MILU = { productId: 'Milu', sizeIndex: 0, colourIndex: 0, countertopSizeIndex: 0, countertopColourIndex: 0, closetSizeIndex: -1, closetColourIndex: 0, sinkSizeIndex: 0, sinkColourIndex: 0, faucetSizeIndex: 0, faucetColourIndex: 0, mirrorSizeIndex: 3, mirrorColourIndex: 0 };
  it('the drag bridge shapes validate', () => {
    ok(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_preview', args: { dragId: 'd-1791487781798-1', kind: 'set', itemId: 'Milu', x: 0.5, y: 0.5556, snapEnabled: true, sku: 'MIL80A+CMA80W', seq: 0 } });
    ok(R, { type: 'MaxiMallPlacement', v: 1, cmd: 'placement_cancel', args: { dragId: 'd-1791487781798-1' } });
    ok(R, { type: 'MaxiMallPlacement', v: 1, id: 'p-1791487781798-2', cmd: 'placement_commit', origin: 'ui', args: { dragId: 'd-1791487781798-1', kind: 'set', itemId: 'Milu', x: 0.525, y: 0.5926, snapEnabled: true, sku: 'MIL80A+CMA80W', config: MILU } });
    ok(R, { type: 'MaxiMallPlacement', v: 1, id: 'p-1791487781798-3', cmd: 'm2_hello', origin: 'ui', args: {} });
  });
  it('the AI path (UeBridge.forward → origin model) validates; an AI envelope id is not a placement id', () => {
    ok(R, { type: 'MaxiMallPlacement', v: 1, id: 'p-1791487781798-4', cmd: 'placement_commit', origin: 'model', args: { kind: 'set', itemId: 'Milu', x: 0.5, y: 0.5, config: MILU } });
    ok(R, { type: 'MaxiMallPlacement', v: 1, id: 'p-1791487781798-5', cmd: 'object_transform', origin: 'model', args: { instanceId: 'AB12CD34', location: { x: -10020, y: -40, z: 0 } } });
    bad(R, { type: 'MaxiMallPlacement', v: 1, id: 'r-1790000000000-9', cmd: 'placement_commit', origin: 'model', args: { kind: 'set', itemId: 'Milu', x: 0.5, y: 0.5 } });
  });
  it('a tile is not a placement (UE answers NOT_SUPPORTED / TILE_IS_FINISH)', () => {
    bad(R, { type: 'MaxiMallPlacement', v: 1, id: 'p-1-1', cmd: 'placement_commit', args: { kind: 'tile', itemId: 'Tile_Grey60', x: 0.5, y: 0.5 } });
  });
});
