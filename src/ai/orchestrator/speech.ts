import { t, type Lang } from '../i18n';

/**
 * P3-05 (contracts v2.2 ai.say.spokenText): the short spoken summary of a consultant reply.
 *
 * Paid test 2026-10-01: every reply was read out whole (lists with prices and sizes -> 28 s and 54 s of audio), and the
 * long TTS clips used up the per-visitor budget after 20 turns. The chat keeps the full `text`; the voice says only a
 * 5–10 s summary. Russian TTS speaks ≈ 13–16 characters per second, so the hard cap is SPOKEN_MAX_CHARS "speech
 * characters" (a number counts as the words it is read as, e.g. 3230 -> «три тысячи двести тридцать» ≈ 26 characters).
 *
 * Deterministic and model-independent (works for model replies, the scripted fallback and every fixed line):
 *  1. clean: markdown, emoji, quotes, parentheses (details), line breaks;
 *  2. split into sentences; a list («…: 1) …; 2) …», bullet lines, «; »-separated items) is never spoken — a sentence
 *     that introduces one keeps only its lead-in («Подобрала три варианта»);
 *  3. a sentence with more digits than one short figure (sizes, several prices, article codes) is not spoken;
 *  4. the first speakable sentence is always spoken (shortened at a clause boundary if needed), then further ones while
 *     they fit; a closing question («Перейдём?») is kept when it fits, because the visitor answers it by voice;
 *  5. when something was left out, «Подробности — на экране.» points to the chat;
 *  6. «BYN» is read as «рублей».
 * The model is asked (system prompt) to lead with a one-sentence speakable summary, which this then picks up.
 */

/** Hard cap in speech characters: 130 / 13 chars per s = 10 s at the slow end of Russian TTS. */
export const SPOKEN_MAX_CHARS = 130;
/** Characters per second used for the duration estimate (conservative end of 13–16). */
export const SPOKEN_CHARS_PER_SEC = 13;
/** v2.5 English: ~170 speech characters at ~15 chars/s (English TTS reads faster per character). */
export const SPOKEN_MAX_CHARS_EN = 170;
export const SPOKEN_CHARS_PER_SEC_EN = 15;
export const spokenMaxChars = (lang: Lang = 'ru') => (lang === 'en' ? SPOKEN_MAX_CHARS_EN : SPOKEN_MAX_CHARS);
export const spokenCharsPerSec = (lang: Lang = 'ru') => (lang === 'en' ? SPOKEN_CHARS_PER_SEC_EN : SPOKEN_CHARS_PER_SEC);
export const SPOKEN_POINTER_RU = t('ru', 'speech.pointer');
export const SPOKEN_FALLBACK_RU = t('ru', 'speech.fallback');

/** How long a number takes to say, in characters of Russian words (≈ 7 per digit, 4 for a one-digit number). */
function numberChars(digits: string): number {
  const n = digits.replace(/\D/g, '').length;
  return n <= 1 ? 4 : n * 7;
}

/** English number words: ≈ 6 characters per digit, 4 for a one-digit number. */
function numberCharsEn(digits: string): number {
  const n = digits.replace(/\D/g, '').length;
  return n <= 1 ? 4 : n * 6;
}

/** Length in "speech characters": numbers count as the words they are read as (`lang` given: that language's rule). */
export function speechLength(s: string, lang?: Lang): number {
  const nc = lang ? RULES[lang].numberChars : R.numberChars;
  let len = s.length;
  for (const m of s.matchAll(/\d+(?:[.,]\d+)?/g)) len += nc(m[0]) - m[0].length;
  return len;
}

/** Estimated audio seconds for a spoken text. */
export function estimateSpokenSeconds(s: string, charsPerSec = SPOKEN_CHARS_PER_SEC, lang?: Lang): number {
  return Math.round((speechLength(s, lang) / charsPerSec) * 10) / 10;
}

