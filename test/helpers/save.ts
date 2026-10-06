import type { CatalogIndex } from '../../src/ai/catalog/index';
import { fullConfig } from '../../src/ai/catalog/index';

/** A 250 × 200 cm room (ExportLayoutToJSON v3 shape) with a door and one planner set, plus a salon booth that must NOT
 * appear in the specification. */
export function demoSave(catalog: CatalogIndex, opts: { withMetrics?: boolean } = {}) {
  const cfg = fullConfig({ productId: 'Milu', sizeIndex: 0, colourIndex: 0, ...catalog.defaultsFor('Milu', 0, { topIndex: 0 })!, closetSizeIndex: 0, closetColourIndex: 0 });
  const layout = {
    version: 3,
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 250, y: 0 },
      { id: 2, x: 250, y: 200 },
      { id: 3, x: 0, y: 200 },
    ],
    walls: [
      { id: 0, start: 0, end: 1, thickness: 10, height: 260, finish: { type: 'paint', system: 'RAL', code: 'RAL 9010' }, openings: [{ id: 'o1', type: 'door', dist: 30, width: 80, height: 205 }] },
      { id: 1, start: 1, end: 2, thickness: 10, height: 260, finish: { type: 'paint', system: 'RAL', code: 'RAL 9010' }, openings: [] },
      { id: 2, start: 2, end: 3, thickness: 10, height: 260, openings: [] },
      { id: 3, start: 3, end: 0, thickness: 10, height: 260, openings: [] },
    ],
    rooms: [{ id: 0 }],
    cabinetSets: [{ id: 'set-1', product: 'Milu', x: 125, y: 175, z: 0, yaw: 0 }],
  };
  const plannerState = {
    productID: 'Milu',
    activeSizeIndex: cfg.sizeIndex,
    activeColorIndex: cfg.colourIndex,
    countertopSizeIndex: cfg.countertopSizeIndex,
    activeCountertopColorIndex: cfg.countertopColourIndex,
    closetSizeIndex: cfg.closetSizeIndex,
    closetColorIndex: cfg.closetColourIndex,
    sinkSizeIndex: 0,
    sinkColorIndex: 0,
    faucetSizeIndex: 0,
    faucetColorIndex: 0,
    mirrorSizeIndex: cfg.mirrorSizeIndex,
    mirrorColorIndex: 0,
  };
  return {
    config: cfg,
    save: {
      saveId: 'save-demo-1',
      saveName: 'Ванная Анны',
      date: '2026-09-30',
      planner: layout,
      boothStates: [
        { boothName: 'set-1', plannerInstanceId: 'planner-7', state: plannerState, customColors: [] },
        { boothName: 'SalonBooth_Urban', state: { ...plannerState, productID: 'Urban' } }, // salon booth: excluded
      ],
      ...(opts.withMetrics
        ? { metrics: { plannerInstanceId: 'planner-7', perimeterM: 9, floorAreaM2: 5, wallFaces: [{ segmentId: 0, side: 'left', areaM2: 4.8, finish: 'RAL 9010' }], sets: [{ setId: 'set-1', config: cfg }], layoutJson: JSON.stringify(layout) } }
        : {}),
    },
  };
}
