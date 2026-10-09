/**
 * Render prompt style guide (task 6), revised after the TA look-dev review (TA_CONSULTANT_AND_CAPTURE.md §6, 2026-09-30 20:00):
 * - most planner rooms have no window: daylight-from-a-window wording only when the layout has a window;
 * - mirrors reflect the original room and are pasted back with the product (mask), so the prompt never asks to change them;
 * - avoid duplicated basins/mirrors and objects on the countertop;
 * - rig lens: 65–75° FOV (≈ 24 mm); the "wide" preset is shot low (105 cm) -> "low wide-angle view";
 * - frames are bright/neutral with warm 3000–3500 K room light: keep strong lighting changes mild (denoise stays low).
 * The model prompt is English (image models follow English best); the Russian text is what the consultant/UI says.
 * The product pixels (incl. the mirror and its reflection) are pasted back from the original frame after generation.
 */
export type RenderStyle = 'modern' | 'classic' | 'scandi' | 'loft';

export interface StyleGuide {
  ru: { name: string; description: string };
  en: string; // style-specific scene description
  light: string; // lighting wording for a room without a window (most planner rooms)
  lightWindow: string; // lighting wording when the layout has a window
  avoid: string[]; // style-specific things we do not want
}

/**
 * Artur's proven render instruction (2026-10-09), lightly edited (spelling; "furnish in minimal" as minimal styling, since adding
 * furniture would contradict the rest). It leads every prompt: the preview model (FLUX.2 klein edit) follows instructions, and
 * the preview is usually what the visitor gets.
 */
export const BASE_INSTRUCTION =
  'Render this scene with increased realism, achieving a natural daylight photography aesthetic. Maintain the existing composition, camera viewpoint, dimensions and furniture layout exactly as they are: do not add, remove, move or modify any furniture items, and do not change the colour of the furniture. Enhance the scene with realistic natural lighting, soft shadows and improved textures to create an authentic photographic look. Keep the styling minimal: clean surfaces, little decor, no clutter.';

export const PRESERVE =
  'Keep the bathroom furniture exactly as in the input image: same vanity cabinet, countertop, basin, faucet, mirror and wall cabinet, same shape, size, proportions, position, materials and colours. Do not add, remove, move or restyle any furniture. Leave the mirror and what it reflects unchanged. Keep the room geometry, walls, door and window positions and the camera viewpoint unchanged.';

/** Always appended (TA review §6.6): the paste-back hides the product, but models still draw duplicates next to it. */
export const COMMON_AVOID = ['people', 'text', 'watermark', 'logos', 'distorted furniture', 'extra mirrors', 'extra basins', 'duplicated sinks', 'objects on the countertop covering the basin', 'new windows'];

export const STYLES: Record<RenderStyle, StyleGuide> = {
  modern: {
    ru: { name: 'Современный', description: 'чистые линии, нейтральные цвета, мягкий рассеянный свет' },
    en: 'modern minimalist bathroom, clean lines, neutral palette, matte surfaces, large-format tiles, subtle chrome accents',
    light: 'soft diffuse ceiling light, evenly lit room, bright ceiling, natural soft shadows',
    lightWindow: 'soft diffuse daylight from the window, gentle indirect ceiling light, bright ceiling, natural soft shadows',
    avoid: ['decorative clutter', 'plants everywhere'],
  },
  classic: {
    ru: { name: 'Классический', description: 'тёплые тона, дерево, уютный тёплый свет' },
    en: 'warm classic bathroom interior, natural wood tones, soft beige and cream walls, elegant and calm',
    light: 'warm ceiling light around 3000K, soft warm reflections, gentle shadows',
    lightWindow: 'warm light from the window mixed with 3000K ceiling light, soft warm reflections',
    avoid: ['ornate gold', 'marble columns'],
  },
  scandi: {
    ru: { name: 'Скандинавский', description: 'светлый, воздушный, много света' },
    en: 'bright Scandinavian bathroom, white and light grey walls, light oak accents, airy and fresh, a folded white towel',
    light: 'bright even ceiling light, high-key exposure, bright ceiling, very soft shadows',
    lightWindow: 'bright overcast daylight from the window, high-key exposure, bright ceiling, very soft shadows',
    avoid: ['dark walls', 'heavy decor'],
  },
  loft: {
    ru: { name: 'Лофт', description: 'бетон, графит, выразительный свет' },
    en: 'industrial loft bathroom, concrete-look walls, graphite tones, black metal details',
    light: 'warm directional ceiling light with soft-edged shadows, mild contrast',
    lightWindow: 'directional daylight from the window with soft-edged shadows, mild contrast',
    avoid: ['exposed pipes over the furniture', 'brick on the furniture'],
  },
};

/** Maps the visitor's style preference (propose_sets styles) or the finishes to a render style. */
export function styleFromPreference(pref?: string, finishes?: any): RenderStyle {
  const f = JSON.stringify(finishes ?? {});
  if (pref === 'light' || pref === 'white' || /RAL 9010|Tile_White/i.test(f)) return 'scandi';
  if (pref === 'wood' || pref === 'warm' || /RAL 1013|Tile_Beige|Tile_Sand/i.test(f)) return 'classic';
  if (pref === 'dark' || /RAL 7016|Tile_Grey/i.test(f)) return 'loft';
  return 'modern';
}

export function renderPrompt(meta: { style?: string; finishes?: any; preset?: string; hasWindow?: boolean }): string {
  const known = ['modern', 'classic', 'scandi', 'loft'] as const;
  const style: RenderStyle = (known as readonly string[]).includes(meta.style ?? '') ? (meta.style as RenderStyle) : styleFromPreference(undefined, meta.finishes);
  const g = STYLES[style];
  const view = meta.preset === 'wide' ? 'low wide-angle view' : meta.preset === 'frontal' ? 'eye-level frontal view, 24mm lens' : 'eye-level corner view, 24mm lens';
  return [
    BASE_INSTRUCTION,
    // the visitor's style only accents decor and mood; the furniture and its colours stay as captured
    `The room is a small bathroom. Style accents for decor and mood only, never for the furniture: ${g.en}.`,
    `${meta.hasWindow ? g.lightWindow : g.light}.`,
    `Photographic details: ${view}, realistic materials, global illumination and reflections, high detail.`,
    PRESERVE,
    `Avoid: ${[...COMMON_AVOID, ...g.avoid].join(', ')}.`,
  ].join(' ');
}
