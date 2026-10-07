import type { LlmProvider, LlmRequest, LlmResponse } from './llm';
import { parseTurn, ReplyKind } from '../orchestrator/intents';
import { parseTurnEn } from '../orchestrator/intentsEn';
import { t, type Lang } from '../i18n';

type Kind = Exclude<ReplyKind, 'actions'>;
const KINDS: Kind[] = ['greeting', 'guard_discount', 'guard_delivery', 'off_topic', 'ask_room', 'ask_budget', 'unknown', 'showroom_unknown', 'need_constructor'];
/** v2.5: canned replies in the session language (Russian unchanged). */
export const cannedReplies = (lang: Lang): Record<Kind, string> => Object.fromEntries(KINDS.map((k) => [k, t(lang, `mock.${k}` as 'mock.greeting')])) as Record<Kind, string>;
export const cannedShowroom = (lang: Lang): Partial<Record<Kind, string>> => ({
  greeting: t(lang, 'mock.showroom.greeting'),
  off_topic: t(lang, 'mock.showroom.off_topic'),
  ask_room: t(lang, 'mock.showroom.fallback'),
  unknown: t(lang, 'mock.showroom.fallback'),
});
export const CANNED_RU: Record<Kind, string> = cannedReplies('ru');

/** v2.0 showroom wording of the general answers (no room questions in the salon). */
export const CANNED_SHOWROOM_RU: Partial<Record<Kind, string>> = cannedShowroom('ru');

/** v2.5: the session language is visible from the system prompt (English: «Always answer in English»). */
export function langOfSystem(system?: string): Lang {
  return /Always answer in English/.test(system ?? '') ? 'en' : 'ru';
}

function textOf(content: any): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
    const hasToolResult = content.some((b: any) => b.type === 'tool_result');
    if (!hasToolResult && t.length) return t.join('\n');
  }
  return null;
}

/**
 * Scripted tool-calling policy (no network, no cost). Plays the golden path from Russian text with keyword rules:
 * each visitor turn is parsed into an ordered list of tool calls; after all results are in, it replies with the
 * `say` lines the orchestrator put into the tool results. Also used as the scripted fallback after an LLM timeout.
 */
export class MockLlm implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-policy-1';
  readonly mock = true;
  async create(req: LlmRequest): Promise<LlmResponse> {
    const msgs = req.messages;
    let start = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && textOf(msgs[i].content) !== null) {
        start = i;
        break;
      }
    }
    const text = start >= 0 ? textOf(msgs[start].content)! : '';
    // Lines starting with "[" are orchestrator notes (e.g. "[событие] карточка применена"), not visitor speech.
    const visitorText = text
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('['))
      .join('\n');
    // v2.0: the mode is visible from the tools the orchestrator offers (room tools only in «Конструктор»).
    const mode = (req.tools ?? []).some((t: any) => t.name === 'build_room') ? 'constructor' : 'showroom';
    const lang = langOfSystem(req.system);
    const parsed = lang === 'en' ? parseTurnEn(visitorText, mode) : parseTurn(visitorText, mode);
    const allowed = new Set((req.tools ?? []).map((t: any) => t.name));
    if (req.tools) parsed.calls = parsed.calls.filter((c) => allowed.has(c.name));
    const after = msgs.slice(start + 1);
    const done = after.filter((m) => m.role === 'assistant').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === 'tool_use').length;
    const results: any[] = after
      .filter((m) => m.role === 'user' && Array.isArray(m.content))
      .flatMap((m) => m.content as any[])
      .filter((b) => b.type === 'tool_result');

    if (done < parsed.calls.length) {
      const c = parsed.calls[done];
      return { content: [{ type: 'tool_use', id: `mock_${start}_${done}`, name: c.name, input: c.input }], stopReason: 'tool_use', model: this.model };
    }
    let reply: string;
    if (parsed.calls.length === 0 && results.length === 0) {
      const k = (parsed.reply === 'actions' ? 'unknown' : parsed.reply) as Exclude<ReplyKind, 'actions'>;
      const canned = lang === 'ru' ? CANNED_RU : cannedReplies(lang);
      reply = (mode === 'showroom' ? (lang === 'ru' ? CANNED_SHOWROOM_RU : cannedShowroom(lang))[k] : undefined) ?? canned[k] ?? canned.unknown;
    }
    else {
      const says = results
        .map((r) => {
          try {
            const j = JSON.parse(typeof r.content === 'string' ? r.content : r.content?.[0]?.text ?? '{}');
            return j.say as string | undefined;
          } catch {
            return undefined;
          }
        })
        .filter((s): s is string => !!s);
      reply = says.length ? says.join(' ') : t(lang, 'done');
    }
    return { content: [{ type: 'text', text: reply }], stopReason: 'end_turn', model: this.model };
  }
}
