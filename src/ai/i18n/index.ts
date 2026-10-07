import { RU } from './ru';
import { EN } from './en';
import { detailTemplate, NO_TEMPLATE_DETAILS, REASON_DETAILS_EN, REASON_DETAILS_RU } from './reasons';

/**
 * Contracts v2.5 (English alongside Russian): one language per visitor session, `ru` by default.
 *
 * Every visitor-facing backend string is a message key with a Russian and an English entry. The Russian table holds
 * today's exact strings (byte-identical; the existing test suite proves it), the English table the same messages in
 * English with English formatting (`2,773 BYN`, `80 cm`, `3 × 2.5 m`). An entry is a string or a function of params.
 */
export type Lang = 'ru' | 'en';
export const LANGS: readonly Lang[] = ['ru', 'en'];
export type Msg = string | ((p: any) => string);
export type MsgKey = keyof typeof RU;

/** v2.5 §1: `"ru" | "en"`; anything else is `"ru"`. */
export function normalizeLang(x: unknown): Lang {
  return typeof x === 'string' && x.trim().toLowerCase() === 'en' ? 'en' : 'ru';
}

export function t(lang: Lang | undefined, key: MsgKey, params: Record<string, any> = {}): string {
  const m: Msg | undefined = lang === 'en' ? (EN as Record<string, Msg>)[key] : undefined;
  const msg = m ?? (RU as Record<string, Msg>)[key];
  return typeof msg === 'function' ? msg(params) : msg;
}

/** Whether a key exists (reason codes are looked up by UE's code). */
export function hasKey(key: string): key is MsgKey {
  return Object.prototype.hasOwnProperty.call(RU, key);
}

/** English number formatting: 2773 -> «2,773»; Russian keeps today's plain digits. */
export function num(lang: Lang | undefined, v: number): string {
  if (lang !== 'en' || typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ── v2.5 §7: UE reason codes -> visitor text ─────────────────────────────────

export interface ReasonSource {
  reasonCode?: string;
  reason?: string;
  reasonParams?: Record<string, any>;
}

/**
 * The visitor text for a refused UE command. English: the locale table by `reasonCode` + `reasonParams` when the code is
 * known, else UE's `reason` (contract v2.5 §7), else `fallback`. Russian: UE's own Russian `reason` as today (UE keeps it
 * for compatibility); only a result with `reasonParams` and no `reason` (the new UE style) uses the table; else `fallback`.
 * So Russian output does not change.
 */
export function reasonText(lang: Lang | undefined, r: ReasonSource | undefined | null, fallback?: string): string | undefined {
  return renderReason(lang, r, fallback).text;
}

/**
 * v2.5 §7 renderer (UE_REASON_CODES_v2.5.md): (reasonCode, reasonParams.detail) + params -> text.
 * English: the detail template; a detail without a template -> the reasonCode's generic English line, else a generic
 * line (`missing` names the key for the log); `PLANNER_REJECTED` -> UE's `reason`. A result without reasonParams (older UE,
 * or the backend's own held/gated/timeout results) -> the reasonCode line, else `reason`.
 * Russian: UE's own `reason` (unchanged); only a refusal without `reason` uses the Russian template.
 */
export function renderReason(lang: Lang | undefined, r: ReasonSource | undefined | null, fallback?: string): { text?: string; missing?: string } {
  const code = r?.reasonCode;
  const params = r?.reasonParams ?? {};
  const detail = typeof params.detail === 'string' ? params.detail : undefined;
  const codeKey = code ? `reason.${code}` : '';
  const codeLine = codeKey && hasKey(codeKey) ? t(lang, codeKey, params) : undefined;
  if (lang !== 'en') {
    if (r?.reason) return { text: r.reason };
    if (r?.reasonParams) return { text: detailTemplate(REASON_DETAILS_RU, code, detail, params) ?? codeLine ?? fallback };
    return { text: fallback };
  }
  if (detail && NO_TEMPLATE_DETAILS.has(detail)) return { text: r?.reason ?? codeLine ?? fallback };
  const byDetail = detailTemplate(REASON_DETAILS_EN, code, detail, params);
  if (byDetail) return { text: byDetail };
  if (detail) return { text: codeLine ?? t('en', 'reason.generic'), missing: `${code}.${detail}` };
  if (codeLine) return { text: codeLine };
  if (code && r?.reasonParams) return { text: t('en', 'reason.generic'), missing: code };
  return { text: r?.reason ?? fallback, ...(code && r?.reason ? { missing: code } : {}) };
}

/** The reason codes the backend can render (for tests and the UE coordination list). */
export function knownReasonCodes(): string[] {
  return Object.keys(RU)
    .filter((k) => k.startsWith('reason.') && k !== 'reason.generic')
    .map((k) => k.slice('reason.'.length));
}
/** The UE `reasonParams.detail` values with an English template. */
export function knownReasonDetails(): string[] {
  return Object.keys(REASON_DETAILS_EN).filter((k) => !k.includes('.'));
}

export { RU, EN };