function clean(text: string): string {
  return text
    .replace(/\*\*|__|`|#+\s/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[«»„“”"]/g, '')
    // QA-094: an estimated price stays honest in speech: «2040 BYN (цена уточняется)» -> «ориентировочно 2040 BYN»
    .replace(/(\d[\d\s ]*(?:[.,]\d+)?\s*BYN)\s*\((?:цена\s+)?(?:пока\s+)?уточняется\)/gi, 'ориентировочно $1')
    .replace(/\s*\([^()]*\)/g, '') // details in parentheses (sizes, notes) stay in the chat
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** A line or chunk that is a list item: «1) …», «2. …», «- …», «• …». */
const LIST_ITEM = /^\s*(?:\d{1,2}[).]|[-–•*])\s+/;
/** An enumeration inside one sentence: «1) … 2) …» or several «;»-separated items. */
const INLINE_LIST = /(?:^|[\s:;,])\d{1,2}\)\s/;

function digitsOf(s: string): string[] {
  return [...s.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0]);
}

/** Too many figures to say in a short summary (sizes «80×50×40», several prices, codes like TER70R). */
function tooNumeric(s: string): boolean {
  if (R.codeOrDims.test(s)) return true;
  const nums = digitsOf(s);
  if (nums.length === 0) return false;
  const long = nums.filter((n) => n.replace(/\D/g, '').length >= 4).length;
  const total = nums.reduce((a, n) => a + n.replace(/\D/g, '').length, 0);
  return long > 1 || nums.length > 3 || total > 9;
}

/** Dimensions «80×50×40 см», «60×60» are never spoken (the chat and the cards show them). */
function stripDims(s: string): string {
  return s
    .replace(/,?\s*(?:размер(?:ом)?\s+)?\d+(?:[.,]\d+)?(?:\s*[×xх]\s*\d+(?:[.,]\d+)?)+\s*(?:см|мм|м)?(?![а-яё])/gi, '')
    .replace(/\s+([,.!?:;])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** v2.5 English: only a three-part size («80 × 50 × 40 cm») is left to the chat; «3 × 2.5 m» is read as «3 by 2.5 metres». */
function stripDimsEn(s: string): string {
  return s
    .replace(/,?\s*(?:sized?\s+)?\d+(?:\.\d+)?(?:\s*[×x]\s*\d+(?:\.\d+)?){2,}\s*(?:cm|mm|m)?\b/gi, '')
    .replace(/\s+([,.!?:;])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Sentence boundaries (after . ! ? …) and line breaks. QA-094: list items are marked even when the list and the closing
 * question share one line («1. … BYN. 2. … BYN. Какой поставить?»): a sentence that starts with a marker is an item, the
 * statements between two items are item details; a question is always its own piece.
 */
function pieces(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n+/)) {
    const l = line.trim();
    if (!l) continue;
    const parts: string[] = [];
    for (const x of l.split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ0-9•–-])/)) {
      const t = x.trim();
      if (!t) continue;
      if (parts.length && /^\d{1,2}[.)]$/.test(parts[parts.length - 1])) parts[parts.length - 1] += ` ${t}`; // «1.» + its item
      else parts.push(t);
    }
    const isItem = (t: string) => LIST_ITEM.test(t);
    const lastItem = parts.reduce((a, t, i) => (isItem(t) ? i : a), -1);
    parts.forEach((t, i) => {
      const detail = !/\?$/.test(t) && i < lastItem && parts.slice(0, i).some(isItem); // between two items
      out.push(isItem(t) || detail ? '\u0000' + t : t);
    });
  }
  return out;
}

/** QA-094: a first-person action confirmation («Поставила …», «Положила …», «Готово …») is always spoken. */
const ACTION = /^(?:я\s+)?(?:готово|[а-яё]+(?:ла|ли))(?=[\s,:.])/i;
function confirmationOf(sentence: string): string {
  const s = R.stripDims(sentence);
  const i = s.indexOf(':');
  if (i > 0 && s.slice(0, i).split(/\s+/).length >= 2 && !tooNumeric(s.slice(0, i))) return endPunct(s.slice(0, i).trim());
  if (!tooNumeric(s) && speechLength(s) <= R.confirmMax) return endPunct(s);
  const m = /^(.*?)(?:,\s|\s[—–]\s)/.exec(s);
  if (m && m[1].split(/\s+/).length >= 2 && !tooNumeric(m[1])) return endPunct(m[1].trim());
  return '';
}

const endPunct = (s: string) => (/[.!?…]$/.test(s) ? s : `${s.replace(/[,;:—–-]+$/, '').trim()}.`);

/** A clause that must not be cut off from a demonstrative before it («не хочу обещать то, | что …»). */
const SUBORDINATE = /^(что|чтобы|который|которая|которое|которые|которую|если|когда|где|куда|как|чем|пока|потому)(?![а-яё])/i;
const DEMONSTRATIVE = /(?:^|\s)(то|так|тот|та|те|такой|такая|такое|такие|столько|там|тогда|настолько|туда|оттуда)$/i;

/**
 * Shorten one sentence to `max` at a clause boundary. mode 'any': comma/dash/colon/semicolon, else at a word; 'clause': the
 * same boundaries, never at a word; 'strong': only dash/colon/semicolon (never inside an enumeration). '' when impossible.
 */
function shorten(s: string, max: number, mode: 'any' | 'clause' | 'strong' = 'any'): string {
  if (speechLength(s) <= max) return s;
  let head = '';
  for (const m of s.matchAll(mode === 'strong' ? /[;:]\s|\s[—–]\s/g : /[,;:—–]\s|\s[—–]\s/g)) {
    const h = s.slice(0, m.index).trim();
    const next = s.slice((m.index ?? 0) + m[0].length).trim();
    if (speechLength(h) <= max - 1 && h.split(/\s+/).length >= 3 && !(R.subordinate.test(next) && R.demonstrative.test(h))) head = h;
  }
  if (!head && mode !== 'any') return '';
  if (!head) {
    for (const w of s.split(/\s+/)) {
      const next = head ? `${head} ${w}` : w;
      if (speechLength(next) > max - 1) break;
      head = next;
    }
  }
  return endPunct(head.replace(/[,;:—–-]+$/, '').trim());
}

/** «2043 BYN» -> «2043 рубля» (Russian agreement with the last digits). */
function rubles(num: string): string {
  const n = Number(num.replace(/\s/g, '').replace(',', '.'));
  if (!Number.isInteger(n)) return 'рубля';
  const d2 = n % 100;
  const d1 = n % 10;
  if (d2 >= 11 && d2 <= 14) return 'рублей';
  if (d1 === 1) return 'рубль';
  if (d1 >= 2 && d1 <= 4) return 'рубля';
  return 'рублей';
}

/**
 * v2.5 English: how figures are said — «≈ 2,040 BYN» -> «about 2,040 Belarusian rubles», «№ 3» -> «number 3», «80 cm» ->
 * «80 centimetres», «3 × 2.5 m» -> «3 by 2.5 metres», «m²» -> «square metres». No Russian grammar.
 */
function voiceFormEn(s: string): string {
  return s
    .replace(/≈\s*/g, 'about ')
    .replace(/(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/g, '$1 by $2')
    .replace(/(\d)\s*m²/g, '$1 square metres')
    .replace(/\bm²/g, 'square metres')
    .replace(/(\d)\s*cm(?=\s+(?:room|set|vanity|unit|cabinet|mirror|wall|basin|worktop|display|gap|shift)\b)/g, '$1 centimetre')
    .replace(/(\d)\s*cm\b/g, (_m, d: string) => `${d} centimetres`)
    .replace(/(\d)\s*mm\b/g, (_m, d: string) => `${d} millimetres`)
    .replace(/(\d)\s*m\b/g, (_m, d: string) => `${d} metres`)
    .replace(/\b1 (centimetres|metres|millimetres)/g, (_m, u: string) => `1 ${u.slice(0, -1)}`)
    .replace(/\bBYN\b/g, 'Belarusian rubles')
    .replace(/\s*№\s*/g, ' number ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** For the speech only: currency and symbols as they are said. */
function voiceForm(s: string): string {
  return s
    .replace(/(^|\s)в\s+BYN\b/g, '$1в рублях')
    .replace(/(\d[\d\s ]*(?:[.,]\d+)?)\s*BYN\b/g, (_m, n: string) => `${n.trim()} ${rubles(n)}`)
    .replace(/\bBYN\b/g, 'рублей')
    .replace(/\s*№\s*/g, ' номер ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One-word introductions that still make a spoken sentence («Готово: пол — плитка 60×60» -> «Готово.»). */
const ACK = /^(готово|хорошо|отлично|поняла|сделала|поставила|покрасила|добавила|убрала|поменяла)$/i;

/**
 * v2.5: the language-specific pieces of the summary. Russian = today's rules (unchanged objects and functions); English =
 * its own rule set with the same structure (first sentence + action + closing question).
 */
interface SpeechRules {
  max: number;
  numberChars: (digits: string) => number;
  clean: (text: string) => string;
  stripDims: (s: string) => string;
  codeOrDims: RegExp;
  action: RegExp;
  ack: RegExp;
  confirmMax: number;
  subordinate: RegExp;
  demonstrative: RegExp;
  voiceForm: (s: string) => string;
  pointer: () => string;
  fallback: () => string;
  /** the short closing question that names the Constructor / room planner («Перейдём в Конструктор?») */
  roomQuestion: (sentence: string, question: string) => string | undefined;
  /** a closing question this short keeps its sentence with it («Перейдём?» / «Shall we go?») */
  shortQuestionWords: number;
}
const RU_RULES: SpeechRules = {
  max: SPOKEN_MAX_CHARS,
  numberChars,
  clean,
  stripDims,
  codeOrDims: /[A-ZА-Я]{2,}\d|\d[A-ZА-Я]{1,}\d|\d\s*[×x]\s*\d/,
  action: ACTION,
  ack: ACK,
  confirmMax: 100,
  subordinate: SUBORDINATE,
  demonstrative: DEMONSTRATIVE,
  voiceForm,
  pointer: () => SPOKEN_POINTER_RU,
  fallback: () => SPOKEN_FALLBACK_RU,
  shortQuestionWords: 2,
  roomQuestion: (s, q) => (/конструктор/i.test(s) && /^перейд[её]м\?$/i.test(q) ? 'Перейдём в Конструктор?' : undefined),
};
const EN_RULES: SpeechRules = {
  max: SPOKEN_MAX_CHARS_EN,
  numberChars: numberCharsEn,
  // «≈ 2,040 BYN (estimate)» keeps «≈» (said «about»); the parentheses go to the chat like in Russian
  clean: (text) => clean(text.replace(/(\d[\d,]*(?:\.\d+)?\s*BYN)\s*\((?:price to be confirmed|estimate)\)/gi, '≈ $1').replace(/≈\s*≈/g, '≈')),
  stripDims: stripDimsEn,
  // article codes and three-part sizes are too numeric; a two-part size is read as «3 by 2.5»
  codeOrDims: /[A-ZА-Я]{2,}\d|\d[A-ZА-Я]{1,}\d|\d\s*[×x]\s*\d+(?:\.\d+)?\s*[×x]\s*\d/,
  action: /^(?:i've|i have|i'll|i will|done|we're|we are|starting over)(?=[\s,:.])/i,
  ack: /^(done|fine|great|ok|okay|good|sure|right)$/i,
  confirmMax: 130,
  subordinate: /^(that|which|who|whom|if|when|where|how|than|while|because|so that|until)(?![a-z])/i,
  demonstrative: /(?:^|\s)(that|so|such|there|then|this|those|these)$/i,
  voiceForm: voiceFormEn,
  pointer: () => t('en', 'speech.pointer'),
  fallback: () => t('en', 'speech.fallback'),
  shortQuestionWords: 3,
  roomQuestion: (s, q) => (/room planner/i.test(s) && /^shall we( go)?\?$/i.test(q) ? 'Shall we open the room planner?' : undefined),
};
const RULES: Record<Lang, SpeechRules> = { ru: RU_RULES, en: EN_RULES };
/** The rule set of the summary being built (spokenSummary is synchronous; Russian outside it). */
let R: SpeechRules = RU_RULES;

export interface SpokenSummary {
  text: string;
  /** something of the full reply is not spoken (list, figures, extra sentences) */
  trimmed: boolean;
}

export function spokenSummary(fullText: string, max?: number, lang: Lang = 'ru'): SpokenSummary {
  const prev = R;
  R = RULES[lang] ?? RU_RULES;
  try {
    return summarise(fullText, max ?? R.max);
  } finally {
    R = prev;
  }
}

function summarise(fullText: string, max: number): SpokenSummary {
  const pointer = R.pointer();
  const fallback = R.fallback();
  const voice = R.voiceForm;
  const src = R.clean(fullText ?? '');
  if (!src) return { text: '', trimmed: false };
  let trimmed = false;
  /** a list, figures or details were left to the chat -> the pointer «Подробности — на экране» */
  let details = false;
  const speakable: string[] = [];
  const introOf = (p: string) => {
    const i = p.indexOf(':');
    const intro = i > 0 ? p.slice(0, i).trim() : '';
    if (!intro || tooNumeric(intro) || INLINE_LIST.test(intro)) return '';
    if (R.ack.test(intro)) return speakable.length ? '' : endPunct(intro); // «Готово.» once, only as the opening
    return intro.split(/\s+/).length >= 2 ? endPunct(intro) : '';
  };
  const all = pieces(src);
  const firstText = all.findIndex((x) => !x.startsWith('\u0000'));
  const words = (x: string) => x.replace(/[^а-яёa-z0-9]+/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
  all.forEach((p0, idx) => {
    if (p0.startsWith('\u0000')) {
      trimmed = details = true; // bullet / numbered line: chat only
      return;
    }
    const p1 = R.stripDims(p0);
    if (p1 !== p0) trimmed = details = true;
    let p = speakableOf(p1);
    // QA-094: the confirmation of what was just done is always said («Положила на пол серый керамогранит.»)
    if (idx === firstText && R.action.test(p0) && (!p || !p.startsWith(p1.split(/\s+/)[0]))) p = confirmationOf(p0) || p;
    if (p && (words(p) >= 2 || /[?!]$/.test(p))) speakable.push(voice(p));
  });
  function speakableOf(p0: string): string {
    let p = p0;
    if (/:$/.test(p)) {
      // «Подобрала два комплекта:» followed by list lines -> «Подобрала два комплекта.»
      trimmed = details = true;
      p = endPunct(p.slice(0, -1).trim());
    }
    const colon = p.indexOf(':');
    const after = colon > 0 ? p.slice(colon + 1) : '';
    const enumerated = INLINE_LIST.test(p) || (colon > 0 && (INLINE_LIST.test(after) || /;/.test(after)));
    if (!enumerated && colon > 0 && after.split(',').length >= 4 && speechLength(after) > 60) {
      // a long comma list of names («Цвета: чёрный МДФ, бежевый, белый, …»): chat only
      trimmed = details = true;
      return '';
    }
    if (enumerated || (colon > 0 && (tooNumeric(after) || speechLength(p) > max))) {
      trimmed = details = true;
      const intro = introOf(p);
      if (!intro) return '';
      p = intro;
    }
    if (tooNumeric(p)) {
      trimmed = details = true;
      const intro = introOf(p);
      if (!intro) return '';
      p = intro;
    }
    return p;
  }
  if (!speakable.length) return { text: fallback, trimmed: true };

  const len = (xs: string[]) => speechLength(xs.join(' '));
  const isQ = (x: string) => /\?$/.test(x);
  // The closing question (the visitor answers it by voice) = the LAST question of the reply; statements after it stay in
  // the chat (QA-094). A one/two-word question («Перейдём?», «Сохранить?») keeps its sentence with it.
  const rest = speakable.slice(1);
  const qi = rest.map(isQ).lastIndexOf(true);
  if (qi >= 0 && qi < rest.length - 1) {
    rest.splice(qi + 1);
    trimmed = true;
  }
  let closing: string[] = [];
  if (rest.length && isQ(rest[rest.length - 1])) {
    const q = rest[rest.length - 1];
    closing = q.split(/\s+/).length <= R.shortQuestionWords && rest.length >= 2 && !isQ(rest[rest.length - 2]) ? [rest[rest.length - 2], q] : [q];
  }
  const middle = rest.slice(0, rest.length - closing.length);
  // A bare greeting / acknowledgement («Здравствуйте!», «Поняла.») is not a summary: the next sentence joins the lead.
  let leadText = speakable[0];
  if (middle.length && speechLength(leadText) < 30 && !isQ(leadText) && len([leadText, middle[0], ...closing]) <= max) leadText = `${leadText} ${middle.shift()}`;
  let first = shorten(leadText, max);
  if (first !== leadText) trimmed = true;
  if (closing.length === 2 && len([first, ...closing]) > max) {
    // «Могу сохранить проект …, чтобы … . Сохранить?» -> its first clause, else «Перейдём в Конструктор?» / the bare question
    const prev = shorten(closing[0], max - speechLength(first) - speechLength(closing[1]) - 2, 'clause');
    const roomQ = R.roomQuestion(closing[0], closing[1]);
    closing = prev && prev.split(/\s+/).length >= 3 ? [prev, closing[1]] : roomQ ? [roomQ] : [closing[1]];
    trimmed = true;
  }
  if (closing.length && len([first, ...closing]) > max) {
    // QA-094: keep the question; the lead gives up its tail (the full text stays in the chat)
    const short = shorten(first, max - len(closing) - 1, 'clause');
    if (short && short.split(/\s+/).length >= 3) first = short;
    trimmed = true;
  }
  if (closing.length === 1 && len([first, ...closing]) > max) {
    // …or the question gives up its tail («Хотите добавить навесной шкаф, сделать …?» -> «Хотите добавить навесной шкаф?»),
    // …or an earlier, shorter question of the reply is asked
    const qs = shorten(closing[0], max - speechLength(first) - 1, 'clause').replace(/\.$/, '?');
    const earlier = rest.slice(0, -1).filter(isQ).reverse().find((x) => len([first, x]) <= max);
    if (earlier) {
      closing = [earlier];
      if (middle.includes(earlier)) middle.splice(middle.indexOf(earlier));
    } else if (qs && qs.split(/\s+/).length >= 3 && !qs.includes(':')) closing = [qs];
  }
  const picked = [first];
  const cLen = closing.length ? len(closing) + 1 : 0;
  for (const m of middle) {
    if (len([...picked, m]) + cLen <= max) picked.push(m);
    else {
      // the first clause of a long sentence when it still fits («Расскажу о коллекциях и настрою любой стенд салона под вас.»)
      const part = shorten(m, max - len(picked) - 1 - cLen, 'strong');
      if (part && part.split(/\s+/).length >= 4) picked.push(part);
      trimmed = true;
      break;
    }
  }
  if (picked.length - 1 < middle.length) trimmed = true;
  const out = [...picked];
  if (closing.length) {
    if (len([...out, ...closing]) <= max) out.push(...closing);
    else trimmed = true;
  }
  if (details && len(out) + speechLength(pointer) + 1 <= max) {
    // the pointer goes before the closing question
    const at = closing.length && out[out.length - 1] === closing[closing.length - 1] ? out.length - closing.length : out.length;
    out.splice(at, 0, pointer);
  }
  return { text: out.join(' ').trim(), trimmed };
}
