import sharp from 'sharp';

/** Decoded capture of one render (render-api.schema.json). */
export interface CaptureRaw {
  width: number;
  height: number;
  beauty: Buffer; // RGB 8-bit, width*height*3
  depth: Uint16Array; // cm, 65535 = far
  mask: Uint8Array; // 0..255
  maskDepth?: Uint16Array; // depth of the ShowOnlyActors pass (optional)
}

async function rgb8(png: Buffer, w?: number, h?: number) {
  let img = sharp(png).removeAlpha().toColourspace('srgb');
  if (w && h) img = img.resize(w, h, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

async function grey16(png: Buffer): Promise<{ data: Uint16Array; width: number; height: number }> {
  const meta = await sharp(png).metadata();
  if (meta.depth === 'ushort') {
    // 16-bit grey: decode in grey16 so libvips does not rescale to 8 bits (1 unit = 1 cm).
    const { data, info } = await sharp(png).toColourspace('grey16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 1) throw new Error(`depth: expected 1 channel, got ${info.channels}`);
    return { data: new Uint16Array(data.buffer, data.byteOffset, info.width * info.height).slice(), width: info.width, height: info.height };
  }
  // 8-bit input (contract says 16-bit): keep the values as they are rather than rescaling them.
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { data: Uint16Array.from(data), width: info.width, height: info.height };
}

async function grey8(png: Buffer) {
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length).slice(), width: info.width, height: info.height };
}

export async function decodeCapture(parts: { beauty: Buffer; depth: Buffer; mask: Buffer; maskDepth?: Buffer }): Promise<CaptureRaw> {
  const b = await rgb8(parts.beauty);
  const d = await grey16(parts.depth);
  const m = await grey8(parts.mask);
  const md = parts.maskDepth ? await grey16(parts.maskDepth) : undefined;
  for (const [name, x] of [['depth', d], ['mask', m], ['maskDepth', md]] as const) {
    if (x && (x.width !== b.width || x.height !== b.height)) throw new Error(`${name} is ${x.width}x${x.height}, beauty is ${b.width}x${b.height}`);
  }
  return { width: b.width, height: b.height, beauty: b.data, depth: d.data, mask: m.data, maskDepth: md?.data };
}

/**
 * Final product mask (render-api.schema.json): mask > 127 AND |depth − maskDepth| < 3 cm. Without maskDepth, mask > 127
 * alone (the ShowOnlyActors mask is then trusted as is). The depth test removes pixels where something in the room
 * occludes the product in the beauty pass.
 */
export function productMask(c: CaptureRaw, toleranceCm = 3): Uint8Array {
  const n = c.width * c.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (c.mask[i] <= 127) continue;
    if (c.maskDepth && Math.abs(c.depth[i] - c.maskDepth[i]) >= toleranceCm) continue;
    out[i] = 255;
  }
  return out;
}

/** Composites the ORIGINAL beauty pixels back into a generated image (resized to the capture size). PNG, lossless. */
export async function compositeProduct(c: CaptureRaw, generatedPng: Buffer, finalMask: Uint8Array): Promise<Buffer> {
  const g = await rgb8(generatedPng, c.width, c.height);
  const out = Buffer.from(g.data);
  const n = c.width * c.height;
  for (let i = 0; i < n; i++) {
    if (finalMask[i]) {
      out[i * 3] = c.beauty[i * 3];
      out[i * 3 + 1] = c.beauty[i * 3 + 1];
      out[i * 3 + 2] = c.beauty[i * 3 + 2];
    }
  }
  return sharp(out, { raw: { width: c.width, height: c.height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
}

/** 8-bit PNGs for the image model: depth normalised (near = white) for the ControlNet, edit mask = NOT product. */
export async function modelInputs(c: CaptureRaw, finalMask: Uint8Array) {
  const n = c.width * c.height;
  let min = 65535;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = c.depth[i];
    if (v >= 65535) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1, max - min);
  const d8 = Buffer.alloc(n);
  const edit = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = c.depth[i];
    d8[i] = v >= 65535 ? 0 : Math.round(255 - ((v - min) / span) * 255);
    edit[i] = finalMask[i] ? 0 : 255; // white = may be edited (walls, floor, light); black = keep (product)
  }
  const raw = (b: Buffer) => sharp(b, { raw: { width: c.width, height: c.height, channels: 1 } }).png().toBuffer();
  const beautyPng = await sharp(c.beauty, { raw: { width: c.width, height: c.height, channels: 3 } }).png().toBuffer();
  return { beautyPng, depthPng: await raw(d8), editMaskPng: await raw(edit) };
}
