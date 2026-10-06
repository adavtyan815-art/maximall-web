/**
 * Post-recognition correction of Russian voice transcripts (Artur 2026-10-02, after the kiosk tests).
 *
 * ElevenLabs Scribe mishears the shop's own words on fast or noisy speech: collection names («Milo», «Urbanе»),
 * «рэнд/ранд» for «рендер», «ондату» for «комнату», «по турбон» for «под тумбу», «бумпостов» for «бюджет».
 * A small, deterministic dictionary fixes those and writes sizes as digits («четыреста на четыреста сантиметров» →
 * «400 на 400 сантиметров», «4Х4 м» → «4 на 4 м»), so the model, the intent rules and the chat all see the same text.
 *
 * Rules are conservative: each targets a non-word or an ungrammatical form seen in real transcripts; ordinary
 * words are never rewritten without context. Off switch: AI_STT_CORRECT=0. Applies to voice turns only.
 */

export interface SttCorrection {
  rule: string;
  from: string;
  to: string;
}

export interface CorrectedTranscript {
  text: string;
  raw: string;
  corrections: SttCorrection[];
}

const B = '(?<![\\p{L}\\d])'; // word start
const E = '(?![\\p{L}\\d])'; // word end
const COLLECTION = '(?:Milu|Urban|Avenu|Terra|Tuma)';
const UNIT = `(?:см|мм|м|сантиметр\\p{L}*|миллиметр\\p{L}*|метр\\p{L}*)${E}`;

type Rule = { id: string; re: RegExp; to: string | ((m: string, ...g: any[]) => string) };

/** Keep the capital letter of a sentence start when the replacement is a plain lower-case word. */
function keepCase(m: string, to: string): string {
  return m[0] && m[0] !== m[0].toLowerCase() && to[0] === to[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to;
}

const RULES: Rule[] = [
  // «С-с-сама», «с-с этим»: stuttered first letter
  { id: 'stutter', re: new RegExp(`${B}(\\p{L})(?:-\\1)+-?(\\p{L}*)${E}`, 'giu'), to: (_m, a: string, rest: string) => a + rest },

  // collection names (canonical Latin spelling, as on the site, the cards and the dossier)
  { id: 'collection', re: new RegExp(`${B}(?:milu|milo|милу)${E}`, 'giu'), to: 'Milu' },
  { id: 'collection', re: new RegExp(`${B}(?:urban|урбан)(?:[еeауы]|ом)?${E}`, 'giu'), to: 'Urban' },
  { id: 'collection', re: new RegExp(`${B}(?:avenue?|авеню)${E}`, 'giu'), to: 'Avenu' },
  { id: 'collection', re: new RegExp(`${B}(?:terra|terre|терр?(?:а|е|у|ы|ой))${E}`, 'giu'), to: 'Terra' },
  { id: 'collection', re: new RegExp(`${B}(?:tuma|тум(?:а|е|у|ы|ой))${E}`, 'giu'), to: 'Tuma' },

  // shop terms
  { id: 'term', re: new RegExp(`${B}(?:рэнд|ранд|рэндер|рандер|рендор|рендр|render)(?:а|у|ом|ы)?${E}`, 'giu'), to: (m) => keepCase(m, 'рендер') },
  { id: 'term', re: new RegExp(`${B}по\\s+турбон\\p{L}*${E}`, 'giu'), to: (m) => keepCase(m, 'под тумбу') },
  { id: 'term', re: new RegExp(`${B}турбон\\p{L}*${E}`, 'giu'), to: (m) => keepCase(m, 'тумбу') },
  { id: 'term', re: new RegExp(`${B}ондату${E}`, 'giu'), to: (m) => keepCase(m, 'комнату') },
  { id: 'term', re: new RegExp(`${B}бумпост\\p{L}*${E}`, 'giu'), to: (m) => keepCase(m, 'бюджет') },
  { id: 'term', re: new RegExp(`${B}стандарт(?=\\s+${COLLECTION}${E})`, 'giu'), to: (m) => keepCase(m, 'стенд') },

  // verbs: «Зделай», «Целый тумбу» (ungrammatical: masculine adjective + feminine accusative), «Постройка — комнату»
  { id: 'verb', re: new RegExp(`${B}зделай${E}`, 'giu'), to: (m) => keepCase(m, 'сделай') },
  { id: 'verb', re: new RegExp(`${B}зделать${E}`, 'giu'), to: (m) => keepCase(m, 'сделать') },
  { id: 'verb', re: new RegExp(`${B}целый(?=\\s+(?:тумбу|комнату|стену|раковину|столешницу|пенал|шкаф|зеркало|рендер|фото)${E})`, 'giu'), to: (m) => keepCase(m, 'сделай') },
  { id: 'verb', re: new RegExp(`${B}постройка(?:\\s*[—–-]\\s*|\\s+)(?=комнату${E})`, 'giu'), to: (m) => keepCase(m, 'построй ') },
];

// ---- sizes: Russian number words -> digits (only next to a unit or in «N на M») ----

const UNITS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одно: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
};
const TEENS: Record<string, number> = {
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19,
};
const TENS: Record<string, number> = {
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
};
const HUNDREDS: Record<string, number> = {
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
};
const HALF: Record<string, number> = { полтора: 1.5, полторы: 1.5 };
const THOUSAND = /^тысяч[аи]?$/;

