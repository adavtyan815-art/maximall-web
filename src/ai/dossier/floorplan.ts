/**
 * SVG floor plan from the planner layout JSON (ARoomPlannerManager::ExportLayoutToJSON, version 3):
 * nodes[{id,x,y}] (cm), walls[{id,start,end,thickness,openings[{type,dist,width}]}], cabinetSets[{id,product,x,y,yaw}].
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Set size along the wall (w) and depth (d) in cm; with a UE placement the rectangle is the real footprint on the wall. */
export interface SetFootprint {
  w: number;
  d: number;
  label?: string;
  /** get_state resolvedPlacement: wall segmentId, offsetCm = footprint centre from the wall start along the centreline. */
  placement?: { segmentId: number; offsetCm: number; side?: string };
}

export function floorPlanSvg(layout: any, opts: { widthPx?: number; setSizes?: Record<string, SetFootprint> } = {}): string {
  const nodes = new Map<number, { x: number; y: number }>((layout?.nodes ?? []).map((n: any) => [Number(n.id), { x: Number(n.x), y: Number(n.y) }]));
  const walls: any[] = layout?.walls ?? [];
  if (!nodes.size || !walls.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text x="10" y="45" font-size="14">План помещения недоступен</text></svg>';
  const xs = [...nodes.values()].map((n) => n.x);
  const ys = [...nodes.values()].map((n) => n.y);
  const pad = 60;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
  const W = opts.widthPx ?? 640;
  const H = Math.round((W * h) / w);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${W}" height="${H}" font-family="Arial, sans-serif">`];
  out.push(`<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#fbfaf7"/>`);
  for (const wall of walls) {
    const a = nodes.get(Number(wall.start));
    const b = nodes.get(Number(wall.end));
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = Number(wall.thickness ?? 10);
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#2b2b2b" stroke-width="${t}" stroke-linecap="square"/>`);
    const ux = (b.x - a.x) / (len || 1);
    const uy = (b.y - a.y) / (len || 1);
    for (const op of wall.openings ?? []) {
      const ow = Number(op.width ?? 80);
      // Layout JSON `dist` = distance from the start node to the opening CENTRE (UE FWallOpening; QA-022, CR-UE-01).
      const d0 = Number(op.dist ?? ow / 2) - ow / 2;
      const p0 = { x: a.x + ux * d0, y: a.y + uy * d0 };
      const p1 = { x: a.x + ux * (d0 + ow), y: a.y + uy * (d0 + ow) };
      const col = op.type === 'window' ? '#8ec5e8' : '#fbfaf7';
      out.push(`<line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" stroke="${col}" stroke-width="${t + 2}"/>`);
      if (op.type === 'door') {
        // swing arc (inside the room, perpendicular to the wall)
        const nx = -uy;
        const ny = ux;
        out.push(`<path d="M ${p0.x} ${p0.y} L ${p0.x + nx * ow} ${p0.y + ny * ow} A ${ow} ${ow} 0 0 0 ${p1.x} ${p1.y}" fill="none" stroke="#9a8f80" stroke-width="2" stroke-dasharray="6 4"/>`);
      }
    }
    // dimension label
    const mx = (a.x + b.x) / 2 + uy * 34; // outside the room (walls run clockwise in screen space)
    const my = (a.y + b.y) / 2 - ux * 34;
    out.push(`<text x="${mx}" y="${my}" font-size="${Math.max(12, w / 45)}" text-anchor="middle" fill="#555">${Math.round(Math.max(0, len - t))} см</text>`); // clear inner-face length (QA-023)
  }
  const fontSet = Math.max(11, w / 55);
  const drawn = new Set<string>();
  // QA-038: a set with a UE placement is drawn as its real footprint against the wall face (not around the actor pivot).
  for (const [id, size] of Object.entries(opts.setSizes ?? {})) {
    const pl = size.placement;
    if (!pl) continue;
    const wall = walls.find((x) => Number(x.id) === pl.segmentId);
    const a = wall && nodes.get(Number(wall.start));
    const b = wall && nodes.get(Number(wall.end));
    if (!wall || !a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const sgn = pl.side === 'right' ? -1 : 1; // left face = the room side for walls drawn clockwise on screen
    const nx = -uy * sgn;
    const ny = ux * sgn;
    const t = Number(wall.thickness ?? 10);
    const c0 = { x: a.x + ux * pl.offsetCm + nx * (t / 2), y: a.y + uy * pl.offsetCm + ny * (t / 2) };
    const hw = size.w / 2;
    const pts = [
      [c0.x - ux * hw, c0.y - uy * hw],
      [c0.x + ux * hw, c0.y + uy * hw],
      [c0.x + ux * hw + nx * size.d, c0.y + uy * hw + ny * size.d],
      [c0.x - ux * hw + nx * size.d, c0.y - uy * hw + ny * size.d],
    ].map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`);
    const cx = c0.x + (nx * size.d) / 2;
    const cy = c0.y + (ny * size.d) / 2 + 5;
    out.push(`<polygon points="${pts.join(' ')}" fill="#c9a77c" stroke="#6b4f2f" stroke-width="2"/><text x="${cx}" y="${cy}" font-size="${fontSet}" text-anchor="middle" fill="#2b2b2b">${esc(size.label ?? '')}</text>`);
    drawn.add(id);
  }
  // QA-038: sets without a known footprint are not drawn (never at the actor pivot); they stay in the specification.
  out.push('</svg>');
  return out.join('');
}
