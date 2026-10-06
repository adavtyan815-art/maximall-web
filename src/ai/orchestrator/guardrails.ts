/**
 * Output guardrails for consultant replies (Russian):
 *  - every BYN amount in the reply must be a price/total/budget the session actually saw from the catalogue index;
 *  - no discounts/percentages off, no promo codes;
 *  - no delivery or production dates/durations.
 * Offending sentences are dropped; if nothing is left, a safe fallback line is used.
 */
export interface GuardResult {
  text: string;
  violations: string[];
}

const MONEY_RE = /(\d[\d\s ]*(?:[.,]\d+)?)\s*(?:BYN|byn|бел\.?\s*руб\w*|руб\w*|р\.)/g;
const DISCOUNT_RE = /(скидк\w*|акци\w*|промокод\w*|\d+\s*%)/i;
const DATE_RE = /(доставим|привезём|привезем|изготовим|будет готов\w*|через\s+\d+\s*(дн|недел|месяц)|за\s+\d+\s*(дн|недел|рабоч))/i;

export function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 0);
}

export function guardReply(text: string, allowedAmounts: Iterable<number>, fallback = 'Уточню это у менеджера салона.'): GuardResult {
  const allowed = [...allowedAmounts];
  const violations: string[] = [];
  const kept: string[] = [];
  for (const s of splitSentences(text)) {
    let bad = false;
    for (const m of s.matchAll(MONEY_RE)) {
      const v = Number(m[1].replace(/[\s ]/g, '').replace(',', '.'));
      if (!allowed.some((a) => Math.abs(a - v) <= 1)) {
        violations.push(`unknown_amount:${v}`);
        bad = true;
      }
    }
    // Refusing to discuss discounts is allowed; offering one is not.
    if (DISCOUNT_RE.test(s) && !/не (обсужда|могу|предостав|дела)|менеджер/i.test(s)) {
      violations.push('discount');
      bad = true;
    }
    if (DATE_RE.test(s) && !/менеджер|не (хочу|могу) обещать/i.test(s)) {
      violations.push('date');
      bad = true;
    }
    if (!bad) kept.push(s);
  }
  const out = kept.join(' ').trim();
  return { text: out || fallback, violations };
}

/** The BYN amounts a text names (P3-05: the spoken summary may only repeat figures of the full reply it was cut from). */
export function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY_RE)].map((m) => Number(m[1].replace(/[\s ]/g, '').replace(',', '.')));
}