/** Magnitude rank of a number word (a number is a run of words with strictly falling rank), or 0. */
function rankOf(w: string): { rank: number; value: number } | null {
  if (w in HUNDREDS) return { rank: 3, value: HUNDREDS[w] };
  if (w in TENS) return { rank: 2, value: TENS[w] };
  if (w in TEENS) return { rank: 1.5, value: TEENS[w] }; // ends the number like a unit
  if (w in UNITS) return { rank: 1, value: UNITS[w] };
  return null;
}

type Tok = { s: string; lo: string; start: number; end: number };

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[\p{L}]+|\d+(?:[.,]\d+)?/gu)) out.push({ s: m[0], lo: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Parse a number-word run starting at token i. Returns its value and the index after it, or null. */
function parseNumber(t: Tok[], i: number): { value: number; next: number } | null {
  if (t[i] && t[i].lo in HALF) return { value: HALF[t[i].lo], next: i + 1 };
  let total = 0;
  let cur = 0;
  let lastRank = 99;
  let j = i;
  for (; j < t.length; j++) {
    const w = t[j].lo;
    if (THOUSAND.test(w)) {
      if (total) break; // «тысяча … тысяча» is two numbers
      total += (cur || 1) * 1000; // «тысяча двести», «две тысячи»
      cur = 0;
      lastRank = 99;
      continue;
    }
    const r = rankOf(w);
    if (!r || r.rank >= lastRank || lastRank === 1.5) break; // a teen ends the number like a unit
    cur += r.value;
    lastRank = r.rank;
  }
  if (j === i) return null;
  let value = total + cur;
  // «два с половиной»
  if (t[j]?.lo === 'с' && t[j + 1]?.lo === 'половиной') {
    value += 0.5;
    j += 2;
  }
  return { value, next: j };
}

const isUnit = (tok?: Tok) => !!tok && new RegExp(`^${UNIT}`, 'iu').test(tok.lo);
const isDigits = (tok?: Tok) => !!tok && /^\d/.test(tok.s);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));

function numbersToDigits(text: string, corrections: SttCorrection[]): string {
  const t = tokens(text);
  const spans: { start: number; end: number; value: number; tokStart: number; tokNext: number }[] = [];
  for (let i = 0; i < t.length; ) {
    const n = parseNumber(t, i);
    if (!n) {
      i++;
      continue;
    }
    spans.push({ start: t[i].start, end: t[n.next - 1].end, value: n.value, tokStart: i, tokNext: n.next });
    i = n.next;
  }
  const isNumberAt = (k: number) => isDigits(t[k]) || spans.some((s) => s.tokStart === k);
  const endsAt = (k: number) => isDigits(t[k]) || spans.some((s) => s.tokNext - 1 === k);
  if (/(?<![\p{L}])один\s+на\s+один(?![\p{L}])/iu.test(text)) return text; // the idiom «поговорим один на один»
  const keep = spans.filter((s) => {
    const next = t[s.tokNext];
    if (isUnit(next)) return true; // «восемьдесят сантиметров»
    if (next?.lo === 'на' && isNumberAt(s.tokNext + 1)) return true; // «четыре на четыре»
    if (t[s.tokStart - 1]?.lo === 'на' && endsAt(s.tokStart - 2)) return true; // «… на четыре»
    return false;
  });
  let out = text;
  for (const s of [...keep].reverse()) out = out.slice(0, s.start) + fmt(s.value) + out.slice(s.end);
  for (const s of keep) corrections.push({ rule: 'number', from: text.slice(s.start, s.end), to: fmt(s.value) });
  return out;
}

const SIZE_RULES: Rule[] = [
  // «4Х4 м», «4x4», «4 × 4»
  { id: 'size', re: /(?<![\p{L}\d])(\d+)\s*[xх×]\s*(\d+)(?!\d)/giu, to: (_m, a: string, b: string) => `${a} на ${b}` },
  // «400-400 см» (the same number twice is a size, not a range; «10-16 метров» stays a range)
  {
    id: 'size',
    re: new RegExp(`${B}(\\d+)\\s*[-–]\\s*(\\d+)(?=\\s*${UNIT})`, 'giu'),
    to: (m, a: string, b: string) => (a === b ? `${a} на ${b}` : m),
  },
];

function applyRules(text: string, rules: Rule[], corrections: SttCorrection[]): string {
  let out = text;
  for (const r of rules) {
    out = out.replace(r.re, (m: string, ...g: any[]) => {
      const to = typeof r.to === 'string' ? r.to : r.to(m, ...g);
      if (to !== m) corrections.push({ rule: r.id, from: m, to });
      return to;
    });
  }
  return out;
}

export function sttCorrectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_STT_CORRECT !== '0';
}

/** The voice-turn entry point: corrected text + the `stt` log fields (raw text and the changes, only when something changed). */
export function applySttCorrection(raw: string, env: NodeJS.ProcessEnv = process.env): { text: string; logFields: Record<string, unknown> } {
  if (!sttCorrectionEnabled(env)) return { text: raw, logFields: {} };
  const r = correctTranscript(raw);
  return { text: r.text, logFields: r.corrections.length ? { rawText: raw, corrections: r.corrections } : {} };
}

export function correctTranscript(raw: string): CorrectedTranscript {
  const corrections: SttCorrection[] = [];
  let text = applyRules(raw, RULES, corrections);
  text = numbersToDigits(text, corrections);
  text = applyRules(text, SIZE_RULES, corrections);
  return { text, raw, corrections };
}
