import sharp from 'sharp';

export const W = 64;
export const H = 48;
/** Synthetic capture: product rectangle x 20..43, y 10..37 at 200 cm; room at 400 cm; an occluder (towel) at 150 cm
 * covers x 20..25 of the product in the beauty/depth pass while the ShowOnlyActors pass still sees the product there. */
export async function syntheticCapture() {
  const beauty = Buffer.alloc(W * H * 3);
  const depth = new Uint16Array(W * H);
  const mask = Buffer.alloc(W * H);
  const maskDepth = new Uint16Array(W * H).fill(65535);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inProduct = x >= 20 && x <= 43 && y >= 10 && y <= 37;
      const occluded = inProduct && x <= 25;
      depth[i] = occluded ? 150 : inProduct ? 200 : 400;
      if (inProduct) {
        mask[i] = 255;
        maskDepth[i] = 200;
      }
      beauty[i * 3] = (x * 4 + y) & 255;
      beauty[i * 3 + 1] = inProduct ? 120 + (x & 7) : 60 + y;
      beauty[i * 3 + 2] = (x * y) & 255;
    }
  const png8 = (b: Buffer, ch: 1 | 3) => sharp(b, { raw: { width: W, height: H, channels: ch } }).png().toBuffer();
  const png16 = (d: Uint16Array) => sharp(d, { raw: { width: W, height: H, channels: 1 } }).toColourspace('grey16').png().toBuffer();
  return { beauty: await png8(beauty, 3), depth: await png16(depth), mask: await png8(mask, 1), maskDepth: await png16(maskDepth), raw: { beauty, depth } };
}
