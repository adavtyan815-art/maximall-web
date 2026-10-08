/**
 * MONTH2_SPEC m2.2 §11.4 (REQ-31, decision D4): the status of an estimate line and what it adds to the total.
 *
 * | condition                         | status      | in the total |
 * |-----------------------------------|-------------|--------------|
 * | price > 0, not estimated          | `priced`    | yes          |
 * | price > 0, estimated              | `estimated` | yes (≈, approximate: true) |
 * | price 0 / missing, or unpriced    | `unpriced`  | no («цена уточняется», amount 0) |
 * | not a purchase (unfinished area)  | `info`      | no           |
 *
 * Retail prices include VAT, so there is never a tax line.
 */

export type LineStatus = 'priced' | 'estimated' | 'unpriced' | 'info';

/** The price facts of one line (a QuoteLine has exactly these: price, estimated, unpriced). */
export interface PriceFacts {
  price?: number | null;
  /** Price borrowed from a similar article. */
  estimated?: boolean;
  /** Explicitly marked as having no price source. */
  unpriced?: boolean;
}

/** Rounds money / areas to 0.01. */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function positivePrice(p: PriceFacts): number | null {
  return typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 ? p.price : null;
}

/** §11.4 line status of a priced source (never `info`: that is decided by the caller for non-purchases). */
export function lineStatus(p: PriceFacts): Exclude<LineStatus, 'info'> {
  if (p.unpriced || positivePrice(p) === null) return 'unpriced';
  return p.estimated ? 'estimated' : 'priced';
}

/** `approximate: true` exactly for estimated lines (and their partner basket items). */
export function isApproximate(status: LineStatus): boolean {
  return status === 'estimated';
}

/** Whether a line's amount is part of totalBYN. */
export function countsInTotal(status: LineStatus): boolean {
  return status === 'priced' || status === 'estimated';
}

/** The unit price shown for a line: the price for counted lines, null otherwise («цена уточняется»). */
export function unitPriceOf(p: PriceFacts): number | null {
  return countsInTotal(lineStatus(p)) ? positivePrice(p) : null;
}

/** amountBYN of a line: unit price × quantity for counted lines, 0 otherwise. */
export function lineAmount(status: LineStatus, unitPriceBYN: number | null | undefined, quantity: number): number {
  if (!countsInTotal(status)) return 0;
  if (typeof unitPriceBYN !== 'number' || !Number.isFinite(unitPriceBYN) || unitPriceBYN <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return round2(unitPriceBYN * quantity);
}

/** totalBYN: the sum of the priced + estimated amounts, rounded to 0.01. */
export function totalOf(lines: readonly { status: LineStatus; amountBYN: number }[]): number {
  return round2(lines.reduce((s, l) => (countsInTotal(l.status) && Number.isFinite(l.amountBYN) ? s + l.amountBYN : s), 0));
}

/** pricedCount / estimatedCount / unpricedCount of a response (info lines are not counted). */
export function statusCounts(lines: readonly { status: LineStatus }[]): { pricedCount: number; estimatedCount: number; unpricedCount: number } {
  let pricedCount = 0;
  let estimatedCount = 0;
  let unpricedCount = 0;
  for (const l of lines) {
    if (l.status === 'priced') pricedCount++;
    else if (l.status === 'estimated') estimatedCount++;
    else if (l.status === 'unpriced') unpricedCount++;
  }
  return { pricedCount, estimatedCount, unpricedCount };
}
