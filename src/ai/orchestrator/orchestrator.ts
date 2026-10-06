import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { CatalogIndex } from '../catalog/index';
import { fullConfig, lcColour, tonesOf } from '../catalog/index';
import type { SetConfig } from '../catalog/types';
import type { LlmMessage, LlmProvider, LlmResponse } from '../providers/llm';
import type { SttProvider, TtsProvider } from '../providers/voice';
import { ClipStore } from '../providers/voice';
import { CommandChannel, EnvelopeRequest, EnvelopeResult, newRequestId, Origin } from './channel';
import { guardReply, moneyAmounts } from './guardrails';
import { estimateSpokenSeconds, spokenSummary, SPOKEN_FALLBACK_RU } from './speech';
import { applySttCorrection } from '../voice/sttCorrect';
import { buildCard, buildInfoCard, Card, generateCandidates, ProposeArgs, rankTiers } from './propose';
import { TOOLS, toolsFor } from './tools';
import {
  Mode,
  ROOM_COMMANDS,
  toolsAllowed,
  OFFER_CONSTRUCTOR_RU,
  OFFER_CONSTRUCTOR_MODEL_RU,
  OFFER_CONSTRUCTOR_OPTIONS,
  isExplicitConstructorRequest,
  wantsOtherCollection,
  isExitRequest,
  isRoomAction,
  ROOM_OFFER_RU,
  PHOTO_OFFER_RU,
  isFitQuestion,
  FIT_HINT_RU,
  STAY_RU,
  NO_BOOTH_RU,
  scopeQuestionRu,
  scopeOptions,
  pickQuestionRu,
  isFitTopic,
  asksForConstructor,
  isVerbalYes,
  isVerbalNo,
  boothScopeAnswer,
  collectionFromText,
  isBoothPhotoRequest,
  BOOTH_PHOTO_NO_FOCUS_RU,
  BOOTH_PHOTO_OFFER_RU,
} from './modes';
import { BoothState, boothPrice, boothTitle, collectionOf, describeBoothOptions, fitAnswer, planBoothChange } from './booth';
import { describeListing, listParts, PART_NAMES, type PartName } from './parts';

/** v2.4: configure_set inputs that go through the semantic planner (parts by DataTable id, size, paint, doors) instead of raw indices. */
const V24_SET_FIELDS = ['part', 'option', 'colour', 'colourId', 'sizeCm', 'closet', 'paintCode', 'clearPaint', 'doors', 'collection'];
import { parseRoomSize } from './intents';

export const CONSULTANT_NAME = 'Ольга';
export const GREETING_RU = 'Здравствуйте! Я Ольга, консультант Oliveeka. Какого размера ваша ванная и на какой бюджет в BYN вы рассчитываете?';
/** v2.0: the visitor starts in the salon (showroom). */
export const GREETING_SHOWROOM_RU = 'Здравствуйте! Я Ольга, консультант Oliveeka. Расскажу о коллекциях и настрою любой стенд салона под вас — размер, цвет, навесной шкаф, покраска по RAL/NCS.';

/** v2.0: buttons under a consultant message (ai.offer). */
export interface Offer {
  offerId: string;
  kind: 'constructor' | 'booth_scope' | 'collection_pick' | 'generic';
  text: string;
  options: { id: string; label: string }[];
  topic?: string;
  boothId?: string;
  /** the visitor turn number in which a verbal answer counts (the very next one) */
  validTurn: number;
  /** v2.1: the configuration to carry into the room on yes (an info card's config) */
  carry?: SetConfig;
  cardId?: string;
  createdAt: number;
  open: boolean;
}
const OFFER_TTL_MS = 15 * 60_000;

export interface SessionIO {
  emit(event: string, payload: any): void;
}

export interface PlacedSetInfo {
  setId: string;
  config: Required<SetConfig>;
  title: string;
  cardId?: string;
}

/**
 * Paid test 2026-10-01: claude-sonnet-5-5 binds every thinking block to the system prompt, the tool set and all earlier
 * messages ("preserved thinking"; enforced for accounts created on or after 2026-08-31). A mode switch rebuilds system +
 * tools and trimHistory drops leading turns, so the replayed blocks were rejected with HTTP 400 «Invalid `signature` in
 * `thinking` block» (every live golden run, first turn after exit_constructor). At such a boundary the old thinking blocks
 * are stripped once; text and tool_use blocks stay. Returns the number of blocks removed.
 */
export function stripThinking(messages: LlmMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const blocks = m.content as any[];
    const kept = blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (kept.length === blocks.length) continue;
    n += blocks.length - kept.length;
    m.content = kept.length ? kept : [{ type: 'text', text: '…' }];
  }
  return n;
}

export class AiSession {
  messages: LlmMessage[] = [];
  /** Hash of the system prompt + tool set the history's thinking blocks were produced under (see stripThinking). */
  llmBinding?: string;
  cards = new Map<string, Card>();
  lastCards: Card[] = [];
  sets = new Map<string, PlacedSetInfo>();
  lastSetId?: string;
  finishes: { surface: string; label: string; finish: any }[] = [];
  prefs: { budgetBYN?: number; style?: string } = {};
  seenAmounts = new Set<number>();
  notes: string[] = [];
  turnSeq = 0;
  cardSeq = 0;
  busy = false;
  queue: { text: string; origin: 'text' | 'voice' }[] = [];
  lastSaveId?: string;
  /** Login under which UE stored the last save (save_project result.username); QA-035. */
  lastSaveUsername?: string;
  /** Visible conversation for the staff co-pilot view (CR-WEB-03). */
  transcript: { role: 'consultant' | 'visitor' | 'system'; text: string; at: string; staff?: boolean }[] = [];
  renders: string[] = [];
  /** renderIds already announced with ai.render capturing (QA-017: announce once). */
  announcedRenders = new Set<string>();
  /** QA-051: renderIds this session's own capture command issued and UE has not uploaded yet -> expiry (ms). Single use. */
  pendingRenders = new Map<string, number>();
  /** Whether the planner room has a window (render prompt light wording; most planner rooms have none). */
  roomHasWindow?: boolean;
  /** Security review: the pool hostToken this session was first started with (no takeover by another token). */
  hostToken?: string;
  /** v2.0: showroom (salon booths, catalogue) or constructor (room tools). */
  mode: Mode = 'showroom';
  /** v2.0: the salon booth in focus (UE booth_focus). */
  focus?: { boothId: string; productId?: string; collection?: string; label?: string };
  /** v2.0: the last booth state read or written (booth_get / booth_configure / booth_undo). */
  booth?: BoothState;
  /** P3-02: salon booths this visitor has been at (booth_focus / booth_get): a named collection's booth can be photographed. */
  seenBooths = new Map<string, { boothId: string; collection?: string; productId?: string; label?: string }>();
  offers = new Map<string, Offer>();
  /** the offer a verbal answer may still answer (only in the very next visitor turn) */
  pendingOffer?: Offer;
  /** constructor offers already made, per topic (no nagging) */
  offeredTopics = new Set<string>();
  /** booth_scope questions asked: boothId -> time */
  scopeAsked = new Map<string, number>();
  offerSeq = 0;
  greeted = false;
  /** an offer to emit after this turn's reply */
  turnOffer?: Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'>;
  /** CR-UE-03: carried configuration not placed yet (no room at entry) -> placed after build_room */
  pendingCarry?: SetConfig;
  /** enter_constructor in flight after consent: UE's planner_mode for it counts as consent, not HUD */
  entering = false;
  exiting = false;
  /** CR-UE-02 (v1.6): another visitor owns the shared planner on this server (PLANNER_BUSY, or get_state owner.isYou=false). */
  plannerBusy = false;
  /** The turn in which the busy state was last confirmed; within it no planner command is sent again. */
  plannerBusyTurn?: string;
  /** PLANNER_BUSY results (sent or held back) — lets runTool tell a busy failure from any other. */
  busyHits = 0;
  /** The turn whose reply already explains the busy planner (said once per turn). */
  busySaidTurn?: string;
  stats = { turns: 0, proposals: 0, cardsShown: 0, taps: 0, applied: 0, kept: 0, photos: 0, exports: 0, fallbacks: 0, guardrailHits: 0, llmCostUsd: 0 };
  constructor(
    public readonly sessionId: string,
    public readonly instanceUuid: string,
    public readonly username: string,
    public channel: CommandChannel,
    public io: SessionIO,
    mode: Mode = 'showroom',
  ) {
    this.mode = mode;
  }
}

export interface OrchestratorDeps {
  catalog: CatalogIndex | null;
  llm: LlmProvider;
  fallbackLlm: LlmProvider;
  stt: SttProvider;
  tts: TtsProvider;
  clips?: ClipStore;
  publicBaseUrl?: () => string;
  logDir?: string;
  llmTimeoutMs?: number;
  /** saveUsername = the `username` of the save_project result (UE game login, e.g. guest_tester), not the page identity. */
  onSaveProject?: (session: AiSession, saveId: string, saveUsername?: string) => Promise<void>;
  mockFlags?: Record<string, boolean>;
}

/** CR-UE-02: commands UE refuses with PLANNER_BUSY when another visitor owns the planner (consultant_summon only in mode planner). */
const PLANNER_GUARDED = new Set([
  'build_room',
  'add_opening',
  'apply_config',
  'configure_set',
  'swap_set',
  'remove_set',
  'finish_surface',
  'undo',
  'reset',
  'consultant_summon',
  'enter_constructor',
  // v2.4
  'move_set',
  'update_opening',
  'remove_opening',
]);
/** Not refused by UE, but while someone else owns the room they would photograph / save that visitor's project under this visitor's name. */
const PLANNER_OWNER_ONLY = new Set(['capture', 'save_project']);

export const PLANNER_BUSY_RU =
  'Конструктор сейчас занят другим посетителем на этом сервере, поэтому менять комнату я пока не могу. Можно немного подождать, пока он освободится, — а пока я могу показать подходящие комплекты карточками, без установки в комнату.';
const PLANNER_BUSY_PHOTO_RU = 'Сейчас в конструкторе проект другого посетителя, поэтому фото и досье сделаю, когда он освободится и мы соберём вашу ванную.';
const PLANNER_BUSY_CARDS_RU = 'Поставить комплект в комнату сейчас не получится — конструктор занят другим посетителем; карточки можно посмотреть и сравнить.';

function isGuarded(cmd: string, args: Record<string, any>) {
  return cmd === 'consultant_summon' ? args?.mode === 'planner' : PLANNER_GUARDED.has(cmd);
}

/** QA-056: two full configurations are the same set. */
function sameConfig(a: SetConfig, b: SetConfig) {
  const fa: any = fullConfig(a);
  const fb: any = fullConfig(b);
  return Object.keys({ ...fa, ...fb }).every((k) => fa[k] === fb[k]);
}

/** QA-051: how long an issued renderId waits for UE's upload (capture 20 s + page queue 30 s + upload). */
export const RENDER_PENDING_TTL_MS = Number(process.env.AI_RENDER_PENDING_TTL_MS ?? 120_000);

const STEP_RU: Record<string, string> = {
  get_state: 'Смотрю на комнату',
  build_room: 'Строю комнату',
  propose_sets: 'Проверяю, что помещается на стене',
  apply_card: 'Ставлю комплект',
  configure_set: 'Меняю комплект',
  swap_set: 'Меняю комплект',
  remove_set: 'Убираю комплект',
  finish_surface: 'Подбираю отделку',
  check_fit: 'Проверяю размеры',
  undo: 'Отменяю последнее изменение',
  reset_room: 'Начинаем сначала',
  save_project: 'Сохраняю проект',
  take_photo: 'Готовлю фото',
  consultant_summon: 'Иду к вам',
  catalog_lookup: 'Смотрю каталог',
  list_options: 'Смотрю варианты',
  move_set: 'Передвигаю комплект',
  add_opening: 'Добавляю проём',
  update_opening: 'Меняю проём',
  remove_opening: 'Убираю проём',
};

