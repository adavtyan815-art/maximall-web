import fs from 'fs';
import path from 'path';
import type { Lang } from './index';

/**
 * Contracts v2.5: English display names of the catalogue (data/catalog/names_en.json). The catalogue index keeps its
 * Russian names; Russian output never goes through this file (ru returns the input unchanged).
 */
export const NAMES_EN_FILE = process.env.AI_NAMES_EN_FILE ?? path.join(__dirname, '..', '..', '..', 'data', 'catalog', 'names_en.json');

interface ColourEntry {
  id: string;
  en: string;
  aliases?: string[];
}
interface NamesFile {
  colours: Record<string, ColourEntry>;
  tiles: Record<string, string>;
  articlePhrases: [string, string][];
}

const key = (s?: string) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[_\s]+/g, ' ').trim();

let data: { colours: Map<string, ColourEntry>; tiles: Record<string, string>; phrases: [RegExp, string][] } | null = null;
function load() {
  if (data) return data;
  let raw: NamesFile = { colours: {}, tiles: {}, articlePhrases: [] };
  try {
    raw = JSON.parse(fs.readFileSync(NAMES_EN_FILE, 'utf8'));
  } catch {
    /* no translation file: English falls back to ids / Latin names */
  }
  const colours = new Map<string, ColourEntry>();
  for (const [ru, e] of Object.entries(raw.colours ?? {})) colours.set(key(ru), e);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/g, '[её]');
  const phrases = (raw.articlePhrases ?? []).map(([ru, en]) => [new RegExp(esc(ru).replace(/\s+/g, '\\s+'), 'i'), en] as [RegExp, string]);
  data = { colours, tiles: raw.tiles ?? {}, phrases };
  return data;
}

/** Russian colour name (as in the catalogue) -> its entry (whole name, else null). */
function entryOf(ruName?: string): ColourEntry | undefined {
  return load().colours.get(key(ruName));
}

/** «Чёрный МДФ» -> «black MDF»; unknown words are translated one by one; undefined when nothing is known. */
export function colourEn(ruName?: string): string | undefined {
  if (!ruName) return undefined;
  const e = entryOf(ruName);
  if (e) return e.en;
  if (!/[А-Яа-яЁё]/.test(ruName)) return ruName.replace(/_/g, ' ').toLowerCase();
  const words = ruName.split(/\s+/).map((w) => entryOf(w)?.en ?? (/^[А-ЯЁ]{2,}$/.test(w) ? w : null));
  return words.every(Boolean) ? words.join(' ') : undefined;
}

/** Stable colour id for a catalogue colour name (the English id: «black_mdf», «walnut»). */
export function colourIdOf(ruName?: string): string | undefined {
  return entryOf(ruName)?.id;
}

/** Colour name inside a sentence in the session language (ru: the catalogue name with lcColour rules, unchanged). */
export function colourLabel(lang: Lang | undefined, ruName?: string): string {
  if (lang !== 'en') return lc(ruName);
  return colourEn(ruName) ?? lc(ruName);
}
function lc(name?: string): string {
  return (name ?? '')
    .split(' ')
    .map((w) => (/^[А-ЯЁA-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * Does the visitor's colour word (English name, English id, alias or raw catalogue id) name this catalogue colour?
 * Used for English sessions and for ids in both languages; Russian stems are matched by the callers as before.
 */
export function colourMatches(input: string | undefined, ruName: string | undefined, rawId?: string): boolean {
  const q = key(input);
  if (!q || !ruName) return false;
  if (rawId && key(rawId) === q) return true;
  const e = entryOf(ruName);
  if (!e) return false;
  return [e.id, e.en, ...(e.aliases ?? [])].some((x) => key(x) === q);
}

/** A loose English match: «black» also finds «black MDF» when nothing matches exactly (first word / prefix). */
export function colourMatchesLoose(input: string | undefined, ruName: string | undefined): boolean {
  const q = key(input).replace(/^(matte?|the)\s+/, '');
  const e = entryOf(ruName);
  if (!q || !e) return false;
  return [e.en, ...(e.aliases ?? [])].some((x) => key(x).startsWith(q) || q.startsWith(key(x)));
}

export function tileName(lang: Lang | undefined, id: string, ruName?: string): string {
  if (lang !== 'en') return ruName ?? id;
  return load().tiles[id] ?? (ruName && !/[А-Яа-яЁё]/.test(ruName) ? ruName : id);
}

/**
 * A shop article / model name in the session language. English: phrase table, colour words, units; when a Russian word
 * is left over, `fallback` (collection + size + colour, built by the caller) or the name without the Russian words.
 */
export function articleName(lang: Lang | undefined, ruName: string | undefined, fallback?: string): string {
  const s0 = ruName ?? '';
  if (lang !== 'en' || !/[А-Яа-яЁё]/.test(s0)) return s0;
  let s = s0;
  for (const [re, en] of load().phrases) s = s.replace(re, en);
  s = s
    .replace(/(\d)\s*[хx×]\s*(\d)/g, '$1×$2')
    .replace(/(\d)\s*мм(?![а-яё])/gi, '$1 mm')
    .replace(/(\d)\s*см(?![а-яё])/gi, '$1 cm')
    .replace(/[А-ЯЁа-яё]+(?:\s+[А-ЯЁа-яё]+)?/g, (w) => colourEn(w) ?? w.split(/\s+/).map((x) => colourEn(x) ?? x).join(' '))
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/[А-Яа-яЁё]/.test(s)) return fallback ?? s.replace(/[А-ЯЁа-яё]+/g, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Tests: reload after AI_NAMES_EN_FILE changes. */
export function _resetNames() {
  data = null;
}
