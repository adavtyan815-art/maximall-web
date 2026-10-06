import type { LlmProvider, LlmRequest, LlmResponse } from './llm';
import { parseTurn, ReplyKind } from '../orchestrator/intents';

export const CANNED_RU: Record<Exclude<ReplyKind, 'actions'>, string> = {
  greeting: 'Здравствуйте! Я Ольга, консультант Oliveeka. Какого размера ваша ванная и на какой бюджет в BYN вы рассчитываете?',
  guard_discount:
    'Скидки и специальные условия я не обсуждаю — это решает менеджер салона, я позову его. Все цены, которые я называю, взяты из каталога oliveeka.by.',
  guard_delivery:
    'Сроки, доставку, монтаж и условия гарантии уточните, пожалуйста, у менеджера салона — не хочу обещать то, что не могу гарантировать. А комплект и расчёт я подготовлю прямо сейчас.',
  off_topic: 'Я помогаю только с ванной комнатой: подберу мебель, отделку и сделаю фото. Расскажите, какого размера ваша ванная?',
  ask_room: 'Подскажите размер ванной, например «2 на 2,5 метра», и примерный бюджет в BYN — и я предложу три варианта.',
  ask_budget: 'На какой бюджет в BYN вы рассчитываете? Так я предложу подходящие варианты.',
  unknown: 'Подскажите, пожалуйста, размер ванной (например, «2 на 2,5 метра») и примерный бюджет в BYN.',
  showroom_unknown: 'Расскажу о любой коллекции и настрою стенд под вас: размер, цвет, навесной шкаф, покраска по RAL/NCS. О чём поговорим?',
  need_constructor: 'Фото, досье и план комнаты делаются в комнате Конструктора.',
};

/** v2.0 showroom wording of the general answers (no room questions in the salon). */
export const CANNED_SHOWROOM_RU: Partial<Record<Exclude<ReplyKind, 'actions'>, string>> = {
  greeting: 'Здравствуйте! Я Ольга, консультант Oliveeka. Расскажу о коллекциях и настрою любой стенд салона под вас.',
  off_topic: 'Я помогаю только с мебелью для ванной: коллекции, цены, размеры, настройка стендов. О чём рассказать?',
  ask_room: CANNED_RU_SHOWROOM_FALLBACK(),
  unknown: CANNED_RU_SHOWROOM_FALLBACK(),
};
function CANNED_RU_SHOWROOM_FALLBACK() {
  return 'Расскажу о любой коллекции и настрою стенд под вас: размер, цвет, навесной шкаф, покраска по RAL/NCS. О чём поговорим?';
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
    const parsed = parseTurn(visitorText, mode);
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
      reply = (mode === 'showroom' ? CANNED_SHOWROOM_RU[k] : undefined) ?? CANNED_RU[k] ?? CANNED_RU.unknown;
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
      reply = says.length ? says.join(' ') : 'Готово.';
    }
    return { content: [{ type: 'text', text: reply }], stopReason: 'end_turn', model: this.model };
  }
}