export function systemPrompt(catalog: CatalogIndex | null, mode: Mode = 'constructor'): string {
  return [
    mode === 'showroom'
      ? 'РЕЖИМ: САЛОН. Посетитель ходит по салону со стендами. Можно: рассказывать о каталоге (цены BYN, размеры, материалы, «цена уточняется»), подбирать комплекты как информацию (catalog_suggest), читать и настраивать стенд в фокусе (booth_get, booth_configure, booth_undo), фотографировать стенд в фокусе или названный (take_photo: чистый кадр из 3D, без ИИ). Нельзя: строить комнату, ставить и проверять мебель в комнате. Если разговор о размерах, «влезет ли», «в моей ванной», комнате или планировке — предложи Конструктор (offer_constructor), один раз на тему; переход только после ответа «да».'
      : 'РЕЖИМ: КОНСТРУКТОР. Посетитель в комнате-конструкторе: доступны инструменты комнаты и стендов. Вернуться в салон — exit_constructor.',
    `Ты — ${CONSULTANT_NAME}, женщина-консультант бренда Oliveeka (мебель для ванной) на выставке. Говори только по-русски, коротко (1–3 предложения), тепло и по делу, от первого лица в женском роде.`,
    'Цель: за пару минут помочь посетителю собрать ванную: узнать размер комнаты и бюджет, построить комнату (build_room), предложить три проверенных комплекта (propose_sets), применить выбор, уточнить (светлее, пенал, отделка), сделать фото (take_photo) и отправить досье (save_project).',
    'Правила:',
    '- Голосом озвучивается только начало ответа (5–10 секунд): первое предложение — короткий итог до 100 символов, без списков, артикулов и перечня цен и размеров; короткий вопрос в конце тоже звучит. Списки вариантов, размеры и цены пиши после итога — они видны в чате и на карточках.',
    '- Цены, артикулы, размеры и наличие бери только из результатов инструментов. Никогда не придумывай цены, скидки, акции, сроки изготовления или доставки. На вопросы о скидках, торге, доставке и сроках отвечай, что это решает менеджер салона.',
    '- Валюта только BYN. Не называй сумму, которой не было в результатах инструментов.',
    '- Предлагай только комплекты (тумба + столешница/раковина + смеситель, по желанию навесной шкаф), не отдельные предметы.',
    '- Изменения в комнате делай только инструментами; если инструмент вернул ошибку, объясни причину простыми словами и предложи вариант.',
    '- Поле say в результате инструмента — готовая подсказка для ответа; можно использовать её дословно.',
    '- Если инструмент вернул reasonCode PLANNER_BUSY: конструктор на этом сервере занят другим посетителем. Честно скажи это, предложи подождать или посмотреть комплекты карточками (propose_sets) без установки. Не повторяй команду в этом ходе и не пытайся изменить, сбросить или отменить чужую комнату.',
    '- Не обсуждай темы, не связанные с ванной комнатой.',
    // v2.4 (Phase 4): the manual actions, strictly inside the catalogue rules
    '- Части комплекта (размер тумбы, столешница, раковина, смеситель, зеркало, навесной шкаф и их цвета) бывают только такими, как в каталоге этой коллекции. Когда посетитель хочет другую раковину, смеситель, зеркало или столешницу, сначала вызови list_options (part) и выбирай только из полученных вариантов, передавая их id в option и colourId; не придумывай модели и цвета. Отдельная раковина бывает только с обычной столешницей.',
    mode === 'showroom'
      ? '- Стенд в фокусе: booth_configure умеет коллекцию, ширину, цвет, части (option/colourId), навесной шкаф, покраску RAL/NCS и её снятие (clearPaint), открыть/закрыть дверцы (doors).'
      : '- Комплект в комнате: configure_set (part/option/colourId, sizeCm, paintCode, clearPaint, doors); передвинуть — move_set: «левее/правее» так, как видит посетитель, стоя лицом к комплекту (по умолчанию 10 см, если сказано «чуть»), к краю стены (position start/end) или на другую стену (segmentId из get_state); двери и окна — add_opening / update_opening (сдвиг, размер, подоконник) / remove_opening; отделка — finish_surface, включая плинтус (baseboard), наличник проёма (opening_trim) и снятие отделки (clear). Если стена не ясна, спроси посетителя (опиши стены по окну/двери).',
    '',
    catalog ? catalog.summaryForPrompt() : 'Каталог ещё не синхронизирован: не называй цен.',
  ].join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('LLM_TIMEOUT')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** state.finishes (get_state/undo result) -> basket finishes. Keys: all_walls | floor | ceiling | wall_<segment>_<side>. */
/** UE get_state finish strings: "RAL 9010" / "S 0502-Y" (paint code), "#RRGGBB" (custom paint), "tile:<TileId>". */
export function parseFinish(f: any): any | null {
  if (f && typeof f === 'object') return f;
  if (typeof f !== 'string' || !f.trim()) return null;
  const s = f.trim();
  if (/^tile:/i.test(s)) return { type: 'tile', tileId: s.slice(5) };
  if (/^#[0-9a-f]{6,8}$/i.test(s)) return { type: 'paint', code: s };
  return { type: 'paint', system: /^S\s/.test(s) ? 'NCS' : 'RAL', code: s };
}

export function finishesFromState(f: Record<string, any>, tiles: { id: string; name: string }[]): { surface: string; label: string; finish: any }[] {
  const out: { surface: string; label: string; finish: any }[] = [];
  for (const [k, v0] of Object.entries(f ?? {})) {
    if (Array.isArray(v0)) {
      const surface = /wall/.test(k) ? 'стены' : /floor/.test(k) ? 'пол' : /ceil/.test(k) ? 'потолок' : /baseboard/.test(k) ? 'плинтус' : k;
      for (const e of v0) {
        const v = parseFinish(e?.finish ?? e);
        if (!v) continue;
        const label = v.type === 'tile' || v.tileId ? `плитка «${tiles.find((t) => t.id === v.tileId)?.name ?? v.tileId}»` : v.code ? `краска ${v.code}` : '';
        if (label && !out.some((o) => o.surface === surface && o.label === label)) out.push({ surface, label, finish: v });
      }
      continue;
    }
    const v = v0;
    if (!v || typeof v !== 'object') continue;
    const surface =
      k === 'all_walls'
        ? 'стены'
        : k === 'floor'
          ? 'пол'
          : k === 'ceiling'
            ? 'потолок'
            : k === 'baseboard'
              ? 'плинтус'
              : k.startsWith('trim_')
                ? 'наличник проёма'
                : k.startsWith('wall_')
                  ? `стена ${k.split('_')[1]}`
                  : k;
    const label = v.type === 'tile' ? `плитка «${tiles.find((t) => t.id === v.tileId)?.name ?? v.tileId}»` : v.code ? `краска ${v.code}` : JSON.stringify(v);
    out.push({ surface, label, finish: v });
  }
  return out;
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120);

export class Orchestrator {
  private clips: ClipStore;
  constructor(private deps: OrchestratorDeps) {
    this.clips = deps.clips ?? new ClipStore();
  }
  get catalog() {
    return this.deps.catalog;
  }
  setOnSaveProject(fn: OrchestratorDeps['onSaveProject']) {
    this.deps.onSaveProject = fn;
  }
  setCatalog(c: CatalogIndex | null) {
    this.deps.catalog = c;
  }

  // ── logging / analytics (task 9) ──────────────────────────────────────────
  log(s: AiSession, type: string, data: any) {
    const dir = this.deps.logDir ?? path.join(process.cwd(), 'data', 'ai_logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${safeName(s.sessionId)}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), sid: s.sessionId, user: s.username, type, ...data }) + '\n', 'utf8');
    } catch {
      /* logging never breaks a turn */
    }
  }

  async command(s: AiSession, cmd: string, args: Record<string, any>, origin: Origin, timeoutMs = 8000, turnId?: string): Promise<EnvelopeResult> {
    // v2.2 P3-02: a salon booth photo (capture preset booth) is not a room command: it never touches the planner.
    const boothCapture = cmd === 'capture' && args?.preset === 'booth';
    // v2.0: in the salon no room command is ever sent (UE would refuse NOT_IN_PLANNER).
    if (s.mode === 'showroom' && ROOM_COMMANDS.has(cmd) && !boothCapture) {
      this.log(s, 'mode_gate_blocked', { cmd, turnId });
      return { type: 'result', id: 'gated', cmd, ok: false, reasonCode: 'NOT_IN_PLANNER', reason: 'Это делается в Конструкторе', result: {}, state_rev: 0 } as EnvelopeResult;
    }
    if (cmd.startsWith('booth_') && !args.boothId && s.focus?.boothId) args = { ...args, boothId: s.focus.boothId };
    const guarded = isGuarded(cmd, args);
    if ((guarded || (PLANNER_OWNER_ONLY.has(cmd) && !boothCapture)) && s.plannerBusy) {
      const held = await this.plannerHeld(s, cmd, turnId);
      if (held) return held;
    }
    const req: EnvelopeRequest = { type: 'MaxiMallAI', id: newRequestId(), cmd, args, sessionId: s.sessionId, origin };
    const t0 = Date.now();
    const res = await s.channel.send(req, timeoutMs);
    this.log(s, 'command', { req, ok: res.ok, reasonCode: res.reasonCode, reason: res.reason, ms: Date.now() - t0, state_rev: res.state_rev });
    if (res.reasonCode === 'PLANNER_BUSY') {
      s.plannerBusy = true;
      s.plannerBusyTurn = turnId;
      s.busyHits++;
    } else if (res.ok && guarded) {
      s.plannerBusy = false;
    }
    if (res.ok) this.noteOwner(s, res.result, turnId);
    if (res.reasonCode === 'NOT_IN_PLANNER' && ROOM_COMMANDS.has(cmd) && s.mode === 'constructor') {
      // v2.0 bug signal: the backend thought the visitor was in «Конструктор», UE says no -> follow UE.
      this.log(s, 'not_in_planner_bug', { cmd, turnId });
      console.warn(`[AI] NOT_IN_PLANNER for ${cmd} while the session was in constructor mode (${s.sessionId}) — switching to showroom`);
      this.setMode(s, 'showroom', 'hud');
    }
    return res;
  }

  /** CR-UE-02: owner as UE reports it in state results (get_state, build_room, undo, reset). `active` is sent by UE besides the v1.6 `isYou`. */
  private noteOwner(s: AiSession, result: any, turnId?: string) {
    const o = result?.owner;
    if (!o || typeof o.isYou !== 'boolean') return;
    const busy = !o.isYou && o.active !== false;
    if (busy && !s.plannerBusy) s.plannerBusyTurn = turnId;
    s.plannerBusy = busy;
  }

  /** QA-050: decide a hold before any UI stage is emitted (a held command then is not sent by command() either). */
  private async ownerHold(s: AiSession, cmd: string, turnId: string): Promise<boolean> {
    return s.plannerBusy ? !!(await this.plannerHeld(s, cmd, turnId)) : false;
  }

  /**
   * CR-UE-02: the planner belongs to another visitor. Within the turn that found it busy nothing is sent again (no retry loop);
   * a later turn first takes one read-only look (get_state owner) and sends only if the planner is free now.
   * Returns a PLANNER_BUSY result that was NOT sent to UE, or null to go ahead.
   */
  private async plannerHeld(s: AiSession, cmd: string, turnId?: string): Promise<EnvelopeResult | null> {
    const turn = turnId ?? `ui-${Date.now()}`;
    if (s.plannerBusyTurn !== turn) {
      const st = await this.command(s, 'get_state', {}, 'ui', 8000, turn);
      if (st.ok && !(st.result?.owner && typeof st.result.owner.isYou === 'boolean')) s.plannerBusy = false; // UE without the owner field: UE decides
      if (!s.plannerBusy) return null;
      s.plannerBusyTurn = turn;
    }
    s.busyHits++;
    this.log(s, 'command_held', { cmd, reasonCode: 'PLANNER_BUSY', turnId: turn });
    return { type: 'result', id: 'held', cmd, ok: false, reasonCode: 'PLANNER_BUSY', reason: 'Конструктор занят другим посетителем (команда не отправлялась)', result: {} } as EnvelopeResult;
  }

  // ── speech ────────────────────────────────────────────────────────────────
  /**
   * P3-05 (v2.2): the 5–10 s spoken summary of a reply (speech.ts). It may only repeat BYN figures of the full text and
   * passes the same guard rules (discounts, dates) sentence by sentence; anything dropped leaves the safe pointer.
   */
  spokenFor(text: string): string {
    const sum = spokenSummary(text).text;
    if (!sum) return '';
    const g = guardReply(sum, moneyAmounts(text), SPOKEN_FALLBACK_RU);
    return g.text;
  }

  async say(s: AiSession, text: string, turnId: string, gesture?: { kind: string; id?: string }, staff = false) {
    let audioUrl: string | undefined;
    let durationMs: number | undefined;
    const spokenText = this.spokenFor(text);
    this.log(s, 'say', { turnId, chars: text.length, spokenChars: spokenText.length, spokenSecEst: estimateSpokenSeconds(spokenText), spokenText });
    try {
      // v2.0: a clip the BROWSER plays (WAV around the PCM, or MP3 from a live TTS); the 3D consultant is gone.
      // v2.2: the audio contains only the spoken summary; the chat shows the full text.
      const audio = await this.deps.tts.synthesize(spokenText || text, s.sessionId);
      const clip = this.clips.saveAudio(audio, this.deps.tts.audioFormat ?? 'pcm_24000');
      durationMs = clip.durationMs;
      audioUrl = `${this.deps.publicBaseUrl?.() ?? ''}/api/ai/clips/${clip.clipId}.${clip.ext}`;
    } catch (e: any) {
      this.log(s, 'tts_error', { message: e.message });
    }
    s.transcript.push({ role: 'consultant', text, at: new Date().toISOString(), ...(staff ? { staff: true } : {}) });
    // QA-044: the reply is delivered -> the thinking indicator stops (the voice command may still wait for the room).
    s.io.emit('ai.thinking', { turnId, on: false });
    s.io.emit('ai.message', { turnId, role: 'consultant', text });
    s.io.emit('ai.say', { turnId, text, spokenText, ...(audioUrl ? { audioUrl, durationMs } : {}) });
    void gesture; // v2.0: no 3D consultant (consultant_say is never sent)
  }

  /** A page-button tool answered by the consultant (outside a visitor turn): its say, then an offer the tool queued (buttons). */
  async sayUiOutcome(s: AiSession, say: string, turnId: string) {
    const o = s.mode === 'showroom' ? s.turnOffer : undefined;
    s.turnOffer = undefined;
    await this.say(s, o ? `${say} ${o.text}` : say, turnId);
    if (o) await this.presentOffer(s, o, turnId, false);
  }

  async greet(s: AiSession) {
    s.greeted = true;
    if (s.mode === 'constructor') return this.say(s, GREETING_RU, 't-0');
    await this.say(s, GREETING_SHOWROOM_RU, 't-0');
    if (s.focus?.boothId) await this.askBoothScope(s, 't-0');
  }

  /** CR-UE-03: the configuration carried from the salon, placed once the room exists (fit-checked first). */
  private async placeCarry(s: AiSession, origin: Origin, turnId: string): Promise<string> {
    const c = this.catalog;
    const cfg = s.pendingCarry;
    s.pendingCarry = undefined;
    if (!cfg || !c) return '';
    const title = boothTitle(c, cfg);
    const fit = await this.command(s, 'check_fit', { candidates: [{ key: 'carry', config: cfg }] }, origin, 8000, turnId);
    const res = fit.result?.results?.[0];
    if (!fit.ok || !res?.fits || !res.placement) return `${title} на стенах этой комнаты не помещается — подберу другой вариант, если хотите.`;
    const r = await this.command(s, 'apply_config', { config: cfg, placement: { segmentId: res.placement.segmentId, side: res.placement.side, offsetCm: res.placement.offsetCm } }, origin, 8000, turnId);
    if (!r.ok) return `Не получилось поставить ${title}: ${r.reason ?? r.reasonCode}.`;
    const setId = r.result?.setId ?? `set-${Date.now()}`;
    s.sets.set(setId, { setId, config: fullConfig(cfg), title });
    s.lastSetId = setId;
    s.stats.applied++;
    this.emitBasket(s);
    const q = c.quote(cfg);
    s.seenAmounts.add(q.total);
    return `Поставила ${title} — ${q.total} BYN${q.estimated ? ' (цена уточняется)' : ''}.`;
  }

  /** v2.1 CR-WEB-04: «Показать в комнате» on a salon info card -> the constructor offer for that card (never entering directly). */
  async handleCardShow(s: AiSession, cardId: string) {
    const card = s.cards.get(cardId);
    const turnId = `t-${s.turnSeq}`;
    if (!card) {
      this.log(s, 'card_show_unknown', { cardId });
      return;
    }
    s.transcript.push({ role: 'visitor', text: `Показать в комнате: ${card.title}`, at: new Date().toISOString() });
    this.log(s, 'card_show', { cardId });
    if (s.mode === 'constructor') return this.say(s, `Мы уже в Конструкторе — скажите размер комнаты, и я подберу и поставлю ${card.title}.`, turnId);
    s.offeredTopics.add(`card:${cardId}`);
    await this.presentOffer(s, { kind: 'constructor', text: `Могу показать «${card.title}» в реальных размерах в комнате нашего Конструктора. Перейдём?`, options: OFFER_CONSTRUCTOR_OPTIONS, topic: `card:${cardId}`, carry: card.config, cardId }, turnId);
  }

  // ── v2.0: modes, offers, booth dialogue ──────────────────────────────────
  emitMode(s: AiSession, reason: 'consent' | 'hud' | 'exit' | 'start') {
    s.io.emit('ai.mode', { mode: s.mode, reason, ...(s.focus?.boothId ? { boothId: s.focus.boothId } : {}) });
  }

  setMode(s: AiSession, mode: Mode, reason: 'consent' | 'hud' | 'exit' | 'start') {
    if (s.mode === mode) return;
    s.mode = mode;
    for (const o of s.offers.values()) if (o.kind === 'constructor') o.open = false;
    if (s.pendingOffer?.kind === 'constructor') s.pendingOffer = undefined;
    s.notes.push(mode === 'constructor' ? '[событие] Посетитель перешёл в Конструктор (комната).' : '[событие] Посетитель вернулся в салон.');
    this.log(s, 'mode', { mode, reason });
    this.emitMode(s, reason);
  }

  /** UE events forwarded by the page (ai.ue.event): planner_mode (HUD entry/exit), booth_focus. */
  async onUeEvent(s: AiSession, e: { event?: string; data?: any }) {
    if (e?.event === 'planner_mode' && typeof e.data?.inPlanner === 'boolean') {
      this.setMode(s, e.data.inPlanner ? 'constructor' : 'showroom', e.data.inPlanner && s.entering ? 'consent' : !e.data.inPlanner && s.exiting ? 'exit' : 'hud');
    } else if (e?.event === 'booth_focus') {
      const d = e.data ?? {};
      const boothId = typeof d.boothId === 'string' ? d.boothId : '';
      if (!boothId) {
        s.focus = undefined;
        return;
      }
      const cur = s.focus;
      this.noteBooth(s, { boothId, productId: d.productId, collection: d.collection ?? (d.productId && this.catalog ? collectionOf(this.catalog, d.productId) : undefined), label: d.label });
      if (cur && cur.boothId === boothId) {
        // CR-UE-03: re-sent when the focused booth's product changes -> update, no new question
        s.focus = { boothId, productId: d.productId ?? cur.productId, collection: d.collection ?? cur.collection, label: d.label ?? cur.label };
        const b = s.booth;
        if (b && b.boothId === boothId && d.productId && b.productId !== d.productId) s.booth = undefined;
        return;
      }
      s.focus = { boothId, productId: d.productId, collection: d.collection ?? (d.productId && this.catalog ? collectionOf(this.catalog, d.productId) : undefined), label: d.label };
      if (s.booth?.boothId !== boothId) s.booth = undefined;
      this.log(s, 'booth_focus', s.focus);
      const last = s.scopeAsked.get(boothId) ?? 0;
      if (s.mode === 'showroom' && s.greeted && Date.now() - last > 10 * 60_000) await this.askBoothScope(s, `t-${s.turnSeq}`);
    }
  }

  private newOffer(s: AiSession, o: Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'>): Offer {
    const offer: Offer = { ...o, offerId: `of-${s.turnSeq}-${++s.offerSeq}`, validTurn: s.turnSeq + 1, createdAt: Date.now(), open: true };
    s.offers.set(offer.offerId, offer);
    if (s.offers.size > 30) s.offers.delete(s.offers.keys().next().value as string);
    return offer;
  }

  /** Say the offer text (unless it was part of a reply already) and show its buttons. */
  private async presentOffer(s: AiSession, o: Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'>, turnId: string, speak = true) {
    if (speak) await this.say(s, o.text, turnId);
    const offer = this.newOffer(s, o);
    s.pendingOffer = offer;
    s.io.emit('ai.offer', { offerId: offer.offerId, kind: offer.kind, text: offer.text, options: offer.options });
    this.log(s, 'offer', { offerId: offer.offerId, kind: offer.kind, topic: offer.topic, boothId: offer.boothId });
    return offer;
  }

  /**
   * The constructor topic: dimensions / fitting / room / layout is ONE topic per booth in focus (QA «offer once»: further
   * size, room or depth questions do not bring a second offer). `specific` only picks the wording: «эту модель» when an
   * item (the booth in focus, a named collection) is what the visitor asks about, the general form for a room / layout.
   */
  private constructorTopic(s: AiSession, text: string): { key: string; specific: boolean } {
    const t = text.toLowerCase().replace(/ё/g, 'е');
    const col = collectionFromText(text);
    const aboutItem = /(тумб|модел|комплект|шкаф|пенал|раковин|эт[уоа]|е[её](?![а-я])|он[аи]?(?![а-я])|влез|помест|впиш|габарит)/.test(t) || !!col;
    return { key: `fit:${s.focus?.boothId ?? 'none'}`, specific: aboutItem && (!!s.focus?.boothId || !!col) };
  }

  /** One constructor offer per topic (unless the visitor asked for it); queued to follow this turn's reply. */
  private queueConstructorOffer(s: AiSession, topic: string, force: boolean, specific = false) {
    if (s.mode !== 'showroom') return false;
    if (!force && s.offeredTopics.has(topic)) return false;
    s.offeredTopics.add(topic);
    const boothId = specific && topic === `fit:${s.focus?.boothId}` ? s.focus?.boothId : undefined;
    s.turnOffer = { kind: 'constructor', text: specific ? OFFER_CONSTRUCTOR_MODEL_RU : OFFER_CONSTRUCTOR_RU, options: OFFER_CONSTRUCTOR_OPTIONS, topic, ...(boothId ? { boothId } : {}) };
    return true;
  }

  /** P3-02: remember a salon booth the visitor has been at (its collection may change: booth_configure / booth_focus re-send). */
  private noteBooth(s: AiSession, b: { boothId: string; collection?: string; productId?: string; label?: string }) {
    if (!b.boothId) return;
    const prev = s.seenBooths.get(b.boothId);
    s.seenBooths.set(b.boothId, { boothId: b.boothId, collection: b.collection ?? prev?.collection, productId: b.productId ?? prev?.productId, label: b.label ?? prev?.label });
  }

  /**
   * P3-02 (contracts v2.2): the salon photo = the clean UE capture of a booth with its dedicated camera (capture preset
   * "booth"; the render service emits it as the final photo, no AI render, no paid call). Target: the booth named by
   * collection (one the visitor has been at), else the booth in focus. Without one: an honest answer + the Constructor offer.
   */
  private async boothPhoto(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const named = typeof input?.collection === 'string' && input.collection.trim() ? collectionFromText(input.collection) ?? input.collection.trim() : undefined;
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    let target: { boothId: string; collection?: string } | undefined = s.focus?.boothId ? { boothId: s.focus.boothId, collection: s.focus.collection } : undefined;
    if (named && !same(target?.collection, named)) {
      const seen = [...s.seenBooths.values()].reverse().find((b) => same(b.collection, named));
      if (!seen) {
        this.log(s, 'booth_photo_no_booth', { named, focus: s.focus?.boothId ?? null });
        return { ok: false, reasonCode: 'NO_BOOTH', say: `Стенд ${named} сейчас не рядом с вами. Подойдите к нему или откройте его настройки — и я его сфотографирую.` };
      }
      target = seen;
    }
    if (!target) {
      this.log(s, 'booth_photo_no_booth', { named: named ?? null, focus: null });
      s.offeredTopics.add('room:photo');
      s.turnOffer = { kind: 'constructor', text: BOOTH_PHOTO_OFFER_RU, options: OFFER_CONSTRUCTOR_OPTIONS, topic: 'room:photo' };
      return { ok: false, reasonCode: 'NO_BOOTH', say: BOOTH_PHOTO_NO_FOCUS_RU };
    }
    const renderId = `rn-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    s.announcedRenders.add(renderId);
    s.pendingRenders.set(renderId, Date.now() + RENDER_PENDING_TTL_MS);
    s.io.emit('ai.render', { renderId, stage: 'capturing' });
    const r = await this.command(s, 'capture', { renderId, preset: 'booth', boothId: target.boothId, sessionId: s.sessionId }, origin, 20000, turnId);
    if (!r.ok) {
      s.pendingRenders.delete(renderId);
      s.io.emit('ai.render', { renderId, stage: 'failed', reason: r.reason ?? r.reasonCode });
      const say =
        r.reasonCode === 'NO_BOOTH'
          ? 'Этот стенд сейчас не нашёлся — подойдите к нему ещё раз, и я его сфотографирую.'
          : r.reasonCode === 'BAD_ARGS' && s.mode !== 'showroom'
            ? 'Фото стенда делается в салоне.'
            : 'Фото стенда не получилось, попробуем ещё раз.';
      return { ok: false, reasonCode: r.reasonCode, say };
    }
    s.renders.push(renderId);
    s.stats.photos++;
    const col = target.collection ?? s.seenBooths.get(target.boothId)?.collection;
    return { ok: true, renderId, boothId: target.boothId, say: `Фотографирую стенд${col ? ` ${col}` : ''} — снимок появится на экране через пару секунд.` };
  }

  async askBoothScope(s: AiSession, turnId: string) {
    const f = s.focus;
    if (!f?.boothId) return;
    const collection = f.collection ?? 'эта';
    s.scopeAsked.set(f.boothId, Date.now());
    await this.presentOffer(s, { kind: 'booth_scope', text: scopeQuestionRu(collection), options: scopeOptions(collection), boothId: f.boothId }, turnId);
  }

  /** booth_get for the booth in focus (or boothId); caches the state. */
  private async readBooth(s: AiSession, boothId: string | undefined, origin: Origin, turnId: string): Promise<{ st?: BoothState; say?: string; reasonCode?: string }> {
    const r = await this.command(s, 'booth_get', boothId ? { boothId } : {}, origin, 8000, turnId);
    if (!r.ok || !r.result?.productId) return { say: r.reasonCode === 'NO_BOOTH' || !r.ok ? NO_BOOTH_RU : 'Не получилось прочитать стенд.', reasonCode: r.reasonCode ?? 'NO_BOOTH' };
    const st = r.result as BoothState;
    s.booth = st;
    this.noteBooth(s, { boothId: st.boothId, productId: st.productId, collection: st.collection ?? (this.catalog ? collectionOf(this.catalog, st.productId) : undefined), label: st.label });
    if (s.focus?.boothId === st.boothId || !s.focus) s.focus = { boothId: st.boothId, productId: st.productId, collection: st.collection ?? (this.catalog ? collectionOf(this.catalog, st.productId) : undefined), label: st.label };
    return { st };
  }

  /** «Эту коллекцию»: this booth's real options. */
  private async boothScopeThis(s: AiSession, origin: Origin, turnId: string): Promise<string> {
    const c = this.catalog;
    if (!c) return 'Каталог сейчас недоступен.';
    const { st, say } = await this.readBooth(s, s.focus?.boothId, origin, turnId);
    if (!st) return say!;
    const d = describeBoothOptions(c, st);
    d.amounts.forEach((a) => s.seenAmounts.add(a));
    return d.say;
  }

  /** «Другие коллекции»: which collection to put on the booth instead. */
  private collectionPickOffer(s: AiSession): Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'> | null {
    const c = this.catalog;
    const cur = s.booth?.productId ?? s.focus?.productId;
    const curCol = s.focus?.collection ?? (cur && c ? collectionOf(c, cur) : 'этой');
    if (!c) return null;
    const options = c
      .listProducts()
      .filter((p) => p.productId !== cur && c.isCollectionEnabled(p.collection ?? '') && (!s.booth?.products?.length || s.booth.products.includes(p.productId)))
      .map((p) => ({ id: p.collection ?? p.productId, label: p.collection ?? p.productId }));
    return { kind: 'collection_pick', text: pickQuestionRu(curCol), options, boothId: s.focus?.boothId };
  }

  /** v2.0 booth_configure from a semantic request (tool input or a button). */
  private async boothConfigure(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    if (!c) return { ok: false, say: 'Каталог сейчас недоступен.' };
    let st = s.booth && (!input.boothId || input.boothId === s.booth.boothId) && (!s.focus || s.focus.boothId === s.booth.boothId) ? s.booth : undefined;
    if (!st) {
      const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
      if (!r.st) return { ok: false, reasonCode: r.reasonCode, say: r.say };
      st = r.st;
    }
    const plan = planBoothChange(c, st, input);
    if (plan.kind === 'say') return { ok: plan.ok, ...(plan.noChange ? { noChange: true } : {}), say: plan.say };
    const before = fullConfig(st.config);
    const r = await this.command(s, 'booth_configure', { boothId: st.boothId, ...plan.args }, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: `Не получилось изменить стенд: ${r.reason ?? r.reasonCode}.` };
    const after: BoothState = r.result?.productId ? (r.result as BoothState) : { ...st, config: fullConfig({ ...st.config, ...(plan.args.config ?? {}) }) };
    s.booth = after;
    this.noteBooth(s, { boothId: after.boothId, productId: after.productId, collection: after.collection ?? collectionOf(c, after.productId), label: after.label });
    if (s.focus?.boothId === after.boothId) s.focus = { ...s.focus, productId: after.productId, collection: after.collection ?? collectionOf(c, after.productId) };
    const same = after.productId === before.productId && JSON.stringify(fullConfig(after.config)) === JSON.stringify(before);
    const extrasOnly = !plan.args.config && !plan.args.productId && (plan.args.doors || plan.args.clearCustomColour);
    if (same && !plan.args.customColour && !extrasOnly) return { ok: false, noChange: true, say: 'Изменение не применилось — стенд остался прежним.' };
    // v2.4: never claim doors / a cleared colour UE did not apply (its boothState carries both)
    const doorsWanted = plan.args.doors ? (Object.entries(plan.args.doors)[0] as [string, string]) : undefined;
    if (doorsWanted && after.doors && after.doors[doorsWanted[0] as 'cabinet' | 'closet'] !== doorsWanted[1]) {
      return { ok: false, noChange: true, say: 'Дверцы не получилось переключить — стенд остался прежним.' };
    }
    if (plan.args.clearCustomColour && (after.customColours ?? []).some((x) => x.component === plan.args.clearCustomColour)) {
      return { ok: false, noChange: true, say: 'Покраску снять не получилось — стенд остался прежним.' };
    }
    if (plan.args.customColour) {
      // QA-074: confirm a RAL/NCS repaint only when the booth shows that colour (result, else a fresh booth_get)
      const want = plan.args.customColour;
      const norm = (x?: string) => String(x ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
      const has = (b?: BoothState) => (b?.customColours ?? []).some((x) => x.component === want.component && norm(x.code) === norm(want.code));
      let applied = has(after);
      if (!applied) {
        const fresh = await this.readBooth(s, after.boothId, origin, turnId);
        applied = has(fresh.st);
        if (fresh.st) s.booth = fresh.st;
      }
      if (!applied) {
        this.log(s, 'paint_not_applied', { boothId: after.boothId, customColour: want });
        return { ok: false, noChange: true, say: `Покрасить в ${want.code} не получилось — цвет на стенде не применился. Можно выбрать цвет из коллекции или другой код RAL/NCS.` };
      }
    }
    const q = c.quote(after.config);
    s.seenAmounts.add(q.total);
    return { ok: true, boothId: after.boothId, say: `${plan.what}. Сейчас на стенде — ${boothTitle(c, after.config, after.customColours)}, ${boothPrice(q.total, q.estimated, after.customColours)}.` };
  }

  /** Consent given (button or verbal yes): enter «Конструктор», carrying the focused booth's config when the topic was that booth. */
  private async acceptConstructor(s: AiSession, offer: Offer, origin: Origin, turnId: string): Promise<string> {
    offer.open = false;
    let carry: SetConfig | undefined = offer.carry ? fullConfig(offer.carry) : undefined;
    if (!carry && offer.boothId && s.focus?.boothId === offer.boothId) {
      const st = s.booth?.boothId === offer.boothId ? s.booth : (await this.readBooth(s, offer.boothId, origin, turnId)).st;
      if (st) carry = fullConfig(st.config);
    }
    const hits = s.busyHits;
    s.entering = true;
    const r = await this.command(s, 'enter_constructor', carry ? { carryConfig: carry } : {}, origin, 15000, turnId).finally(() => (s.entering = false));
    if (!r.ok) {
      if (s.busyHits !== hits || r.reasonCode === 'PLANNER_BUSY') return 'Конструктор сейчас занят другим посетителем на этом сервере. Можно немного подождать — а пока продолжим в салоне.';
      return `Не получилось открыть Конструктор: ${r.reason ?? r.reasonCode}. Попробуйте кнопку «Конструктор» внизу экрана.`;
    }
    this.setMode(s, 'constructor', 'consent');
    const sets = Array.isArray(r.result?.sets) ? (r.result.sets as any[]) : [];
    for (const x of sets) if (x?.setId && x.config?.productId) s.sets.set(x.setId, { setId: x.setId, config: fullConfig(x.config), title: this.titleFor(x.config) });
    if (sets.length) {
      s.lastSetId = sets[sets.length - 1].setId;
      this.emitBasket(s);
    }
    // CR-UE-03: result.carry = {placed, setId, …} or {placed:false, reasonCode:"NO_ROOM"} (then the AI places it after build_room)
    const carryRes = r.result?.carry;
    const carried = !!carry && (carryRes?.placed === true || (carryRes === undefined && sets.some((x) => x?.config?.productId === carry!.productId)));
    if (carried && carryRes?.setId && !s.sets.has(carryRes.setId)) {
      s.sets.set(carryRes.setId, { setId: carryRes.setId, config: fullConfig(carry!), title: this.titleFor(carry!) });
      s.lastSetId = carryRes.setId;
      this.emitBasket(s);
    }
    if (carry && !carried) s.pendingCarry = fullConfig(carry);
    const title = carry && this.catalog ? boothTitle(this.catalog, carry) : '';
    if (carried) return `Перешли в Конструктор и поставили в комнату ${title}. Можно поменять размер комнаты, отделку или сделать фото.`;
    return `Перешли в Конструктор. Какого размера ваша ванная? Например, «2 на 2,5 метра»${carry ? ` — и я сразу поставлю ${title}` : ''}.`;
  }

  /** Buttons under a message (ai.offer.answer). Runs outside a visitor turn. */
  async handleOfferAnswer(s: AiSession, offerId: string, optionId: string) {
    const offer = s.offers.get(offerId);
    const turnId = `t-${s.turnSeq}`;
    // QA pointer 2: a tap is never ignored silently.
    if (!offer) {
      this.log(s, 'offer_unknown', { offerId, optionId });
      await this.say(s, 'Этот вопрос уже неактуален. Скажите, пожалуйста, что вы хотите сделать — я помогу.', turnId);
      return;
    }
    if (!offer.open || Date.now() - offer.createdAt > OFFER_TTL_MS) {
      this.log(s, 'offer_late', { offerId, kind: offer.kind, optionId });
      if (offer.kind === 'constructor' && optionId === 'yes' && s.mode === 'constructor') {
        await this.say(s, 'Мы уже в Конструкторе.', turnId);
        return;
      }
      // a «Да, перейти» tap is explicit consent while the visitor is still in the salon (any age); booth buttons act only
      // while that booth is still in focus
      if ((offer.kind === 'booth_scope' || offer.kind === 'collection_pick') && offer.boothId && s.focus?.boothId !== offer.boothId) {
        await this.say(s, 'Этот стенд уже не в фокусе — подойдите к нему снова или откройте его настройки, и продолжим.', turnId);
        return;
      }
    }
    const label = offer.options.find((o) => o.id === optionId)?.label ?? optionId;
    s.transcript.push({ role: 'visitor', text: label, at: new Date().toISOString() });
    s.notes.push(`[событие] Посетитель нажал «${label}».`);
    this.log(s, 'offer_answer', { offerId, kind: offer.kind, optionId });
    offer.open = false;
    if (s.pendingOffer === offer) s.pendingOffer = undefined;
    await this.answerOffer(s, offer, optionId, 'ui', turnId);
  }

  private async answerOffer(s: AiSession, offer: Offer, optionId: string, origin: Origin, turnId: string): Promise<void> {
    if (offer.kind === 'constructor') {
      if (optionId === 'yes') await this.say(s, await this.acceptConstructor(s, offer, origin, turnId), turnId);
      else await this.say(s, STAY_RU, turnId);
    } else if (offer.kind === 'booth_scope') {
      if (optionId === 'this') await this.say(s, await this.boothScopeThis(s, origin, turnId), turnId);
      else {
        const o = this.collectionPickOffer(s);
        if (o) await this.presentOffer(s, o, turnId);
      }
    } else if (offer.kind === 'collection_pick') {
      const out = await this.boothConfigure(s, { collection: optionId }, origin, turnId);
      await this.say(s, out.say, turnId);
    }
  }

  /** v2.0 consent / offer handling at the start of a visitor turn. Returns true when the turn was fully answered. */
  private async preTurn(s: AiSession, text: string, turnNo: number, turnId: string): Promise<{ handled: boolean; reply?: string; offer?: Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'> }> {
    const pend = s.pendingOffer;
    s.pendingOffer = undefined;
    if (pend && pend.open && pend.validTurn === turnNo) {
      if (pend.kind === 'constructor') {
        if (isVerbalYes(text)) return { handled: true, reply: await this.acceptConstructor(s, pend, 'model', turnId) };
        pend.open = false; // anything else is a no
        this.log(s, 'offer_declined', { offerId: pend.offerId, text: text.slice(0, 80) });
        if (isVerbalNo(text)) return { handled: true, reply: STAY_RU };
      } else if (pend.kind === 'booth_scope') {
        const a = boothScopeAnswer(text);
        if (a) {
          pend.open = false;
          if (a === 'this') return { handled: true, reply: await this.boothScopeThis(s, 'model', turnId) };
          const o = this.collectionPickOffer(s);
          if (o) return { handled: true, reply: o.text, offer: o };
        }
      } else if (pend.kind === 'collection_pick') {
        const col = collectionFromText(text);
        if (col && pend.options.some((o) => o.id === col)) {
          pend.open = false;
          const out = await this.boothConfigure(s, { collection: col }, 'model', turnId);
          return { handled: true, reply: out.say };
        }
      }
    }
    // CR-WEB-04 fallback: «Покажи в комнате: <card title>» -> the offer for that card
    if (s.mode === 'showroom') {
      const m = /^покажи(те)? в комнате:\s*(.+)$/i.exec(text.trim());
      const card = m ? s.lastCards.find((k) => k.title.toLowerCase() === m[2].trim().toLowerCase()) : undefined;
      if (card) {
        const o = { kind: 'constructor' as const, text: `Могу показать «${card.title}» в реальных размерах в комнате нашего Конструктора. Перейдём?`, options: OFFER_CONSTRUCTOR_OPTIONS, topic: `card:${card.cardId}`, carry: card.config, cardId: card.cardId };
        s.offeredTopics.add(o.topic);
        return { handled: true, reply: o.text, offer: o };
      }
    }
    // QA-077: leaving the Constructor by voice / text -> exit_constructor (deterministic)
    if (s.mode === 'constructor' && isExitRequest(text)) {
      s.exiting = true;
      const r = await this.command(s, 'exit_constructor', {}, 'model', 8000, turnId).finally(() => (s.exiting = false));
      if (!r.ok) return { handled: true, reply: `Не получилось выйти из Конструктора: ${r.reason ?? r.reasonCode}.` };
      this.setMode(s, 'showroom', 'exit');
      return { handled: true, reply: 'Вернулись в салон. Подойдите к любому стенду — расскажу о нём и настрою под вас.' };
    }
    // QA-080: a fit / size question in the salon is INFORMATIONAL: an honest answer from catalogue dimensions, never a booth
    // change; the constructor offer once per topic, afterwards only a short hint without buttons.
    if (s.mode === 'showroom' && (isFitQuestion(text) || (text.includes('?') && !!parseRoomSize(text))) && !isExplicitConstructorRequest(text)) {
      const c = this.catalog;
      if (c) {
        const answer = fitAnswer(c, s.booth?.config ?? (s.focus?.productId ? { productId: s.focus.productId, sizeIndex: 0, colourIndex: 0 } : undefined), text, parseRoomSize(text));
        const topic = `fit:${s.focus?.boothId ?? 'none'}`;
        this.log(s, 'fit_answer', { topic, offered: s.offeredTopics.has(topic) });
        if (s.offeredTopics.has(topic)) return { handled: true, reply: `${answer} ${FIT_HINT_RU}` };
        s.offeredTopics.add(topic);
        const specific = !!s.focus?.boothId || !!collectionFromText(text);
        const o = { kind: 'constructor' as const, text: specific ? OFFER_CONSTRUCTOR_MODEL_RU : OFFER_CONSTRUCTOR_RU, options: OFFER_CONSTRUCTOR_OPTIONS, topic, ...(specific && s.focus?.boothId ? { boothId: s.focus.boothId } : {}) };
        return { handled: true, reply: `${answer} ${o.text}`, offer: o };
      }
    }
    // v2.2 P3-02: a photo of a salon booth is taken right here (the booth in focus or a named one); without a booth an
    // honest answer + the Constructor offer. A photo of the room / the bathroom and the dossier stay in the Constructor.
    if (s.mode === 'showroom' && isBoothPhotoRequest(text)) {
      const out = await this.runTool(s, 'take_photo', { collection: collectionFromText(text) }, 'model', turnId);
      const o = s.turnOffer;
      s.turnOffer = undefined;
      return { handled: true, reply: o ? `${out.say} ${o.text}` : out.say, ...(o ? { offer: o } : {}) };
    }
    // QA-077: a room action asked for in the salon -> the honest constructor offer (the visitor asked: offered even if offered before)
    if (s.mode === 'showroom' && !isExplicitConstructorRequest(text) && !isFitTopic(text.replace(/(комнат[а-я]*|санузел)/gi, '')) ) {
      const kind = isRoomAction(text);
      if (kind) {
        s.offeredTopics.add(`fit:${s.focus?.boothId ?? 'none'}`);
        const o = { kind: 'constructor' as const, text: kind === 'photo' ? PHOTO_OFFER_RU : ROOM_OFFER_RU, options: OFFER_CONSTRUCTOR_OPTIONS, topic: `room:${kind}` };
        return { handled: true, reply: o.text, offer: o };
      }
    }
    // WEB finding: another collection for the booth in focus, at any time -> «Какую коллекцию поставить вместо X?»
    if (s.mode === 'showroom' && s.focus?.boothId && wantsOtherCollection(text)) {
      const o = this.collectionPickOffer(s);
      if (o) return { handled: true, reply: o.text, offer: o };
    }
    // QA pointer 1: the visitor's own explicit request to go is consent -> move now (carry the booth only when the request is about it).
    if (s.mode === 'showroom' && isExplicitConstructorRequest(text)) {
      const aboutBooth = !!s.focus?.boothId && /(эт[уоа]|е[её]|тумб|модел|стенд|комплект|коллекци)/.test(text.toLowerCase().replace(/ё/g, 'е'));
      const consent: Offer = { offerId: 'request', kind: 'constructor', text: '', options: OFFER_CONSTRUCTOR_OPTIONS, topic: 'request', ...(aboutBooth ? { boothId: s.focus!.boothId } : {}), validTurn: turnNo, createdAt: Date.now(), open: true };
      this.log(s, 'consent_request', { text: text.slice(0, 80), carryBooth: aboutBooth });
      return { handled: true, reply: await this.acceptConstructor(s, consent, 'model', turnId) };
    }
    // Constructor topic in the salon: one offer per topic (or whenever the visitor asks), after this turn's answer.
    if (s.mode === 'showroom') {
      const asks = asksForConstructor(text);
      if (asks || isFitTopic(text)) {
        const tp = this.constructorTopic(s, text);
        this.queueConstructorOffer(s, tp.key, asks, tp.specific);
      }
      else if (/(фото|сфотограф|снимок|досье|pdf|пдф|сохрани|пришли|отправ)/i.test(text)) this.queueConstructorOffer(s, `fit:${s.focus?.boothId ?? 'none'}`, false);
      if (asks && !isFitTopic(text.replace(/конструктор[а-я]*/gi, ''))) {
        const o = s.turnOffer;
        s.turnOffer = undefined;
        if (o) return { handled: true, reply: o.text, offer: o };
      }
    }
    return { handled: false };
  }

  // ── basket ────────────────────────────────────────────────────────────────
  basket(s: AiSession) {
    const items = [...s.sets.values()].map((set) => {
      const q = this.catalog?.quote(set.config);
      q?.lines.forEach((l) => s.seenAmounts.add(l.price));
      if (q) s.seenAmounts.add(q.total);
      return {
        setId: set.setId,
        title: set.title,
        price: q?.total ?? 0,
        lines: (q?.lines ?? []).map((l) => ({ component: l.component, articleCode: l.articleCode, name: l.name, price: l.price, ...(l.estimated ? { estimated: true } : {}), ...(l.unpriced ? { unpriced: true } : {}) })),
      };
    });
    const total = Math.round(items.reduce((a, i) => a + i.price, 0) * 100) / 100;
    s.seenAmounts.add(total);
    return { items, finishes: s.finishes.map((f) => ({ surface: f.surface, label: f.label })), total, currency: 'BYN' as const };
  }
  emitBasket(s: AiSession) {
    const b = this.basket(s);
    this.log(s, 'basket', { items: b.items.map((i) => ({ setId: i.setId, title: i.title, price: i.price })), total: b.total, finishes: b.finishes });
    s.io.emit('ai.basket', b);
  }

  private titleFor(cfg: SetConfig) {
    const c = this.catalog;
    const p = c?.getProduct(cfg.productId);
    const closet = (cfg.closetSizeIndex ?? -1) >= 0 ? ', с навесным шкафом' : '';
    return `${p?.collection ?? cfg.productId} ${c?.sizeName(cfg) ?? ''}, ${lcColour(c?.colourName(cfg))}${closet}`.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
  }

  // ── card taps (page → UE directly; we are told afterwards) ────────────────
  async handleCardTap(s: AiSession, tap: { cardId: string; requestId: string; result?: EnvelopeResult }) {
    const card = s.cards.get(tap.cardId);
    s.stats.taps++;
    this.log(s, 'card_tap', { cardId: tap.cardId, requestId: tap.requestId, ok: tap.result?.ok, reasonCode: tap.result?.reasonCode });
    if (!card) return;
    const turnId = `t-${++s.turnSeq}`;
    if (tap.result && !tap.result.ok && tap.result.reasonCode === 'PLANNER_BUSY') {
      s.plannerBusy = true;
      s.plannerBusyTurn = turnId;
      s.notes.push(`[событие] Карточка «${card.title}» не применилась: конструктор занят другим посетителем.`);
      await this.say(s, `Поставить «${card.title}» сейчас не получится: конструктор занят другим посетителем на этом сервере. Можно немного подождать, пока он освободится, — карточки останутся на экране.`, turnId);
      return;
    }
    if (tap.result && !tap.result.ok) {
      s.notes.push(`[событие] Карточка «${card.title}» не применилась: ${tap.result.reason ?? tap.result.reasonCode}.`);
      await this.say(s, `Не получилось поставить «${card.title}»: ${tap.result.reason ?? 'комната не ответила'}. Давайте попробуем другой вариант.`, turnId);
      return;
    }
    let setId: string | undefined = tap.result?.result?.setId;
    if (!setId) {
      // QA-014: no result from the page -> ask UE for the state and take the new set with the card's configuration.
      const st = await this.command(s, 'get_state', {}, 'ui');
      const found = ((st.result?.sets ?? []) as any[]).filter((x) => !s.sets.has(x.setId) && x.config?.productId === card.config.productId && x.config?.sizeIndex === card.config.sizeIndex && x.config?.colourIndex === card.config.colourIndex);
      setId = found.pop()?.setId;
      this.log(s, 'card_tap_state_lookup', { cardId: card.cardId, found: setId ?? null });
    }
    if (setId) {
      s.sets.set(setId, { setId, config: fullConfig(card.config), title: card.title, cardId: card.cardId });
      s.lastSetId = setId;
      s.stats.applied++;
    }
    s.notes.push(`[событие] Посетитель выбрал карточку «${card.title}» (${card.price} BYN)${setId ? `, комплект ${setId} стоит в комнате` : ''}.`);
    this.emitBasket(s);
    await this.say(s, `Отличный выбор: ${card.title}, ${card.price} BYN. Могу сделать светлее, добавить навесной шкаф или подобрать отделку стен.`, turnId, setId ? { kind: 'set', id: setId } : undefined);
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  async runTool(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    // v2.0 tool gating: room tools only in «Конструктор» (never a room command from the salon).
    if (!toolsAllowed(s.mode).has(name)) {
      this.log(s, 'mode_gate_tool', { name, mode: s.mode, turnId });
      if (s.mode === 'showroom') {
        this.queueConstructorOffer(s, `fit:${s.focus?.boothId ?? 'none'}`, false);
        return { ok: false, reasonCode: 'NOT_IN_PLANNER', say: name === 'save_project' ? 'Досье делается в Конструкторе.' : 'Это делается в комнате Конструктора.' };
      }
      return { ok: false, say: name === 'catalog_suggest' ? 'В Конструкторе подберу комплекты сразу с проверкой по стене.' : 'Мы уже в Конструкторе.' };
    }
    const hits = s.busyHits;
    const out = await this.runToolInner(s, name, input, origin, turnId);
    if (s.busyHits === hits || out?.ok !== false || out?.busyHandled) return out;
    // CR-UE-02: a planner command came back PLANNER_BUSY (or was held back) -> one honest explanation per turn, never a retry.
    const first = s.busySaidTurn !== turnId;
    s.busySaidTurn = turnId;
    const say =
      name === 'take_photo' || name === 'save_project'
        ? PLANNER_BUSY_PHOTO_RU
        : name === 'consultant_summon'
          ? 'Подойти к вам в конструкторе сейчас не могу — он занят другим посетителем на этом сервере. Я на связи здесь, в чате.'
          : s.lastCards.length
            ? 'Конструктор сейчас занят другим посетителем на этом сервере, поэтому менять комнату я пока не могу. Можно немного подождать, пока он освободится, — карточки на экране можно смотреть и сравнивать.'
            : PLANNER_BUSY_RU;
    return { ok: false, reasonCode: 'PLANNER_BUSY', retry: false, ...(first ? { say } : {}) };
  }

  private async runToolInner(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    const fail = (say: string, extra: any = {}) => ({ ok: false, say, ...extra });
    switch (name) {
      case 'get_state': {
        const r = await this.command(s, 'get_state', {}, origin, 8000, turnId);
        if (r.ok && Array.isArray(r.result?.walls)) s.roomHasWindow = r.result.walls.some((w: any) => (w.openings ?? []).some((o: any) => o.kind === 'window'));
        return r.ok ? { ok: true, state: r.result } : fail('Не получилось прочитать комнату.', { reasonCode: r.reasonCode });
      }
      case 'build_room': {
        const args: any = { widthCm: input.widthCm, depthCm: input.depthCm };
        if (input.heightCm) args.heightCm = input.heightCm;
        if (input.openings?.length) args.openings = input.openings;
        const r = await this.command(s, 'build_room', args, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'OPENING_CONFLICT' ? 'Проём не помещается на стене — уточните его размер.' : `Не получилось построить комнату: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        s.sets.clear();
        s.lastSetId = undefined;
        s.roomHasWindow = (args.openings ?? []).some((o: any) => o.kind === 'window');
        this.emitBasket(s);
        const extra = (args.openings ?? []).map((o: any) => (o.kind === 'door' ? 'дверью' : 'окном')).join(' и ');
        const carryNote = s.pendingCarry ? await this.placeCarry(s, origin, turnId) : '';
        return { ok: true, say: `Построила комнату ${args.widthCm} на ${args.depthCm} см${extra ? ` с ${extra}` : ''}.${carryNote ? ` ${carryNote}` : ''}`, walls: r.result?.walls?.map((w: any) => ({ segmentId: w.segmentId, lengthCm: w.lengthCm })) };
      }
      case 'propose_sets':
        return this.proposeSets(s, input, origin, turnId);
      case 'apply_card': {
        const card =
          (input.cardId && s.cards.get(input.cardId)) ||
          (input.tier && s.lastCards.find((k) => k.tier === input.tier)) ||
          (input.position && s.lastCards[input.position - 1]);
        if (!card) return fail(s.lastCards.length ? 'Такой карточки нет — выберите одну из предложенных.' : 'Сначала давайте подберу варианты.');
        const r = await this.command(s, 'apply_config', { config: card.config, placement: card.placement, cardId: card.cardId }, origin, 8000, turnId);
        if (!r.ok) return fail(`Не получилось поставить «${card.title}»: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        const setId = r.result?.setId ?? `set-${Date.now()}`;
        s.sets.set(setId, { setId, config: fullConfig(card.config), title: card.title, cardId: card.cardId });
        s.lastSetId = setId;
        s.stats.applied++;
        this.emitBasket(s);
        s.seenAmounts.add(card.price);
        return { ok: true, setId, say: `Поставила ${card.title} — ${card.price} BYN.`, gesture: { kind: 'set', id: setId } };
      }
      case 'configure_set':
        return this.configureSet(s, input, origin, turnId);
      case 'swap_set': {
        const setId = input.setId ?? s.lastSetId;
        const card = input.cardId ? s.cards.get(input.cardId) : undefined;
        if (!setId || !s.sets.has(setId)) return fail('В комнате пока нет комплекта, который можно заменить.');
        if (!card) return fail('Выберите карточку для замены.');
        const r = await this.command(s, 'swap_set', { setId, config: card.config }, origin, 8000, turnId);
        if (!r.ok) return fail(`Замена не удалась: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        s.sets.set(setId, { setId, config: fullConfig(card.config), title: card.title, cardId: card.cardId });
        this.emitBasket(s);
        return { ok: true, setId, say: `Заменила на ${card.title} — ${card.price} BYN.`, gesture: { kind: 'set', id: setId } };
      }
      case 'remove_set': {
        const setId = input.setId ?? s.lastSetId;
        if (!setId) return fail('В комнате нет комплекта.');
        const r = await this.command(s, 'remove_set', { setId }, origin, 8000, turnId);
        if (!r.ok) return fail(`Не получилось убрать: ${r.reason ?? r.reasonCode}.`);
        s.sets.delete(setId);
        if (s.lastSetId === setId) s.lastSetId = [...s.sets.keys()].pop();
        this.emitBasket(s);
        return { ok: true, say: 'Убрала комплект.' };
      }
      case 'finish_surface': {
        let finish: any;
        let label: string;
        if (input.clear) {
          // v2.4: back to the default material
          finish = { type: 'none' };
          label = 'исходная отделка';
        } else if (input.target === 'opening_trim' && input.tileId) {
          return fail('Наличник двери или окна можно только покрасить — назовите код RAL или NCS.');
        } else if (input.tileId) {
          const tiles = this.catalog?.tiles() ?? [];
          const tile = tiles.find((t) => t.id === input.tileId);
          if (tiles.length && !tile) return fail(`Такой плитки нет в каталоге. Есть: ${tiles.map((t) => t.name).join(', ')}.`);
          finish = { type: 'tile', tileId: input.tileId };
          label = `плитка «${tile?.name ?? input.tileId}»`;
        } else if (input.paintCode) {
          finish = { type: 'paint', system: input.paintSystem ?? (/^S\s/.test(input.paintCode) ? 'NCS' : 'RAL'), code: input.paintCode };
          label = `краска ${input.paintCode}`;
        } else {
          return fail('Для пола выберите плитку на панели «Плитка» — я подскажу сочетание с мебелью.');
        }
        const target: any = { kind: input.target ?? 'all_walls' };
        if (input.segmentId !== undefined) target.segmentId = input.segmentId;
        if (input.side) target.side = input.side;
        if (target.kind === 'opening_trim') {
          // v2.4: the frame of a door / window: by id, or the only opening of that kind
          const o = await this.findOpening(s, input, origin, turnId);
          if ('say' in o) return fail(o.say, { reasonCode: o.reasonCode });
          target.openingId = o.openingId;
          delete target.side;
        }
        const r = await this.command(s, 'finish_surface', { target, finish }, origin, 8000, turnId);
        if (!r.ok) return fail(`Отделка не применилась: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        const surface =
          target.kind === 'all_walls'
            ? 'стены'
            : target.kind === 'floor'
              ? 'пол'
              : target.kind === 'ceiling'
                ? 'потолок'
                : target.kind === 'baseboard'
                  ? 'плинтус'
                  : target.kind === 'opening_trim'
                    ? 'наличник проёма'
                    : `стена ${target.segmentId}`;
        s.finishes = s.finishes.filter((f) => f.surface !== surface).concat(finish.type === 'none' ? [] : [{ surface, label, finish }]);
        this.emitBasket(s);
        return { ok: true, say: finish.type === 'none' ? `Готово: ${surface} — снова исходная отделка.` : `Готово: ${surface} — ${label}.` };
      }
      case 'check_fit': {
        const cfg = fullConfig({ ...(s.lastSetId ? s.sets.get(s.lastSetId)?.config : {}), ...input.config } as SetConfig);
        const r = await this.command(s, 'check_fit', { candidates: [{ key: 'q', config: cfg, ...(input.segmentId !== undefined ? { placement: { segmentId: input.segmentId } } : {}) }] }, origin, 8000, turnId);
        const res = r.result?.results?.[0];
        if (!r.ok || !res) return fail('Проверка не удалась.');
        return res.fits ? { ok: true, fits: true, spareCm: res.placement?.spareCm, say: `Помещается, остаётся ${Math.round(res.placement?.spareCm ?? 0)} см.` } : { ok: true, fits: false, reason: res.reason, say: `Не помещается: ${res.reason}.` };
      }
      case 'reset_room': {
        const r = await this.reset(s, false, turnId); // keep this turn's messages (tool_use/tool_result pairing)
        if (r.reasonCode === 'PLANNER_BUSY') return fail('Конструктор занят.', { reasonCode: 'PLANNER_BUSY' });
        return { ok: true, say: 'Начинаем сначала: вернула комнату к исходному виду. Какого размера ваша ванная?' };
      }
      case 'undo': {
        const r = await this.command(s, 'undo', {}, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'NOTHING_TO_UNDO' ? 'Отменять пока нечего.' : 'Не получилось отменить.');
        const sets = (r.result?.sets ?? []) as any[];
        if (Array.isArray(r.result?.sets)) {
          const keep = new Map<string, PlacedSetInfo>();
          for (const x of sets) keep.set(x.setId, s.sets.get(x.setId) ?? { setId: x.setId, config: fullConfig(x.config), title: this.titleFor(x.config) });
          for (const [id, v] of keep) if (s.sets.has(id)) v.config = fullConfig(sets.find((y) => y.setId === id).config);
          s.sets = keep;
          s.lastSetId = [...keep.keys()].pop();
        }
        await this.refreshFinishes(s, r.result);
        this.emitBasket(s);
        return { ok: true, say: 'Вернула как было.' };
      }
      case 'save_project': {
        // QA-050: held for PLANNER_BUSY -> no dossier stage at all (no building, no failed); the consultant promises it for later.
        if (await this.ownerHold(s, 'save_project', turnId)) return fail('Досье отложено: конструктор занят.', { reasonCode: 'PLANNER_BUSY' });
        s.io.emit('ai.dossier', { stage: 'building' });
        const r = await this.command(s, 'save_project', { projectName: input.projectName ?? `Ванная ${s.username}` }, origin, 15000, turnId);
        if (!r.ok) {
          if (r.reasonCode !== 'PLANNER_BUSY') s.io.emit('ai.dossier', { stage: 'failed' });
          return fail('Не получилось сохранить проект, попробую ещё раз чуть позже.', { reasonCode: r.reasonCode });
        }
        s.lastSaveId = r.result?.saveId;
        s.lastSaveUsername = typeof r.result?.username === 'string' && r.result.username ? r.result.username : undefined;
        s.stats.exports++;
        if (this.deps.onSaveProject && s.lastSaveId) {
          this.deps.onSaveProject(s, s.lastSaveId, s.lastSaveUsername).catch((e) => this.log(s, 'dossier_error', { message: e.message }));
        }
        return { ok: true, saveId: s.lastSaveId, say: 'Сохранила проект. Досье с планом, спецификацией и ценами появится на экране с QR-кодом.' };
      }
      case 'take_photo': {
        // v2.2 P3-02: in the salon the photo is the clean capture of a booth (no AI render).
        if (s.mode === 'showroom') return this.boothPhoto(s, input, origin, turnId);
        // QA-050: the same for the photo: held -> no capturing/failed render card.
        if (await this.ownerHold(s, 'capture', turnId)) return fail('Фото отложено: конструктор занят.', { reasonCode: 'PLANNER_BUSY' });
        const renderId = `rn-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        s.announcedRenders.add(renderId);
        // QA-051: /api/render accepts only this id, for this session, once, within the TTL.
        s.pendingRenders.set(renderId, Date.now() + RENDER_PENDING_TTL_MS);
        s.io.emit('ai.render', { renderId, stage: 'capturing' });
        const preset = ['corner', 'frontal', 'wide'].includes(input.preset) ? input.preset : 'corner';
        const r = await this.command(s, 'capture', { renderId, preset, sessionId: s.sessionId }, origin, 20000, turnId);
        if (!r.ok) {
          s.pendingRenders.delete(renderId);
          if (r.reasonCode !== 'PLANNER_BUSY') s.io.emit('ai.render', { renderId, stage: 'failed', reason: r.reason ?? r.reasonCode });
          return fail('Фото не получилось, попробуем ещё раз.', { reasonCode: r.reasonCode });
        }
        s.renders.push(renderId);
        s.stats.photos++;
        return { ok: true, renderId, say: 'Делаю фото — превью будет через несколько секунд.' };
      }
      case 'catalog_suggest':
        return this.catalogSuggest(s, input, turnId);
      case 'booth_get': {
        const c2 = this.catalog;
        if (!c2) return fail('Каталог сейчас недоступен.');
        const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
        if (!r.st) return fail(r.say!, { reasonCode: r.reasonCode });
        const d = describeBoothOptions(c2, r.st);
        d.amounts.forEach((a) => s.seenAmounts.add(a));
        return { ok: true, boothId: r.st.boothId, productId: r.st.productId, config: r.st.config, say: d.say };
      }
      case 'booth_configure':
        return this.boothConfigure(s, input, origin, turnId);
      case 'booth_undo': {
        const r = await this.command(s, 'booth_undo', input.boothId ? { boothId: input.boothId } : {}, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'NOTHING_TO_UNDO' ? 'На стенде пока нечего возвращать.' : r.reasonCode === 'NO_BOOTH' ? NO_BOOTH_RU : `Не получилось вернуть: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        if (r.result?.productId) {
          s.booth = r.result as BoothState;
          this.noteBooth(s, { boothId: s.booth.boothId, productId: s.booth.productId, collection: s.booth.collection ?? (c ? collectionOf(c, s.booth.productId) : undefined), label: s.booth.label });
        }
        if (s.booth && s.focus?.boothId === s.booth.boothId && c) s.focus = { ...s.focus, productId: s.booth.productId, collection: s.booth.collection ?? collectionOf(c, s.booth.productId) };
        const q = s.booth && c ? c.quote(s.booth.config) : undefined;
        if (q) s.seenAmounts.add(q.total);
        return { ok: true, say: `Вернула стенд как было${s.booth && c ? `: ${boothTitle(c, s.booth.config, s.booth.customColours)}, ${boothPrice(q!.total, q!.estimated, s.booth.customColours)}` : ''}.` };
      }
      case 'offer_constructor': {
        const tp = this.constructorTopic(s, String(input.topic ?? ''));
        const queued = this.queueConstructorOffer(s, tp.key, false, !!s.focus?.boothId);
        return { ok: true, offered: queued, say: '' };
      }
      case 'exit_constructor': {
        s.exiting = true;
        const r = await this.command(s, 'exit_constructor', {}, origin, 8000, turnId).finally(() => (s.exiting = false));
        if (!r.ok) return fail(`Не получилось выйти из Конструктора: ${r.reason ?? r.reasonCode}.`, { reasonCode: r.reasonCode });
        this.setMode(s, 'showroom', 'exit');
        return { ok: true, say: 'Вернулись в салон. Подойдите к любому стенду — расскажу о нём и настрою под вас.' };
      }
      case 'catalog_lookup':
        return this.catalogLookup(s, String(input.query ?? ''));
      // ── v2.4 (Phase 4): the remaining manual actions ──
      case 'list_options':
        return this.listOptions(s, input, origin, turnId);
      case 'move_set':
        return this.moveSet(s, input, origin, turnId);
      case 'add_opening':
      case 'update_opening':
      case 'remove_opening':
        return this.openingTool(s, name, input, origin, turnId);
      default:
        return fail('Неизвестное действие.');
    }
  }

  /** v2.0 showroom: up to three sets as INFORMATION (price, dimensions, materials) — no placement, no fit check. */
  private catalogSuggest(s: AiSession, input: ProposeArgs, turnId = `t-${s.turnSeq}`) {
    const c = this.catalog;
    if (!c) return { ok: false, say: 'Каталог ещё загружается, попробуйте через минуту.' };
    const args: ProposeArgs = { ...input, budgetBYN: input.budgetBYN ?? s.prefs.budgetBYN, style: input.style ?? s.prefs.style };
    if (input.budgetBYN !== undefined) s.prefs.budgetBYN = input.budgetBYN;
    if (input.style) s.prefs.style = input.style;
    if (args.budgetBYN !== undefined) s.seenAmounts.add(args.budgetBYN);
    let cands = generateCandidates(c, args);
    if (args.budgetBYN !== undefined) {
      const within = cands.filter((x) => x.quote.total <= args.budgetBYN!);
      if (!within.length && cands.length) {
        const min = Math.min(...cands.map((x) => x.quote.total));
        s.seenAmounts.add(min);
        return { ok: true, items: [], say: `В бюджет ${args.budgetBYN} BYN комплектов нет. Самый доступный стоит ${min} BYN.` };
      }
      cands = within;
    }
    const seen = new Set<string>();
    const picked = cands
      .sort((a, b) => b.styleScore - a.styleScore || Number(a.quote.estimated) - Number(b.quote.estimated) || a.quote.total - b.quote.total)
      .filter((x) => {
        const k = `${x.config.productId}:${c.colourName(x.config)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 3);
    if (!picked.length) return { ok: true, items: [], say: 'В каталоге нет подходящих комплектов с ценой — уточню у менеджера.' };
    const items = picked.map((x) => {
      const p = c.getProduct(x.config.productId);
      const sz = p?.cabinet.sizes.find((z) => z.index === x.config.sizeIndex);
      const dims = sz?.widthCm ? `${sz.widthCm}${sz.depthCm ? `×${sz.depthCm}` : ''}${sz.heightCm ? `×${sz.heightCm}` : ''} см` : sz?.name ? `${sz.name} см` : '';
      s.seenAmounts.add(x.quote.total);
      return { title: boothTitle(c, x.config), price: x.quote.total, estimated: x.quote.estimated, dims, material: lcColour(c.colourName(x.config)) };
    });
    // v2.0: the same picks as salon INFORMATION cards (no placement); «Показать в комнате» -> ai.card.show -> consent offer
    const tiers = ['best_fit', 'best_value', 'premium'] as const;
    const cards = picked.map((x, n) => buildInfoCard(x, picked.length === 1 ? ('single' as any) : tiers[n], c.syncedAt, `k-${s.turnSeq}-${++s.cardSeq}`));
    s.lastCards = cards;
    for (const k of cards) {
      s.cards.set(k.cardId, k);
      s.seenAmounts.add(k.price);
      k.items.forEach((i) => s.seenAmounts.add(i.price));
    }
    s.stats.cardsShown += cards.length;
    s.io.emit('ai.cards', { turnId, cards });
    const list = items.map((i, n) => `${n + 1}) ${i.title} — ${i.price} BYN${i.estimated ? ' (цена уточняется)' : ''}${i.dims ? `, ${i.dims}` : ''}`).join('; ');
    // P3-05: a speakable summary first (the voice says it), the list for the chat after it
    const n = items.length;
    const what = n === 1 ? 'один комплект' : `${n === 2 ? 'два' : 'три'} комплекта`;
    return { ok: true, items, say: `Подобрала из каталога ${what}: ${list}. Любой из них могу показать на стенде салона или в комнате Конструктора.` };
  }

  private catalogLookup(s: AiSession, q: string) {
    const c = this.catalog;
    if (!c) return { ok: false, say: 'Каталог сейчас недоступен.' };
    const ql = q.toLowerCase();
    // v2.0: a named collection narrows the answer (Latin or Cyrillic), else every collection
    const focusCol = s.focus?.collection;
    let named = c.listProducts().filter((p) => p.collection && (ql.includes(p.collection.toLowerCase()) || collectionFromText(ql) === p.collection));
    // v2.0: «эта тумба», «она» -> the booth in focus
    if (!named.length && focusCol) named = c.listProducts().filter((p) => p.collection === focusCol);
    const prods = named.length ? named : c.listProducts().filter((p) => !p.collection || /цен|стоит|почем|стоимост|размер|габарит|коллекц|каталог/.test(ql) || true);
    const rows = prods.slice(0, 8).map((p) => {
      const variants = p.cabinet.sizes.map((sz) => {
        const ci = c.colourIndicesForSize(p, sz.index)[0] ?? 0;
        const qte = c.quote({ productId: p.productId, sizeIndex: sz.index, colourIndex: ci });
        s.seenAmounts.add(qte.total);
        return { size: sz.name, from: qte.total, estimated: qte.estimated };
      });
      return { productId: p.productId, collection: p.collection, colours: p.cabinet.colours.map((x) => x.name), variants };
    });
    const first = rows[0];
    // P3-05: the lowest price first as one speakable sentence, the sizes after it (chat)
    const min = first?.variants.length ? first.variants.reduce((a, v) => (v.from < a.from ? v : a)) : undefined;
    const say = first
      ? `${min ? `${first.collection ?? ''} — от ${min.from} BYN${min.estimated ? ', цена уточняется' : ''}. ` : ''}${first.collection ?? ''}: ${first.variants.map((v) => `${v.size} — от ${v.from} BYN${v.estimated ? ' (цена уточняется)' : ''}`).join(', ')}.`
      : 'Такого товара в каталоге нет.';
    return { ok: true, products: rows, say };
  }

  private async proposeSets(s: AiSession, input: ProposeArgs, origin: Origin, turnId: string) {
    const c = this.catalog;
    if (!c) return { ok: false, say: 'Каталог ещё загружается, попробуйте через минуту.' };
    // QA-025: a collection that is not ready for the 3D room -> honest note + the closest alternative.
    if (input.collection) {
      const col = c.listProducts().find((p) => p.collection?.toLowerCase() === String(input.collection).toLowerCase())?.collection;
      if (col && !c.isCollectionEnabled(col)) {
        const alt = c.alternativeFor(col);
        const prefix = `Коллекцию ${col} мы ещё готовим для 3D-комнаты.${alt ? ` Ближе всего к ней ${alt} — показываю её.` : ''}`;
        if (!alt) return { ok: false, say: prefix };
        const r: any = await this.proposeSets(s, { ...input, collection: alt }, origin, turnId);
        return { ...r, say: `${prefix} ${r.say ?? ''}`.trim() };
      }
    }
    if (input.budgetBYN !== undefined) s.prefs.budgetBYN = input.budgetBYN;
    if (input.style) s.prefs.style = input.style;
    const args: ProposeArgs = { ...input, budgetBYN: input.budgetBYN ?? s.prefs.budgetBYN, style: input.style ?? s.prefs.style };
    if (args.budgetBYN !== undefined) s.seenAmounts.add(args.budgetBYN);
    const cands = generateCandidates(c, args);
    if (cands.length === 0) return { ok: false, say: 'В каталоге нет подходящих комплектов с ценой — уточню у менеджера.' };
    const fitRes = await this.command(
      s,
      'check_fit',
      { candidates: cands.map((x) => ({ key: x.key, config: x.config, ...(args.segmentId !== undefined ? { placement: { segmentId: args.segmentId } } : {}) })) },
      origin,
      8000,
      turnId,
    );
    if (fitRes.reasonCode === 'PLANNER_BUSY') {
      // check_fit is read-only and UE allows it to a non-owner today; should that change, stay honest and offer the catalog.
      return { ok: false, reasonCode: 'PLANNER_BUSY', retry: false, busyHandled: true, say: 'Конструктор сейчас занят другим посетителем на этом сервере, поэтому проверить стену я пока не могу. Могу рассказать о коллекциях и ценах — или подождём, пока он освободится.' };
    }
    if (!fitRes.ok) {
      return { ok: false, reasonCode: fitRes.reasonCode, say: fitRes.reasonCode === 'NOT_IN_PLANNER' ? 'Откройте, пожалуйста, планировщик комнаты — и я подберу варианты.' : 'Не получилось проверить стену. Давайте сначала построим комнату — назовите её размер.' };
    }
    const results = (fitRes.result?.results ?? []) as any[];
    if (results.some((r) => r.reasonCode === 'NO_ROOM')) return { ok: false, reasonCode: 'NO_ROOM', say: 'Сначала построим комнату — назовите её размер, например «2 на 2,5 метра».' };
    const ranked = rankTiers(cands, results, args);
    s.stats.proposals++;
    if (ranked.length === 0) {
      const noFit = results.every((r) => !r.fits);
      const say = noFit
        ? 'На свободной стене ни один комплект не помещается. Можно выбрать другую стену или комнату побольше.'
        : `В бюджет ${args.budgetBYN} BYN подходящих комплектов нет. Самый доступный стоит ${Math.min(...cands.map((x) => x.quote.total))} BYN — показать его?`;
      cands.forEach((x) => s.seenAmounts.add(x.quote.total));
      s.io.emit('ai.cards', { turnId, cards: [] });
      return { ok: true, cards: [], say };
    }
    const cards = ranked.map((r) => buildCard(r, args, c.syncedAt, `k-${s.turnSeq}-${++s.cardSeq}`, ranked.length === 1));
    s.lastCards = cards;
    for (const k of cards) {
      s.cards.set(k.cardId, k);
      s.seenAmounts.add(k.price);
      k.items.forEach((i) => s.seenAmounts.add(i.price));
    }
    s.stats.cardsShown += cards.length;
    s.io.emit('ai.cards', { turnId, cards });
    this.log(s, 'cards', { turnId, args, cards: cards.map((k) => ({ cardId: k.cardId, tier: k.tier, title: k.title, price: k.price, spareCm: k.spareCm })) });
    const list = cards.map((k, i) => `${i + 1}) ${k.title} — ${k.price} BYN`).join('; ');
    return {
      ok: true,
      cards: cards.map((k, i) => ({ position: i + 1, cardId: k.cardId, tier: k.tier, title: k.title, price: k.price, spareCm: k.spareCm, reason: k.reason })),
      say: `Подобрала ${cards.length === 1 ? 'вариант' : `${cards.length} варианта`}: ${list}. ${
        // CR-UE-02: cards can be browsed, but placing them waits until the planner is free.
        !s.plannerBusy ? 'Нажмите на карточку, и я поставлю комплект.' : s.busySaidTurn === turnId ? 'Поставить в комнату можно будет, когда конструктор освободится.' : PLANNER_BUSY_CARDS_RU
      }`,
      ...(s.plannerBusy ? { placeable: false } : {}),
    };
  }

  private async configureSet(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    const setId = input.setId ?? s.lastSetId;
    const set = setId ? s.sets.get(setId) : undefined;
    if (!c) return { ok: false, say: 'Каталог сейчас недоступен.' };
    if (!set) {
      if (input.styleHint) return this.proposeSets(s, { style: input.styleHint === 'lighter' ? 'light' : 'dark' }, origin, turnId);
      if (input.config?.closetSizeIndex >= 0) return this.proposeSets(s, { withCloset: true }, origin, turnId);
      return { ok: false, say: 'Сначала выберите комплект — и я его настрою.' };
    }
    // QA-056: act on the set as it is in the room now (card taps / manual edits may have changed it since).
    const st = await this.command(s, 'get_state', {}, 'ui', 8000, turnId);
    const live = st.ok && Array.isArray(st.result?.sets) ? (st.result.sets as any[]).find((x) => x?.setId === set.setId) : undefined;
    if (live?.config?.productId) set.config = fullConfig(live.config);
    // v2.4: parts by DataTable id / colour SKU, size in cm, paint, doors — the same planner as the salon booths
    if (V24_SET_FIELDS.some((k) => input[k] !== undefined)) return this.configureSetParts(s, set, live, input, origin, turnId);
    const p = c.getProduct(set.config.productId)!;
    let change: Partial<SetConfig> = { ...(input.config ?? {}) };
    delete (change as any).productId;
    // QA-056: «добавь пенал» when it is already there / «убери пенал» when there is none -> the truth, no command.
    const curCloset = set.config.closetSizeIndex ?? -1;
    const onlyCloset = !input.styleHint && Object.keys(change).every((k) => k === 'closetSizeIndex' || k === 'closetColourIndex');
    let closetNote: string | null = null;
    if (change.closetSizeIndex !== undefined && change.closetSizeIndex >= 0 && curCloset >= 0 && (input.addCloset === true || change.closetSizeIndex === curCloset) && change.closetColourIndex === undefined) {
      closetNote = 'Навесной шкаф уже в комплекте — можно поменять его цвет или размер.';
    } else if (change.closetSizeIndex === -1 && curCloset < 0) {
      closetNote = 'Навесного шкафа в комплекте нет — убирать нечего.';
    }
    if (closetNote) {
      if (onlyCloset) return { ok: true, noChange: true, setId: set.setId, say: closetNote };
      delete change.closetSizeIndex;
      delete change.closetColourIndex;
    }
    if (input.styleHint) {
      const rank = (name: string) => {
        const t = tonesOf(name);
        if (t.includes('white')) return 0;
        if (t.includes('light')) return 1;
        if (t.includes('grey') || t.includes('neutral')) return 2;
        if (t.includes('dark') || t.includes('black')) return 3;
        return 2;
      };
      const cur = rank(c.colourName(set.config) ?? '');
      const opts = c
        .colourIndicesForSize(p, set.config.sizeIndex)
        .map((i) => ({ i, r: rank(p.cabinet.colours.find((x) => x.index === i)?.name ?? '') }))
        .filter((o) => (input.styleHint === 'lighter' ? o.r < cur : o.r > cur))
        .sort((a, b) => (input.styleHint === 'lighter' ? b.r - a.r : a.r - b.r));
      if (opts.length === 0) {
        const alt: any = await this.proposeSets(s, { style: input.styleHint === 'lighter' ? 'white' : 'dark', excludeProductId: set.config.productId }, origin, turnId);
        return { ...alt, say: `В этой коллекции ${input.styleHint === 'lighter' ? 'светлее' : 'темнее'} цвета нет. ${alt.say ?? ''}`.trim() };
      }
      change.colourIndex = opts[0].i;
    }
    if (change.closetSizeIndex !== undefined && change.closetSizeIndex >= 0 && p.closetModels.length === 0) {
      const others = c.collectionsWithCloset().filter((x) => x !== p.collection);
      return { ok: false, reasonCode: 'CATALOG_OPTION_INVALID', say: `В коллекции ${p.collection} навесного шкафа нет.${others.length ? ` Он есть в коллекциях ${others.join(', ')} — показать варианты с ним?` : ''}` };
    }
    if (change.closetSizeIndex !== undefined && change.closetSizeIndex >= 0 && change.closetColourIndex === undefined) {
      const cab = (c.colourName(set.config) ?? '').toLowerCase().split(/\s+/)[0];
      const m = p.closetModels.find((x) => x.index === change.closetSizeIndex) ?? p.closetModels[0];
      change.closetColourIndex = m?.colours.find((x) => x.name.toLowerCase().startsWith(cab))?.index ?? m?.colours[0]?.index ?? 0;
    }
    const next = fullConfig({ ...set.config, ...change });
    const before = fullConfig(set.config);
    // QA-056: nothing would change -> say so, send nothing.
    if (sameConfig(next, before)) return { ok: true, noChange: true, setId: set.setId, say: closetNote ?? 'Так уже и есть — в комплекте ничего менять не нужно.' };
    const invalid = c.validate(next);
    if (invalid) return { ok: false, reasonCode: 'CATALOG_OPTION_INVALID', say: invalid };
    const q = c.quote(next);
    if (!q.complete) return { ok: false, say: 'Для этого варианта нет цены в каталоге — не буду его предлагать.' };
    const r = await this.command(s, 'configure_set', { setId: set.setId, config: change }, origin, 8000, turnId);
    if (!r.ok) {
      const why = r.reasonCode === 'NO_FIT' ? 'не помещается на стене' : r.reason ?? r.reasonCode;
      return { ok: false, reasonCode: r.reasonCode, say: `Так не получится: ${why}.` };
    }
    // QA-056: never claim a change UE did not make (its result carries the set's config).
    const after = r.result?.config?.productId ? fullConfig(r.result.config) : next;
    if (sameConfig(after, before)) return { ok: false, noChange: true, setId: set.setId, say: 'Изменение не применилось — комплект остался прежним.' };
    set.config = after;
    set.title = this.titleFor(after);
    this.emitBasket(s);
    const qa = sameConfig(after, next) ? q : c.quote(after);
    s.seenAmounts.add(qa.total);
    const what = input.styleHint
      ? `Сделала ${input.styleHint === 'lighter' ? 'светлее' : 'темнее'}: ${lcColour(c.colourName(after))}`
      : after.closetSizeIndex !== before.closetSizeIndex
        ? after.closetSizeIndex < 0
          ? 'Убрала навесной шкаф'
          : before.closetSizeIndex < 0
            ? 'Добавила навесной шкаф'
            : 'Поменяла размер навесного шкафа'
        : 'Готово';
    return { ok: true, setId: set.setId, total: qa.total, say: `${closetNote ? closetNote + ' ' : ''}${what}. Комплект теперь стоит ${qa.total} BYN${qa.estimated ? ' (цена уточняется)' : ''}.`, gesture: { kind: 'set', id: set.setId } };
  }

  // ── v2.4 (Phase 4) ──────────────────────────────────────────────────────────

  /** configure_set with semantic fields: planned like a salon booth (parts by DataTable id, size, paint, doors), then sent to UE. */
  private async configureSetParts(s: AiSession, set: PlacedSetInfo, live: any, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog!;
    const cur = c.getProduct(set.config.productId);
    if (input.collection && input.collection.toLowerCase() !== (cur?.collection ?? '').toLowerCase()) {
      // another collection = another set: fit-checked proposals (the visitor picks one; swap_set replaces in place)
      return this.proposeSets(s, { collection: input.collection }, origin, turnId);
    }
    const st: BoothState = { boothId: set.setId, productId: set.config.productId, config: set.config, customColours: live?.customColours, doors: live?.doors };
    const req: any = { ...input };
    delete req.collection;
    delete req.setId;
    delete req.config;
    const plan = planBoothChange(c, st, req);
    if (plan.kind === 'say') return { ok: plan.ok, ...(plan.noChange ? { noChange: true } : {}), setId: set.setId, say: plan.say };
    const before = fullConfig(set.config);
    const next = fullConfig({ ...before, ...(plan.args.config ?? {}) });
    if (plan.args.config && !c.quote(next).complete) return { ok: false, setId: set.setId, say: 'Для этого варианта нет цены в каталоге — не буду его ставить.' };
    const args: any = { setId: set.setId };
    for (const k of ['config', 'customColour', 'clearCustomColour', 'doors'] as const) if ((plan.args as any)[k] !== undefined) args[k] = (plan.args as any)[k];
    const r = await this.command(s, 'configure_set', args, origin, 8000, turnId);
    if (!r.ok) {
      const why = r.reasonCode === 'NO_FIT' ? 'не помещается на стене' : r.reason ?? r.reasonCode;
      return { ok: false, reasonCode: r.reasonCode, setId: set.setId, say: `Так не получится: ${why}.` };
    }
    const res = r.result ?? {};
    const after = res.config?.productId ? fullConfig(res.config) : next;
    // QA-056: never claim a change UE did not make
    if (plan.args.config && sameConfig(after, before)) return { ok: false, noChange: true, setId: set.setId, say: 'Изменение не применилось — комплект остался прежним.' };
    const norm = (x?: string) => String(x ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (plan.args.customColour && Array.isArray(res.customColours) && !res.customColours.some((x: any) => x.component === plan.args.customColour!.component && norm(x.code) === norm(plan.args.customColour!.code))) {
      return { ok: false, noChange: true, setId: set.setId, say: `Покрасить в ${plan.args.customColour.code} не получилось. Можно выбрать цвет из коллекции или другой код RAL/NCS.` };
    }
    if (plan.args.clearCustomColour && Array.isArray(res.customColours) && res.customColours.some((x: any) => x.component === plan.args.clearCustomColour)) {
      return { ok: false, noChange: true, setId: set.setId, say: 'Покраску снять не получилось.' };
    }
    const dw = plan.args.doors ? (Object.entries(plan.args.doors)[0] as [string, string]) : undefined;
    if (dw && res.doors && res.doors[dw[0]] !== dw[1]) return { ok: false, noChange: true, setId: set.setId, say: 'Дверцы не получилось переключить.' };
    set.config = after;
    set.title = this.titleFor(after);
    this.emitBasket(s);
    const q = c.quote(after);
    s.seenAmounts.add(q.total);
    const paint = (res.customColours ?? []).some((x: any) => x.code) ? '; стоимость покраски уточнит менеджер' : '';
    return { ok: true, setId: set.setId, total: q.total, say: `${plan.what}. Комплект теперь стоит ${q.total} BYN${q.estimated ? ' (цена уточняется)' : ''}${paint}.`, gesture: { kind: 'set', id: set.setId } };
  }

  /** list_options: every allowed model / colour of the booth in focus or a planner set, by DataTable id, with prices. */
  private async listOptions(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    if (!c) return { ok: false, say: 'Каталог сейчас недоступен.' };
    const part = PART_NAMES.includes(input.part) ? (input.part as PartName) : undefined;
    let cfg: SetConfig;
    let target: any;
    const setId = input.setId ?? (s.mode === 'constructor' && !input.boothId ? s.lastSetId : undefined);
    if (s.mode === 'constructor' && setId && s.sets.has(setId)) {
      const set = s.sets.get(setId)!;
      const st = await this.command(s, 'get_state', {}, 'ui', 8000, turnId);
      const live = st.ok && Array.isArray(st.result?.sets) ? (st.result.sets as any[]).find((x) => x?.setId === setId) : undefined;
      if (live?.config?.productId) set.config = fullConfig(live.config);
      cfg = set.config;
      target = { kind: 'set', setId, title: set.title };
    } else {
      if (s.mode === 'constructor' && !input.boothId && !s.focus?.boothId) return { ok: false, say: 'В комнате пока нет комплекта — давайте подберу варианты.' };
      const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
      if (!r.st) return { ok: false, reasonCode: r.reasonCode, say: r.say };
      cfg = r.st.config;
      target = { kind: 'booth', boothId: r.st.boothId, collection: r.st.collection ?? collectionOf(c, r.st.productId) };
    }
    const parts = listParts(c, cfg, part);
    for (const l of parts) for (const o of l.options) for (const col of o.colours) if (col.priceBYN) s.seenAmounts.add(col.priceBYN);
    return { ok: true, target, parts, say: describeListing(parts) };
  }

  /** move_set: the same set to the visitor's left / right by N cm, to the start / end of its wall, or to another wall. */
  private async moveSet(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const setId = input.setId ?? s.lastSetId;
    if (!setId || !s.sets.has(setId)) return { ok: false, say: 'В комнате пока нет комплекта, который можно передвинуть.' };
    const args: any = { setId };
    if (input.direction === 'left' || input.direction === 'right') {
      args.direction = input.direction;
      args.distanceCm = Math.max(1, Math.min(1000, Math.round(Number(input.distanceCm ?? 10))));
    } else {
      const placement: any = {};
      if (input.segmentId !== undefined) placement.segmentId = input.segmentId;
      if (input.side) placement.side = input.side;
      if (input.offsetCm !== undefined) placement.offsetCm = input.offsetCm;
      else if (input.position === 'start' || input.position === 'end' || input.position === 'centre') placement.anchor = input.position;
      if (!Object.keys(placement).length) return { ok: false, say: 'Куда передвинуть комплект: левее или правее (на сколько сантиметров), к краю стены или на другую стену?' };
      args.placement = placement;
    }
    const r = await this.command(s, 'move_set', args, origin, 8000, turnId);
    if (!r.ok) {
      const what = r.result?.obstacle?.kind === 'opening' ? 'проём' : r.result?.obstacle?.kind === 'set' ? 'другой комплект' : 'стена';
      const max = r.result?.maxShiftCm;
      if (r.reasonCode === 'NO_FIT' && max >= 1) return { ok: false, reasonCode: 'NO_FIT', maxShiftCm: max, say: `На ${args.distanceCm} см не получится — мешает ${what}. Можно сдвинуть на ${max} см. Сдвинуть?` };
      if (r.reasonCode === 'NO_FIT') return { ok: false, reasonCode: 'NO_FIT', say: `Туда комплект не помещается — мешает ${what}.` };
      if (r.reasonCode === 'NO_WALL') return { ok: false, reasonCode: 'NO_WALL', say: 'Такой стены нет — давайте посмотрю на комнату ещё раз.' };
      return { ok: false, reasonCode: r.reasonCode, say: `Передвинуть не получилось: ${r.reason ?? r.reasonCode}.` };
    }
    const moved = Math.round(Number(r.result?.movedCm ?? args.distanceCm ?? 0));
    const otherWall = args.placement?.segmentId !== undefined && r.result?.from?.segmentId !== undefined && r.result.from.segmentId !== args.placement.segmentId;
    const say = args.direction
      ? `Сдвинула комплект на ${moved} см ${args.direction === 'left' ? 'левее' : 'правее'}.`
      : otherWall
        ? 'Перенесла комплект на другую стену.'
        : args.placement.anchor === 'start' || args.placement.anchor === 'end'
          ? 'Передвинула комплект к краю стены.'
          : `Передвинула комплект${moved ? ` на ${moved} см` : ''}.`;
    return { ok: true, setId, movedCm: moved, say, gesture: { kind: 'set', id: setId } };
  }

  /** v2.4: an opening by id, or the only door / window (optionally on one wall). */
  private async findOpening(s: AiSession, input: any, origin: Origin, turnId: string): Promise<{ openingId: string; kind: string; segmentId: number } | { say: string; reasonCode?: string }> {
    const st = await this.command(s, 'get_state', {}, origin, 8000, turnId);
    if (!st.ok) return { say: 'Не получилось прочитать комнату.', reasonCode: st.reasonCode };
    const all = ((st.result?.walls ?? []) as any[]).flatMap((w) => (w.openings ?? []).map((o: any) => ({ ...o, segmentId: w.segmentId })));
    if (input.openingId) {
      const o = all.find((x) => x.openingId === input.openingId);
      return o ? { openingId: o.openingId, kind: o.kind, segmentId: o.segmentId } : { say: 'Такого проёма в комнате нет.', reasonCode: 'NO_OPENING' };
    }
    const kind = input.kind ?? input.openingKind;
    const cands = all.filter((o) => (!kind || o.kind === kind) && (input.segmentId === undefined || o.segmentId === input.segmentId));
    const ru = kind === 'window' ? 'окна' : kind === 'door' ? 'двери' : 'проёма';
    if (!cands.length) return { say: `В комнате нет ${ru}${input.segmentId !== undefined ? ' на этой стене' : ''}.`, reasonCode: 'NO_OPENING' };
    if (cands.length > 1) return { say: `В комнате ${cands.length} ${kind === 'window' ? 'окна' : kind === 'door' ? 'двери' : 'проёма'} — уточните, на какой стене.`, reasonCode: 'BAD_ARGS' };
    return { openingId: cands[0].openingId, kind: cands[0].kind, segmentId: cands[0].segmentId };
  }

  /** add_opening / update_opening / remove_opening (doors and windows of the room). */
  private async openingTool(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    const ru = (k?: string) => (k === 'window' ? 'окно' : 'дверь');
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
    if (name === 'add_opening') {
      if (input.kind !== 'door' && input.kind !== 'window') return { ok: false, say: 'Что добавить: дверь или окно?' };
      if (input.segmentId === undefined) return { ok: false, say: `На какую стену поставить ${ru(input.kind)}?` };
      const r = await this.command(s, 'add_opening', pick(['kind', 'segmentId', 'offsetCm', 'widthCm', 'heightCm', 'sillCm']), origin, 8000, turnId);
      if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: r.reasonCode === 'OPENING_CONFLICT' ? `Так не получится: ${r.reason}.` : `Не получилось добавить ${ru(input.kind)}: ${r.reason ?? r.reasonCode}.` };
      if (input.kind === 'window') s.roomHasWindow = true;
      return { ok: true, openingId: r.result?.openingId, say: `Добавила ${ru(input.kind)}.` };
    }
    const o = await this.findOpening(s, input, origin, turnId);
    if ('say' in o) return { ok: false, reasonCode: o.reasonCode, say: o.say };
    if (name === 'remove_opening') {
      const r = await this.command(s, 'remove_opening', { openingId: o.openingId, segmentId: o.segmentId }, origin, 8000, turnId);
      if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: `Не получилось убрать ${ru(o.kind)}: ${r.reason ?? r.reasonCode}.` };
      return { ok: true, say: `Убрала ${ru(o.kind)}.` };
    }
    const args: any = { openingId: o.openingId, segmentId: o.segmentId, ...pick(['offsetCm', 'widthCm', 'heightCm', 'sillCm']) };
    if (input.direction === 'left' || input.direction === 'right') {
      args.direction = input.direction;
      args.distanceCm = Math.max(1, Math.min(1000, Math.round(Number(input.distanceCm ?? 10))));
    }
    if (o.kind === 'door') delete args.sillCm;
    const r = await this.command(s, 'update_opening', args, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: r.reasonCode === 'OPENING_CONFLICT' ? `Так не получится: ${r.reason}.` : `Не получилось изменить ${ru(o.kind)}: ${r.reason ?? r.reasonCode}.` };
    const res = r.result ?? {};
    const parts = [
      args.direction ? `сдвинула на ${args.distanceCm} см ${args.direction === 'left' ? 'левее' : 'правее'}` : args.offsetCm !== undefined ? `поставила в ${Math.round(res.offsetCm ?? args.offsetCm)} см от края стены` : '',
      args.widthCm !== undefined || args.heightCm !== undefined ? `размер ${Math.round(res.widthCm ?? args.widthCm)}×${Math.round(res.heightCm ?? args.heightCm)} см` : '',
      args.sillCm !== undefined ? `подоконник на высоте ${Math.round(res.sillCm ?? args.sillCm)} см` : '',
    ].filter(Boolean);
    return { ok: true, openingId: o.openingId, say: `Готово: ${o.kind === 'window' ? 'окно' : 'дверь'} — ${parts.join(', ')}.` };
  }

  // ── a visitor turn ────────────────────────────────────────────────────────
  async handleTurn(s: AiSession, text: string, source: 'text' | 'voice' = 'text'): Promise<void> {
    if (s.busy) {
      // Security review: bounded backlog (each queued turn is an LLM call).
      if (s.queue.length >= 3) {
        s.io.emit('ai.error', { code: 'RATE_LIMITED', message: 'Я ещё отвечаю на предыдущие сообщения — подождите, пожалуйста.' });
        return;
      }
      s.queue.push({ text, origin: source });
      return;
    }
    s.busy = true;
    try {
      await this.safeTurn(s, text, source);
      while (s.queue.length) {
        const n = s.queue.shift()!;
        await this.safeTurn(s, n.text, n.origin);
      }
    } finally {
      s.busy = false;
    }
  }

  /** QA-044: a turn that throws still switches the thinking indicator off. */
  private async safeTurn(s: AiSession, text: string, source: 'text' | 'voice') {
    try {
      await this.runTurn(s, text, source);
    } catch (e: any) {
      this.log(s, 'turn_error', { turnId: `t-${s.turnSeq}`, message: e?.message });
      s.io.emit('ai.thinking', { turnId: `t-${s.turnSeq}`, on: false });
      s.io.emit('ai.error', { code: 'TURN_FAILED', message: 'Что-то пошло не так, повторите, пожалуйста.' });
    }
  }

  private async runTurn(s: AiSession, text: string, source: 'text' | 'voice') {
    const turnId = `t-${++s.turnSeq}`;
    const t0 = Date.now();
    s.stats.turns++;
    s.transcript.push({ role: 'visitor', text, at: new Date().toISOString() });
    s.io.emit('ai.message', { turnId, role: 'visitor', text });
    s.io.emit('ai.thinking', { turnId, on: true });
    const notes = s.notes.splice(0);
    const content = [...notes, text].join('\n');
    s.messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
    this.log(s, 'turn', { turnId, source, text });
    s.turnOffer = undefined;

    // v2.0: answers to the previous offer and the constructor consent come first (deterministic, never the LLM).
    const pre = await this.preTurn(s, text, s.turnSeq, turnId);
    if (pre.handled) {
      const reply = pre.reply ?? 'Готово.';
      s.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      this.trimHistory(s);
      await this.say(s, reply, turnId);
      if (pre.offer) await this.presentOffer(s, pre.offer, turnId, false); // the buttons follow the spoken reply
      this.log(s, 'turn_done', { turnId, ms: Date.now() - t0, origin: 'consent', reply });
      return;
    }

    let llm: LlmProvider = this.deps.llm;
    let origin: Origin = 'model';
    let final = '';
    let gesture: any;
    let thinkingRetried = false;
    for (let step = 0; step < 8; step++) {
      let resp: LlmResponse;
      const system = systemPrompt(this.catalog, s.mode);
      const tools = toolsFor(toolsAllowed(s.mode));
      const binding = crypto.createHash('sha1').update(system).update(JSON.stringify(tools)).digest('hex');
      if (s.llmBinding && s.llmBinding !== binding) {
        const n = stripThinking(s.messages);
        if (n) this.log(s, 'thinking_stripped', { turnId, reason: 'system/tools changed', mode: s.mode, blocks: n });
      }
      s.llmBinding = binding;
      try {
        resp = await withTimeout(llm.create({ system, messages: s.messages, tools, sessionId: s.sessionId }), this.deps.llmTimeoutMs ?? 12000);
        if (resp.costUsd) s.stats.llmCostUsd += resp.costUsd;
      } catch (e: any) {
        this.log(s, 'llm_error', { turnId, message: e.message, provider: llm.name });
        // Safety net for any other history edit: strip the thinking blocks and retry the same model once.
        if (!thinkingRetried && /Invalid `signature` in `thinking` block/.test(String(e.message))) {
          thinkingRetried = true;
          const n = stripThinking(s.messages);
          this.log(s, 'thinking_stripped', { turnId, reason: 'signature 400', blocks: n });
          step--;
          continue;
        }
        if (llm === this.deps.fallbackLlm) {
          final = 'Извините, я на секунду задумалась. Повторите, пожалуйста.';
          break;
        }
        // Scripted fallback (task 8): continue this turn with the deterministic policy.
        llm = this.deps.fallbackLlm;
        origin = 'scripted_fallback';
        s.stats.fallbacks++;
        step--;
        continue;
      }
      s.messages.push({ role: 'assistant', content: resp.content as any });
      const uses = resp.content.filter((b: any) => b.type === 'tool_use') as any[];
      if (uses.length === 0) {
        final = resp.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join(' ')
          .trim();
        break;
      }
      const results: any[] = [];
      for (const u of uses) {
        s.io.emit('ai.thinking', { turnId, on: true, step: STEP_RU[u.name] ?? 'Работаю' });
        let out: any;
        try {
          out = await this.runTool(s, u.name, u.input ?? {}, origin, turnId);
        } catch (e: any) {
          out = { ok: false, say: 'Что-то пошло не так, попробуем ещё раз.', error: e.message };
        }
        if (out?.gesture) gesture = out.gesture;
        this.log(s, 'tool', { turnId, name: u.name, input: u.input, ok: out?.ok, say: out?.say });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out?.ok === false ? { is_error: true } : {}) });
      }
      s.messages.push({ role: 'user', content: results });
      if (step === 7) final = 'Готово.';
    }
    const g = guardReply(final || 'Готово.', [...s.seenAmounts]);
    if (g.violations.length) {
      s.stats.guardrailHits++;
      this.log(s, 'guardrail', { turnId, violations: g.violations, original: final });
    }
    this.trimHistory(s);
    // v2.0: a constructor offer made in this turn follows the answer (one message, then the buttons).
    const offer = s.mode === 'showroom' ? (s.turnOffer as AiSession['turnOffer']) : undefined;
    s.turnOffer = undefined;
    const replyText = offer ? `${g.text} ${offer.text}`.trim() : g.text;
    await this.say(s, replyText, turnId, gesture); // emits ai.thinking off with the reply (QA-044)
    if (offer) await this.presentOffer(s, offer, turnId, false);
    this.log(s, 'turn_done', { turnId, ms: Date.now() - t0, origin, reply: replyText });
  }

  /** Keep the last ~12 visitor turns; always cut at a visitor text message so tool_use/tool_result pairs stay intact. */
  private trimHistory(s: AiSession) {
    const starts: number[] = [];
    s.messages.forEach((m, i) => {
      if (m.role === 'user' && Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === 'text')) starts.push(i);
    });
    if (starts.length > 12) {
      s.messages = s.messages.slice(starts[starts.length - 12]);
      stripThinking(s.messages); // dropping leading turns changes the prefix every remaining thinking block is bound to
    }
  }

  async handleAudio(s: AiSession, audio: Buffer, mimeType: string) {
    const t0 = Date.now();
    let text = '';
    try {
      text = (await this.deps.stt.transcribe(audio, mimeType, s.sessionId)).text;
    } catch (e: any) {
      this.log(s, 'stt_error', { message: e.message });
      s.io.emit('ai.error', { code: 'STT_FAILED', message: 'Не расслышала, повторите, пожалуйста.' });
      return;
    }
    const fixed = applySttCorrection(text);
    text = fixed.text;
    this.log(s, 'stt', { ms: Date.now() - t0, bytes: audio.length, text, ...fixed.logFields });
    s.io.emit('ai.transcript', { final: true, text });
    if (text.trim()) await this.handleTurn(s, text, 'voice');
  }

  async reset(s: AiSession, clearHistory = true, turnId?: string): Promise<EnvelopeResult> {
    const r = await this.command(s, 'reset', {}, 'ui', 8000, turnId);
    // CR-UE-02: refused -> the room (another visitor's) did not change; the reset_room tool keeps the cards, the UI button still starts a fresh talk.
    if (r.reasonCode === 'PLANNER_BUSY' && !clearHistory) return r;
    if (clearHistory) s.messages = [];
    s.cards.clear();
    s.lastCards = [];
    s.prefs = {};
    if (r.reasonCode === 'PLANNER_BUSY') return r;
    s.sets.clear();
    s.lastSetId = undefined;
    s.finishes = [];
    // QA-018: the reset result is the restored state (the room before the consultant started) -> basket from it.
    for (const x of (r.ok && Array.isArray(r.result?.sets) ? r.result.sets : []) as any[]) {
      if (!x?.setId || !x.config?.productId) continue;
      s.sets.set(x.setId, { setId: x.setId, config: fullConfig(x.config), title: this.titleFor(x.config) });
      s.lastSetId = x.setId;
    }
    if (r.ok) await this.refreshFinishes(s, r.result);
    this.emitBasket(s);
    return r;
  }

  /** QA-018: finishes from the command result, or from a get_state when the result carries none. */
  private async refreshFinishes(s: AiSession, result: any) {
    let fin = result?.finishes;
    if (!fin || typeof fin !== 'object') {
      const st = await this.command(s, 'get_state', {}, 'ui');
      fin = st.ok ? st.result?.finishes : undefined;
    }
    if (fin && typeof fin === 'object') s.finishes = finishesFromState(fin, this.catalog?.tiles() ?? []);
  }

  /**
   * CR-WEB-01: merge a guest session into the named one (the lead = the UE login). A fresh named session takes the whole
   * guest state; an existing one keeps its own conversation and gains the guest's cards, sets, finishes and renders.
   */
  mergeSessions(from: AiSession, into: AiSession) {
    const fresh = into.messages.length === 0 && into.sets.size === 0 && into.stats.turns === 0;
    if (fresh) {
      into.messages = from.messages;
      into.notes = from.notes;
      into.turnSeq = from.turnSeq;
      into.cardSeq = from.cardSeq;
      into.lastSaveId = from.lastSaveId;
      into.stats = { ...from.stats };
    } else {
      into.turnSeq = Math.max(into.turnSeq, from.turnSeq);
      into.cardSeq = Math.max(into.cardSeq, from.cardSeq);
      for (const k of Object.keys(into.stats) as (keyof AiSession['stats'])[]) into.stats[k] += from.stats[k];
    }
    for (const [k, v] of from.cards) if (!into.cards.has(k)) into.cards.set(k, v);
    if (!into.lastCards.length) into.lastCards = from.lastCards;
    for (const [k, v] of from.sets) if (!into.sets.has(k)) into.sets.set(k, v);
    into.lastSetId = from.lastSetId ?? into.lastSetId;
    if (!into.finishes.length) into.finishes = from.finishes;
    into.prefs = { ...from.prefs, ...into.prefs };
    for (const a of from.seenAmounts) into.seenAmounts.add(a);
    for (const r of from.renders) if (!into.renders.includes(r)) into.renders.push(r);
    for (const r of from.announcedRenders) into.announcedRenders.add(r);
    for (const [r, exp] of from.pendingRenders) into.pendingRenders.set(r, exp);
    into.roomHasWindow = into.roomHasWindow ?? from.roomHasWindow;
    // v2.0: mode, focus and open offers follow the visitor
    if (from.mode === 'constructor') into.mode = 'constructor';
    into.focus = into.focus ?? from.focus;
    into.booth = into.booth ?? from.booth;
    for (const [k, v] of from.seenBooths) if (!into.seenBooths.has(k)) into.seenBooths.set(k, v);
    for (const [k, v] of from.offers) into.offers.set(k, v);
    for (const t of from.offeredTopics) into.offeredTopics.add(t);
    into.pendingOffer = into.pendingOffer ?? from.pendingOffer;
    into.greeted = into.greeted || from.greeted;
    this.log(from, 'session_merged', { into: into.sessionId });
    this.log(into, 'session_merged', { from: from.sessionId, fresh });
  }

  /** Set placements + footprints from UE (get_state) for the dossier plan (QA-038). Empty on failure. */
  async placements(s: AiSession): Promise<Record<string, { segmentId: number; offsetCm: number; side?: string; footprintCm?: { width?: number; depth?: number } }>> {
    const r = await this.command(s, 'get_state', {}, 'ui');
    const out: Record<string, any> = {};
    for (const x of (r.ok && Array.isArray(r.result?.sets) ? r.result.sets : []) as any[]) if (x?.setId && x.placement) out[x.setId] = x.placement;
    return out;
  }

  /** CR-WEB-03: staff writes as the consultant (Russian text -> ai.message + consultant_say via the page). */
  async staffSay(s: AiSession, text: string) {
    s.notes.push(`[событие] Менеджер салона написал посетителю от имени консультанта: «${text}»`);
    await this.say(s, text, `t-staff-${Date.now()}`, undefined, true);
  }

  /** What the visitor told the consultant, for the dossier notes (QA-016: conversation facts, no invented claims). */
  conversationNotes(s: AiSession): string[] {
    const n: string[] = [];
    const styleRu: Record<string, string> = { light: 'светлый', white: 'белый, светлый', dark: 'тёмный', wood: 'натуральное дерево', modern: 'современный', grey: 'серый', warm: 'тёплый' };
    if (s.prefs.budgetBYN) n.push(`Бюджет, который вы назвали: до ${s.prefs.budgetBYN} BYN.`);
    if (s.prefs.style && styleRu[s.prefs.style]) n.push(`Пожелание по стилю: ${styleRu[s.prefs.style]}.`);
    if (s.finishes.length) n.push(`Выбранная отделка: ${s.finishes.map((f) => `${f.surface} — ${f.label}`).join('; ')}.`);
    if (s.stats.proposals) n.push(`Мы рассмотрели ${s.stats.cardsShown} вариантов комплектов, в проекте — ${s.sets.size}.`);
    return n;
  }
}
