import { t, type Lang } from '../i18n';

/**
 * Output guardrails for consultant replies (Russian; v2.5: English too):
 *  - every BYN amount in the reply must be a price/total/budget the session actually saw from the catalogue index;
 *  - no discounts/percentages off, no promo codes;
 *  - no delivery or production dates/durations.
 * Offending sentences are dropped; if nothing is left, a safe fallback line is used.
 * Russian sessions use exactly today's patterns; English sessions use the English patterns PLUS the Russian ones
 * (a model may still slip into Russian), with English number formatting («2,773 BYN» = 2773).
 */
export interface GuardResult {
  text: string;
  violations: string[];
}

const MONEY_RE = /(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:BYN|byn|бел\.?\s*руб\w*|руб\w*|р\.)/g;
const DISCOUNT_RE = /(скидк\w*|акци\w*|промокод\w*|\d+\s*%)/i;
const DATE_RE = /(доставим|привезём|привезем|изготовим|будет готов\w*|через\s+\d+\s*(дн|недел|месяц)|за\s+\d+\s*(дн|недел|рабоч))/i;

/** v2.5 English: «2,773 BYN», «BYN 2,773», «2773 Belarusian rubles», «$300», «€50», «300 dollars». */
const MONEY_EN_RE = /(?:(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:BYN|byn|Br\b|(?:belarusian\s+)?(?:rubles?|roubles?)|dollars?|euros?|usd|eur)|(?:BYN|\$|€|£|USD|EUR)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?))/gi;
const DISCOUNT_EN_RE = /(discount\w*|\bon sale\b|\bsale\b|promo(?:tion|tional)?\b|promo ?code|coupon|voucher|special (?:offer|price|deal)|\bdeal\b|\d+\s*%(?:\s*off)?|% off|knock\s+\w+\s+off|free (?:delivery|installation|shipping))/i;
const DISCOUNT_EN_OK = /(\b(?:can't|cannot|can not|don't|do not|won't|not able|unable)\b[^.]*\b(?:discuss|offer|give|discount|promise)|manager)/i;
const DATE_EN_RE =
  /(\bwe(?:'ll| will) (?:deliver|ship|install|make|produce|bring)|\bdeliver(?:ed|y)? (?:by|in|within|on|tomorrow|next)|\bready (?:by|on|tomorrow|next)\b|\bready (?:in|within) \d+\s*(?:working |business )?(?:days?|weeks?|months?)\b|\bships? (?:in|within|by)|\bin \d+\s*(?:working |business )?(?:days?|weeks?|months?)\b|\bwithin \d+\s*(?:working |business )?(?:days?|weeks?|months?)\b|\bby (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|the end of)|\b(?:on|by) \d{1,2}(?:st|nd|rd|th)?(?: of)? (?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:in stock|available) (?:now|today|tomorrow)\b)/i;
const DATE_EN_OK = /(manager|\b(?:can't|cannot|don't|do not|won't) (?:want to )?promise\b)/i;

export function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0);
}

const ruAmount = (raw: string) => Number(raw.replace(/[\s ]/g, '').replace(',', '.'));
const enAmount = (raw: string) => Number(raw.replace(/,/g, ''));

/** Every BYN (or other currency) amount a sentence names, in the session language's number format. */
function amountsIn(s: string, lang: Lang): number[] {
  if (lang !== 'en') return [...s.matchAll(MONEY_RE)].map((m) => ruAmount(m[1]));
  const out: number[] = [];
  for (const m of s.matchAll(MONEY_EN_RE)) {
    const v = enAmount(m[1] ?? m[2]);
    // a foreign currency is never a catalogue price (the shop sells in BYN only): it can never match an allowed amount
    out.push(/(\$|€|£|usd|eur|dollar|euro)/i.test(m[0]) ? -Math.abs(v) - 0.5 : v);
  }
  // a Russian-formatted amount the model may still write («2 773 руб.»)
  for (const m of s.matchAll(MONEY_RE)) if (/[а-яё]/i.test(m[0])) out.push(ruAmount(m[1]));
  return out;
}

export function guardReply(text: string, allowedAmounts: Iterable<number>, fallback = t('ru', 'guard.fallback'), lang: Lang = 'ru'): GuardResult {
  const allowed = [...allowedAmounts];
  const violations: string[] = [];
  const kept: string[] = [];
  for (const s of splitSentences(text)) {
    let bad = false;
    for (const v of amountsIn(s, lang)) {
      if (!allowed.some((a) => Math.abs(a - v) <= 1)) {
        violations.push(`unknown_amount:${v}`);
        bad = true;
      }
    }
    // Refusing to discuss discounts is allowed; offering one is not.
    if (DISCOUNT_RE.test(s) && !/не (обсужда|могу|предостав|дела)|менеджер/i.test(s)) {
      violations.push('discount');
      bad = true;
    } else if (lang === 'en' && DISCOUNT_EN_RE.test(s) && !DISCOUNT_EN_OK.test(s)) {
      violations.push('discount');
      bad = true;
    }
    if (DATE_RE.test(s) && !/менеджер|не (хочу|могу) обещать/i.test(s)) {
      violations.push('date');
      bad = true;
    } else if (lang === 'en' && DATE_EN_RE.test(s) && !DATE_EN_OK.test(s)) {
      violations.push('date');
      bad = true;
    }
    if (!bad) kept.push(s);
  }
  const out = kept.join(' ').trim();
  return { text: out || fallback, violations };
}

/** The BYN amounts a text names (P3-05: the spoken summary may only repeat figures of the full reply it was cut from). */
export function moneyAmounts(text: string, lang: Lang = 'ru'): number[] {
  return amountsIn(text, lang).filter((v) => v >= 0);
}
