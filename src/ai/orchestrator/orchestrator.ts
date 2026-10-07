import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { CatalogIndex } from '../catalog/index';
import { fullConfig, tonesOf } from '../catalog/index';
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
  constructorOptions,
  isExplicitConstructorRequest,
  wantsOtherCollection,
  isExitRequest,
  isRoomAction,
  isFitQuestion,
  scopeOptions,
  isFitTopic,
  asksForConstructor,
  isVerbalYes,
  isVerbalNo,
  boothScopeAnswer,
  collectionFromText,
  isBoothPhotoRequest,
} from './modes';
import { BoothState, boothPrice, boothTitle, collectionOf, describeBoothOptions, fitAnswer, planBoothChange } from './booth';
import { describeListing, listParts, PART_NAMES, type PartName } from './parts';
import { hasKey, renderReason, t, type Lang, type MsgKey } from '../i18n';
import { articleName, colourLabel, tileName } from '../i18n/names';

/** v2.4: configure_set inputs that go through the semantic planner (parts by DataTable id, size, paint, doors) instead of raw indices. */
const V24_SET_FIELDS = ['part', 'option', 'colour', 'colourId', 'sizeCm', 'closet', 'paintCode', 'clearPaint', 'doors', 'collection'];
import { parseRoomSize } from './intents';

/** v2.5: persona name and greetings come from the locale tables (Russian unchanged). */
export const CONSULTANT_NAME = t('ru', 'consultant.name');
export const GREETING_RU = t('ru', 'greeting.constructor');
/** v2.0: the visitor starts in the salon (showroom). */
export const GREETING_SHOWROOM_RU = t('ru', 'greeting.showroom');
export const consultantName = (lang: Lang = 'ru') => t(lang, 'consultant.name');
export const greetingFor = (lang: Lang = 'ru', mode: Mode = 'showroom') => t(lang, mode === 'constructor' ? 'greeting.constructor' : 'greeting.showroom');
/** v2.5 ai.action: the page buttons as actions (the label is what the transcript and the LLM note show). */
export type UiAction = 'undo' | 'reset_room' | 'other_collections' | 'offer_answer';

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
  /** v2.5: the visitor's language (ru default). Everything the backend says is in this language. */
  lang: Lang = 'ru';
  /** v2.5 ai.lang during a turn: applied when that turn ends (the reply in flight finishes in the old language). */
  pendingLang?: Lang;
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

export const PLANNER_BUSY_RU = t('ru', 'busy.planner');

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

/** ai.thinking step label of a tool in the session language. */
export function stepLabel(lang: Lang, tool: string): string {
  const k = `step.${tool}`;
  return t(lang, hasKey(k) ? k : 'step.default');
}

/**
 * The system prompt in the session language (v2.5): Russian is today's prompt («Говори только по-русски»), English the same
 * business rules with «Always answer in English». The catalogue summary follows the language.
 */
export function systemPrompt(catalog: CatalogIndex | null, mode: Mode = 'constructor', lang: Lang = 'ru'): string {
  return t(lang, 'prompt.system', { mode, name: t(lang, 'consultant.name'), summary: catalog ? catalog.summaryForPrompt(lang) : undefined });
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

export function finishesFromState(f: Record<string, any>, tiles: { id: string; name: string }[], lang: Lang = 'ru'): { surface: string; label: string; finish: any }[] {
  const out: { surface: string; label: string; finish: any }[] = [];
  const tileLabel = (id: string) => t(lang, 'finish.tile', { name: tileName(lang, id, tiles.find((x) => x.id === id)?.name) ?? id });
  for (const [k, v0] of Object.entries(f ?? {})) {
    if (Array.isArray(v0)) {
      const surface = /wall/.test(k) ? t(lang, 'surface.walls') : /floor/.test(k) ? t(lang, 'surface.floor') : /ceil/.test(k) ? t(lang, 'surface.ceiling') : /baseboard/.test(k) ? t(lang, 'surface.baseboard') : k;
      for (const e of v0) {
        const v = parseFinish(e?.finish ?? e);
        if (!v) continue;
        const label = v.type === 'tile' || v.tileId ? tileLabel(v.tileId) : v.code ? t(lang, 'finish.paint', { code: v.code }) : '';
        if (label && !out.some((o) => o.surface === surface && o.label === label)) out.push({ surface, label, finish: v });
      }
      continue;
    }
    const v = v0;
    if (!v || typeof v !== 'object') continue;
    const surface =
      k === 'all_walls'
        ? t(lang, 'surface.walls')
        : k === 'floor'
          ? t(lang, 'surface.floor')
          : k === 'ceiling'
            ? t(lang, 'surface.ceiling')
            : k === 'baseboard'
              ? t(lang, 'surface.baseboard')
              : k.startsWith('trim_')
                ? t(lang, 'surface.trim')
                : k.startsWith('wall_')
                  ? t(lang, 'surface.wall', { id: k.split('_')[1] })
                  : k;
    const label = v.type === 'tile' ? tileLabel(v.tileId) : v.code ? t(lang, 'finish.paint', { code: v.code }) : JSON.stringify(v);
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
      return { type: 'result', id: 'gated', cmd, ok: false, reasonCode: 'NOT_IN_PLANNER', reason: t(s.lang, 'gate.reason'), result: {}, state_rev: 0 } as EnvelopeResult;
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
    return { type: 'result', id: 'held', cmd, ok: false, reasonCode: 'PLANNER_BUSY', reason: t(s.lang, 'held.reason'), result: {} } as EnvelopeResult;
  }

  /** v2.5 §7: the visitor text for a refused UE result in the session language (Russian: UE's own reason, as before). */
  private why(s: AiSession, r: { reasonCode?: string; reason?: string; reasonParams?: Record<string, any> } | undefined, fallback?: string): string | undefined {
    const out = renderReason(s.lang, r, fallback);
    if (out.missing) this.log(s, 'reason_key_missing', { key: out.missing, lang: s.lang });
    return out.text;
  }

  // ── speech ────────────────────────────────────────────────────────────────
  /**
   * P3-05 (v2.2): the 5–10 s spoken summary of a reply (speech.ts). It may only repeat BYN figures of the full text and
   * passes the same guard rules (discounts, dates) sentence by sentence; anything dropped leaves the safe pointer.
   * v2.5: `lang` picks the pointer / fallback wording and the guard patterns (speech tuning for English is Milestone 2).
   */
  spokenFor(text: string, lang: Lang = 'ru'): string {
    const sum = spokenSummary(text, undefined, lang).text;
    if (!sum) return '';
    const g = guardReply(sum, moneyAmounts(text, lang), lang === 'ru' ? SPOKEN_FALLBACK_RU : t(lang, 'speech.fallback'), lang);
    return g.text;
  }

  async say(s: AiSession, text: string, turnId: string, gesture?: { kind: string; id?: string }, staff = false) {
    let audioUrl: string | undefined;
    let durationMs: number | undefined;
    const spokenText = this.spokenFor(text, s.lang);
    this.log(s, 'say', { turnId, chars: text.length, spokenChars: spokenText.length, spokenSecEst: estimateSpokenSeconds(spokenText), spokenText });
    try {
      // v2.0: a clip the BROWSER plays (WAV around the PCM, or MP3 from a live TTS); the 3D consultant is gone.
      // v2.2: the audio contains only the spoken summary; the chat shows the full text.
      // v2.5 hook (Milestone 2): the session language is passed on; the providers do not use it yet.
      const audio = await this.deps.tts.synthesize(spokenText || text, s.sessionId, s.lang);
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
    if (s.mode === 'constructor') return this.say(s, greetingFor(s.lang, 'constructor'), 't-0');
    await this.say(s, greetingFor(s.lang, 'showroom'), 't-0');
    if (s.focus?.boothId) await this.askBoothScope(s, 't-0');
  }

  /** CR-UE-03: the configuration carried from the salon, placed once the room exists (fit-checked first). */
  private async placeCarry(s: AiSession, origin: Origin, turnId: string): Promise<string> {
    const c = this.catalog;
    const cfg = s.pendingCarry;
    s.pendingCarry = undefined;
    if (!cfg || !c) return '';
    const title = boothTitle(c, cfg, undefined, s.lang);
    const fit = await this.command(s, 'check_fit', { candidates: [{ key: 'carry', config: cfg }] }, origin, 8000, turnId);
    const res = fit.result?.results?.[0];
    if (!fit.ok || !res?.fits || !res.placement) return t(s.lang, 'carry.noFit', { title });
    const r = await this.command(s, 'apply_config', { config: cfg, placement: { segmentId: res.placement.segmentId, side: res.placement.side, offsetCm: res.placement.offsetCm } }, origin, 8000, turnId);
    if (!r.ok) return t(s.lang, 'carry.failed', { title, why: this.why(s, r, r.reasonCode) });
    const setId = r.result?.setId ?? `set-${Date.now()}`;
    s.sets.set(setId, { setId, config: fullConfig(cfg), title });
    s.lastSetId = setId;
    s.stats.applied++;
    this.emitBasket(s);
    const q = c.quote(cfg);
    s.seenAmounts.add(q.total);
    return t(s.lang, 'carry.placed', { title, total: q.total, estimated: q.estimated });
  }

  /** v2.1 CR-WEB-04: «Показать в комнате» on a salon info card -> the constructor offer for that card (never entering directly). */
  async handleCardShow(s: AiSession, cardId: string) {
    const card = s.cards.get(cardId);
    const turnId = `t-${s.turnSeq}`;
    if (!card) {
      this.log(s, 'card_show_unknown', { cardId });
      return;
    }
    s.transcript.push({ role: 'visitor', text: t(s.lang, 'cardShow.visitor', { title: card.title }), at: new Date().toISOString() });
    this.log(s, 'card_show', { cardId });
    if (s.mode === 'constructor') return this.say(s, t(s.lang, 'cardShow.already', { title: card.title }), turnId);
    s.offeredTopics.add(`card:${cardId}`);
    await this.presentOffer(s, { kind: 'constructor', text: t(s.lang, 'offer.card', { title: card.title }), options: constructorOptions(s.lang), topic: `card:${cardId}`, carry: card.config, cardId }, turnId);
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
    s.notes.push(mode === 'constructor' ? t(s.lang, 'note.toConstructor') : t(s.lang, 'note.toShowroom'));
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
    const aboutItem =
      /(тумб|модел|комплект|шкаф|пенал|раковин|эт[уоа]|е[её](?![а-я])|он[аи]?(?![а-я])|влез|помест|впиш|габарит)/.test(t) ||
      !!col ||
      (s.lang === 'en' && /\b(vanity|unit|model|set|cabinet|basin|sink|this|it|fits?|dimensions?)\b/.test(t));
    return { key: `fit:${s.focus?.boothId ?? 'none'}`, specific: aboutItem && (!!s.focus?.boothId || !!col) };
  }

  /** One constructor offer per topic (unless the visitor asked for it); queued to follow this turn's reply. */
  private queueConstructorOffer(s: AiSession, topic: string, force: boolean, specific = false) {
    if (s.mode !== 'showroom') return false;
    if (!force && s.offeredTopics.has(topic)) return false;
    s.offeredTopics.add(topic);
    const boothId = specific && topic === `fit:${s.focus?.boothId}` ? s.focus?.boothId : undefined;
    s.turnOffer = { kind: 'constructor', text: specific ? t(s.lang, 'offer.constructorModel') : t(s.lang, 'offer.constructor'), options: constructorOptions(s.lang), topic, ...(boothId ? { boothId } : {}) };
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
    const L = s.lang;
    const named = typeof input?.collection === 'string' && input.collection.trim() ? collectionFromText(input.collection) ?? input.collection.trim() : undefined;
    const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    let target: { boothId: string; collection?: string } | undefined = s.focus?.boothId ? { boothId: s.focus.boothId, collection: s.focus.collection } : undefined;
    if (named && !same(target?.collection, named)) {
      const seen = [...s.seenBooths.values()].reverse().find((b) => same(b.collection, named));
      if (!seen) {
        this.log(s, 'booth_photo_no_booth', { named, focus: s.focus?.boothId ?? null });
        return { ok: false, reasonCode: 'NO_BOOTH', say: t(L, 'photo.boothNotNear', { named }) };
      }
      target = seen;
    }
    if (!target) {
      this.log(s, 'booth_photo_no_booth', { named: named ?? null, focus: null });
      s.offeredTopics.add('room:photo');
      s.turnOffer = { kind: 'constructor', text: t(L, 'offer.boothPhoto'), options: constructorOptions(L), topic: 'room:photo' };
      return { ok: false, reasonCode: 'NO_BOOTH', say: t(L, 'photo.boothNoFocus') };
    }
    const renderId = `rn-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    s.announcedRenders.add(renderId);
    s.pendingRenders.set(renderId, Date.now() + RENDER_PENDING_TTL_MS);
    s.io.emit('ai.render', { renderId, stage: 'capturing' });
    const r = await this.command(s, 'capture', { renderId, preset: 'booth', boothId: target.boothId, sessionId: s.sessionId }, origin, 20000, turnId);
    if (!r.ok) {
      s.pendingRenders.delete(renderId);
      s.io.emit('ai.render', { renderId, stage: 'failed', reason: this.why(s, r, r.reasonCode) });
      const say =
        r.reasonCode === 'NO_BOOTH'
          ? t(L, 'photo.boothNotFound')
          : r.reasonCode === 'BAD_ARGS' && s.mode !== 'showroom'
            ? t(L, 'photo.boothInSalon')
            : t(L, 'photo.boothFailed');
      return { ok: false, reasonCode: r.reasonCode, say };
    }
    s.renders.push(renderId);
    s.stats.photos++;
    const col = target.collection ?? s.seenBooths.get(target.boothId)?.collection;
    return { ok: true, renderId, boothId: target.boothId, say: t(L, 'photo.boothTaking', { col }) };
  }

  async askBoothScope(s: AiSession, turnId: string) {
    const f = s.focus;
    if (!f?.boothId) return;
    const collection = f.collection ?? t(s.lang, 'scope.thisFallback');
    s.scopeAsked.set(f.boothId, Date.now());
    await this.presentOffer(s, { kind: 'booth_scope', text: t(s.lang, 'scope.question', { collection }), options: scopeOptions(collection, s.lang), boothId: f.boothId }, turnId);
  }

  /** booth_get for the booth in focus (or boothId); caches the state. */
  private async readBooth(s: AiSession, boothId: string | undefined, origin: Origin, turnId: string): Promise<{ st?: BoothState; say?: string; reasonCode?: string }> {
    const r = await this.command(s, 'booth_get', boothId ? { boothId } : {}, origin, 8000, turnId);
    if (!r.ok || !r.result?.productId) return { say: r.reasonCode === 'NO_BOOTH' || !r.ok ? t(s.lang, 'booth.none') : t(s.lang, 'booth.readFailed'), reasonCode: r.reasonCode ?? 'NO_BOOTH' };
    const st = r.result as BoothState;
    s.booth = st;
    this.noteBooth(s, { boothId: st.boothId, productId: st.productId, collection: st.collection ?? (this.catalog ? collectionOf(this.catalog, st.productId) : undefined), label: st.label });
    if (s.focus?.boothId === st.boothId || !s.focus) s.focus = { boothId: st.boothId, productId: st.productId, collection: st.collection ?? (this.catalog ? collectionOf(this.catalog, st.productId) : undefined), label: st.label };
    return { st };
  }

  /** «Эту коллекцию»: this booth's real options. */
  private async boothScopeThis(s: AiSession, origin: Origin, turnId: string): Promise<string> {
    const c = this.catalog;
    if (!c) return t(s.lang, 'catalog.unavailable');
    const { st, say } = await this.readBooth(s, s.focus?.boothId, origin, turnId);
    if (!st) return say!;
    const d = describeBoothOptions(c, st, s.lang);
    d.amounts.forEach((a) => s.seenAmounts.add(a));
    return d.say;
  }

  /** «Другие коллекции»: which collection to put on the booth instead. */
  private collectionPickOffer(s: AiSession): Omit<Offer, 'offerId' | 'validTurn' | 'createdAt' | 'open'> | null {
    const c = this.catalog;
    const cur = s.booth?.productId ?? s.focus?.productId;
    const curCol = s.focus?.collection ?? (cur && c ? collectionOf(c, cur) : t(s.lang, 'pick.thisFallback'));
    if (!c) return null;
    const options = c
      .listProducts()
      .filter((p) => p.productId !== cur && c.isCollectionEnabled(p.collection ?? '') && (!s.booth?.products?.length || s.booth.products.includes(p.productId)))
      .map((p) => ({ id: p.collection ?? p.productId, label: p.collection ?? p.productId }));
    return { kind: 'collection_pick', text: t(s.lang, 'pick.question', { collection: curCol }), options, boothId: s.focus?.boothId };
  }

  /** v2.0 booth_configure from a semantic request (tool input or a button). */
  private async boothConfigure(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    const L = s.lang;
    if (!c) return { ok: false, say: t(L, 'catalog.unavailable') };
    let st = s.booth && (!input.boothId || input.boothId === s.booth.boothId) && (!s.focus || s.focus.boothId === s.booth.boothId) ? s.booth : undefined;
    if (!st) {
      const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
      if (!r.st) return { ok: false, reasonCode: r.reasonCode, say: r.say };
      st = r.st;
    }
    const plan = planBoothChange(c, st, input, L);
    if (plan.kind === 'say') return { ok: plan.ok, ...(plan.noChange ? { noChange: true } : {}), say: plan.say };
    const before = fullConfig(st.config);
    const r = await this.command(s, 'booth_configure', { boothId: st.boothId, ...plan.args }, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: t(L, 'booth.changeFailed', { why: this.why(s, r, r.reasonCode) }) };
    const after: BoothState = r.result?.productId ? (r.result as BoothState) : { ...st, config: fullConfig({ ...st.config, ...(plan.args.config ?? {}) }) };
    s.booth = after;
    this.noteBooth(s, { boothId: after.boothId, productId: after.productId, collection: after.collection ?? collectionOf(c, after.productId), label: after.label });
    if (s.focus?.boothId === after.boothId) s.focus = { ...s.focus, productId: after.productId, collection: after.collection ?? collectionOf(c, after.productId) };
    const same = after.productId === before.productId && JSON.stringify(fullConfig(after.config)) === JSON.stringify(before);
    const extrasOnly = !plan.args.config && !plan.args.productId && (plan.args.doors || plan.args.clearCustomColour);
    if (same && !plan.args.customColour && !extrasOnly) return { ok: false, noChange: true, say: t(L, 'booth.notApplied') };
    // v2.4: never claim doors / a cleared colour UE did not apply (its boothState carries both)
    const doorsWanted = plan.args.doors ? (Object.entries(plan.args.doors)[0] as [string, string]) : undefined;
    if (doorsWanted && after.doors && after.doors[doorsWanted[0] as 'cabinet' | 'closet'] !== doorsWanted[1]) {
      return { ok: false, noChange: true, say: t(L, 'booth.doorsFailed') };
    }
    if (plan.args.clearCustomColour && (after.customColours ?? []).some((x) => x.component === plan.args.clearCustomColour)) {
      return { ok: false, noChange: true, say: t(L, 'booth.clearPaintFailed') };
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
        return { ok: false, noChange: true, say: t(L, 'booth.paintFailed', { code: want.code }) };
      }
    }
    const q = c.quote(after.config);
    s.seenAmounts.add(q.total);
    return { ok: true, boothId: after.boothId, say: t(L, 'booth.done', { what: plan.what, title: boothTitle(c, after.config, after.customColours, L), price: boothPrice(q.total, q.estimated, after.customColours, L) }) };
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
      if (s.busyHits !== hits || r.reasonCode === 'PLANNER_BUSY') return t(s.lang, 'busy.enter');
      return t(s.lang, 'enter.failed', { why: this.why(s, r, r.reasonCode) });
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
    const title = carry && this.catalog ? boothTitle(this.catalog, carry, undefined, s.lang) : '';
    if (carried) return t(s.lang, 'enter.carried', { title });
    return t(s.lang, 'enter.ok', { carry: !!carry, title });
  }

  /** Buttons under a message (ai.offer.answer). Runs outside a visitor turn. */
  async handleOfferAnswer(s: AiSession, offerId: string, optionId: string) {
    const offer = s.offers.get(offerId);
    const turnId = `t-${s.turnSeq}`;
    // QA pointer 2: a tap is never ignored silently.
    if (!offer) {
      this.log(s, 'offer_unknown', { offerId, optionId });
      await this.say(s, t(s.lang, 'offer.stale'), turnId);
      return;
    }
    if (!offer.open || Date.now() - offer.createdAt > OFFER_TTL_MS) {
      this.log(s, 'offer_late', { offerId, kind: offer.kind, optionId });
      if (offer.kind === 'constructor' && optionId === 'yes' && s.mode === 'constructor') {
        await this.say(s, t(s.lang, 'constructor.already'), turnId);
        return;
      }
      // a «Да, перейти» tap is explicit consent while the visitor is still in the salon (any age); booth buttons act only
      // while that booth is still in focus
      if ((offer.kind === 'booth_scope' || offer.kind === 'collection_pick') && offer.boothId && s.focus?.boothId !== offer.boothId) {
        await this.say(s, t(s.lang, 'offer.boothGone'), turnId);
        return;
      }
    }
    const label = offer.options.find((o) => o.id === optionId)?.label ?? optionId;
    s.transcript.push({ role: 'visitor', text: label, at: new Date().toISOString() });
    s.notes.push(t(s.lang, 'note.pressed', { label }));
    this.log(s, 'offer_answer', { offerId, kind: offer.kind, optionId });
    offer.open = false;
    if (s.pendingOffer === offer) s.pendingOffer = undefined;
    await this.answerOffer(s, offer, optionId, 'ui', turnId);
  }

  private async answerOffer(s: AiSession, offer: Offer, optionId: string, origin: Origin, turnId: string): Promise<void> {
    if (offer.kind === 'constructor') {
      if (optionId === 'yes') await this.say(s, await this.acceptConstructor(s, offer, origin, turnId), turnId);
      else await this.say(s, t(s.lang, 'stay'), turnId);
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
    const L = s.lang;
    const pend = s.pendingOffer;
    s.pendingOffer = undefined;
    if (pend && pend.open && pend.validTurn === turnNo) {
      if (pend.kind === 'constructor') {
        if (isVerbalYes(text, L)) return { handled: true, reply: await this.acceptConstructor(s, pend, 'model', turnId) };
        pend.open = false; // anything else is a no
        this.log(s, 'offer_declined', { offerId: pend.offerId, text: text.slice(0, 80) });
        if (isVerbalNo(text, L)) return { handled: true, reply: t(L, 'stay') };
      } else if (pend.kind === 'booth_scope') {
        const a = boothScopeAnswer(text, L);
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
      const m = /^покажи(те)? в комнате:\s*(.+)$/i.exec(text.trim()) ?? (L === 'en' ? /^show (it )?in (?:the |my )?room:\s*(.+)$/i.exec(text.trim()) : null);
      const card = m ? s.lastCards.find((k) => k.title.toLowerCase() === m[2].trim().toLowerCase()) : undefined;
      if (card) {
        const o = { kind: 'constructor' as const, text: t(L, 'offer.card', { title: card.title }), options: constructorOptions(L), topic: `card:${card.cardId}`, carry: card.config, cardId: card.cardId };
        s.offeredTopics.add(o.topic);
        return { handled: true, reply: o.text, offer: o };
      }
    }
    // QA-077: leaving the Constructor by voice / text -> exit_constructor (deterministic)
    if (s.mode === 'constructor' && isExitRequest(text, L)) {
      s.exiting = true;
      const r = await this.command(s, 'exit_constructor', {}, 'model', 8000, turnId).finally(() => (s.exiting = false));
      if (!r.ok) return { handled: true, reply: t(L, 'exit.failed', { why: this.why(s, r, r.reasonCode) }) };
      this.setMode(s, 'showroom', 'exit');
      return { handled: true, reply: t(L, 'exit.done') };
    }
    // QA-080: a fit / size question in the salon is INFORMATIONAL: an honest answer from catalogue dimensions, never a booth
    // change; the constructor offer once per topic, afterwards only a short hint without buttons.
    if (s.mode === 'showroom' && (isFitQuestion(text, L) || (text.includes('?') && !!parseRoomSize(text, L))) && !isExplicitConstructorRequest(text, L)) {
      const c = this.catalog;
      if (c) {
        const answer = fitAnswer(c, s.booth?.config ?? (s.focus?.productId ? { productId: s.focus.productId, sizeIndex: 0, colourIndex: 0 } : undefined), text, parseRoomSize(text, L), L);
        const topic = `fit:${s.focus?.boothId ?? 'none'}`;
        this.log(s, 'fit_answer', { topic, offered: s.offeredTopics.has(topic) });
        if (s.offeredTopics.has(topic)) return { handled: true, reply: `${answer} ${t(L, 'fit.hint')}` };
        s.offeredTopics.add(topic);
        const specific = !!s.focus?.boothId || !!collectionFromText(text);
        const o = { kind: 'constructor' as const, text: specific ? t(L, 'offer.constructorModel') : t(L, 'offer.constructor'), options: constructorOptions(L), topic, ...(specific && s.focus?.boothId ? { boothId: s.focus.boothId } : {}) };
        return { handled: true, reply: `${answer} ${o.text}`, offer: o };
      }
    }
    // v2.2 P3-02: a photo of a salon booth is taken right here (the booth in focus or a named one); without a booth an
    // honest answer + the Constructor offer. A photo of the room / the bathroom and the dossier stay in the Constructor.
    if (s.mode === 'showroom' && isBoothPhotoRequest(text, L)) {
      const out = await this.runTool(s, 'take_photo', { collection: collectionFromText(text) }, 'model', turnId);
      const o = s.turnOffer;
      s.turnOffer = undefined;
      return { handled: true, reply: o ? `${out.say} ${o.text}` : out.say, ...(o ? { offer: o } : {}) };
    }
    // QA-077: a room action asked for in the salon -> the honest constructor offer (the visitor asked: offered even if offered before)
    const noRoomWords = (x: string) => (L === 'en' ? x.replace(/(комнат[а-я]*|санузел)/gi, '').replace(/\b(bath)?rooms?\b/gi, '') : x.replace(/(комнат[а-я]*|санузел)/gi, ''));
    if (s.mode === 'showroom' && !isExplicitConstructorRequest(text, L) && !isFitTopic(noRoomWords(text), L) ) {
      const kind = isRoomAction(text, L);
      if (kind) {
        s.offeredTopics.add(`fit:${s.focus?.boothId ?? 'none'}`);
        const o = { kind: 'constructor' as const, text: kind === 'photo' ? t(L, 'offer.photo') : t(L, 'offer.room'), options: constructorOptions(L), topic: `room:${kind}` };
        return { handled: true, reply: o.text, offer: o };
      }
    }
    // WEB finding: another collection for the booth in focus, at any time -> «Какую коллекцию поставить вместо X?»
    if (s.mode === 'showroom' && s.focus?.boothId && wantsOtherCollection(text, L)) {
      const o = this.collectionPickOffer(s);
      if (o) return { handled: true, reply: o.text, offer: o };
    }
    // QA pointer 1: the visitor's own explicit request to go is consent -> move now (carry the booth only when the request is about it).
    if (s.mode === 'showroom' && isExplicitConstructorRequest(text, L)) {
      const lt = text.toLowerCase().replace(/ё/g, 'е');
      const aboutBooth = !!s.focus?.boothId && (/(эт[уоа]|е[её]|тумб|модел|стенд|комплект|коллекци)/.test(lt) || (L === 'en' && /\b(this|it|vanity|unit|model|booth|display|set|collection)\b/.test(lt)));
      const consent: Offer = { offerId: 'request', kind: 'constructor', text: '', options: constructorOptions(L), topic: 'request', ...(aboutBooth ? { boothId: s.focus!.boothId } : {}), validTurn: turnNo, createdAt: Date.now(), open: true };
      this.log(s, 'consent_request', { text: text.slice(0, 80), carryBooth: aboutBooth });
      return { handled: true, reply: await this.acceptConstructor(s, consent, 'model', turnId) };
    }
    // Constructor topic in the salon: one offer per topic (or whenever the visitor asks), after this turn's answer.
    if (s.mode === 'showroom') {
      const asks = asksForConstructor(text, L);
      if (asks || isFitTopic(text, L)) {
        const tp = this.constructorTopic(s, text);
        this.queueConstructorOffer(s, tp.key, asks, tp.specific);
      }
      else if (/(фото|сфотограф|снимок|досье|pdf|пдф|сохрани|пришли|отправ)/i.test(text) || (L === 'en' && /(photo|picture|snapshot|dossier|\bsave\b|\bsend\b)/i.test(text))) this.queueConstructorOffer(s, `fit:${s.focus?.boothId ?? 'none'}`, false);
      if (asks && !isFitTopic(L === 'en' ? text.replace(/конструктор[а-я]*/gi, '').replace(/(constructor|room planner|planner|real size|actual size|full size)/gi, '') : text.replace(/конструктор[а-я]*/gi, ''), L)) {
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
        lines: (q?.lines ?? []).map((l) => ({ component: l.component, articleCode: l.articleCode, name: s.lang === 'ru' ? l.name : articleName(s.lang, l.name, set.title), price: l.price, ...(l.estimated ? { estimated: true } : {}), ...(l.unpriced ? { unpriced: true } : {}) })),
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

  private titleFor(cfg: SetConfig, lang: Lang = 'ru') {
    const c = this.catalog;
    const p = c?.getProduct(cfg.productId);
    const closet = (cfg.closetSizeIndex ?? -1) >= 0 ? t(lang, 'title.withCloset') : '';
    return `${p?.collection ?? cfg.productId} ${c?.sizeName(cfg) ?? ''}, ${colourLabel(lang, c?.colourName(cfg))}${closet}`.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim();
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
      s.notes.push(t(s.lang, 'note.cardBusy', { title: card.title }));
      await this.say(s, t(s.lang, 'tap.busy', { title: card.title }), turnId);
      return;
    }
    if (tap.result && !tap.result.ok) {
      s.notes.push(t(s.lang, 'note.cardFailed', { title: card.title, why: this.why(s, tap.result, tap.result.reasonCode) }));
      await this.say(s, t(s.lang, 'tap.failed', { title: card.title, why: this.why(s, tap.result, t(s.lang, 'tap.noAnswer')) }), turnId);
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
    s.notes.push(t(s.lang, 'note.cardChosen', { title: card.title, price: card.price, setId }));
    this.emitBasket(s);
    await this.say(s, t(s.lang, 'tap.chosen', { title: card.title, price: card.price }), turnId, setId ? { kind: 'set', id: setId } : undefined);
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  async runTool(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    // v2.0 tool gating: room tools only in «Конструктор» (never a room command from the salon).
    if (!toolsAllowed(s.mode).has(name)) {
      this.log(s, 'mode_gate_tool', { name, mode: s.mode, turnId });
      if (s.mode === 'showroom') {
        this.queueConstructorOffer(s, `fit:${s.focus?.boothId ?? 'none'}`, false);
        return { ok: false, reasonCode: 'NOT_IN_PLANNER', say: name === 'save_project' ? t(s.lang, 'gate.dossier') : t(s.lang, 'gate.room') };
      }
      return { ok: false, say: name === 'catalog_suggest' ? t(s.lang, 'gate.suggest') : t(s.lang, 'constructor.already') };
    }
    const hits = s.busyHits;
    const out = await this.runToolInner(s, name, input, origin, turnId);
    if (s.busyHits === hits || out?.ok !== false || out?.busyHandled) return out;
    // CR-UE-02: a planner command came back PLANNER_BUSY (or was held back) -> one honest explanation per turn, never a retry.
    const first = s.busySaidTurn !== turnId;
    s.busySaidTurn = turnId;
    const say =
      name === 'take_photo' || name === 'save_project'
        ? t(s.lang, 'busy.photo')
        : name === 'consultant_summon'
          ? t(s.lang, 'busy.summon')
          : s.lastCards.length
            ? t(s.lang, 'busy.withCards')
            : t(s.lang, 'busy.planner');
    return { ok: false, reasonCode: 'PLANNER_BUSY', retry: false, ...(first ? { say } : {}) };
  }

  private async runToolInner(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    const L = s.lang;
    const fail = (say: string, extra: any = {}) => ({ ok: false, say, ...extra });
    switch (name) {
      case 'get_state': {
        const r = await this.command(s, 'get_state', {}, origin, 8000, turnId);
        if (r.ok && Array.isArray(r.result?.walls)) s.roomHasWindow = r.result.walls.some((w: any) => (w.openings ?? []).some((o: any) => o.kind === 'window'));
        return r.ok ? { ok: true, state: r.result } : fail(t(L, 'room.readFailed'), { reasonCode: r.reasonCode });
      }
      case 'build_room': {
        const args: any = { widthCm: input.widthCm, depthCm: input.depthCm };
        if (input.heightCm) args.heightCm = input.heightCm;
        if (input.openings?.length) args.openings = input.openings;
        const r = await this.command(s, 'build_room', args, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'OPENING_CONFLICT' ? t(L, 'room.openingConflict') : t(L, 'room.buildFailed', { why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        s.sets.clear();
        s.lastSetId = undefined;
        s.roomHasWindow = (args.openings ?? []).some((o: any) => o.kind === 'window');
        this.emitBasket(s);
        const carryNote = s.pendingCarry ? await this.placeCarry(s, origin, turnId) : '';
        return { ok: true, say: t(L, 'room.built', { w: args.widthCm, d: args.depthCm, openings: (args.openings ?? []).map((o: any) => o.kind), carry: carryNote }), walls: r.result?.walls?.map((w: any) => ({ segmentId: w.segmentId, lengthCm: w.lengthCm })) };
      }
      case 'propose_sets':
        return this.proposeSets(s, input, origin, turnId);
      case 'apply_card': {
        const card =
          (input.cardId && s.cards.get(input.cardId)) ||
          (input.tier && s.lastCards.find((k) => k.tier === input.tier)) ||
          (input.position && s.lastCards[input.position - 1]);
        if (!card) return fail(s.lastCards.length ? t(L, 'card.none') : t(L, 'card.proposeFirst'));
        const r = await this.command(s, 'apply_config', { config: card.config, placement: card.placement, cardId: card.cardId }, origin, 8000, turnId);
        if (!r.ok) return fail(t(L, 'card.applyFailed', { title: card.title, why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        const setId = r.result?.setId ?? `set-${Date.now()}`;
        s.sets.set(setId, { setId, config: fullConfig(card.config), title: card.title, cardId: card.cardId });
        s.lastSetId = setId;
        s.stats.applied++;
        this.emitBasket(s);
        s.seenAmounts.add(card.price);
        return { ok: true, setId, say: t(L, 'card.applied', { title: card.title, price: card.price }), gesture: { kind: 'set', id: setId } };
      }
      case 'configure_set':
        return this.configureSet(s, input, origin, turnId);
      case 'swap_set': {
        const setId = input.setId ?? s.lastSetId;
        const card = input.cardId ? s.cards.get(input.cardId) : undefined;
        if (!setId || !s.sets.has(setId)) return fail(t(L, 'swap.noSet'));
        if (!card) return fail(t(L, 'swap.pickCard'));
        const r = await this.command(s, 'swap_set', { setId, config: card.config }, origin, 8000, turnId);
        if (!r.ok) return fail(t(L, 'swap.failed', { why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        s.sets.set(setId, { setId, config: fullConfig(card.config), title: card.title, cardId: card.cardId });
        this.emitBasket(s);
        return { ok: true, setId, say: t(L, 'swap.done', { title: card.title, price: card.price }), gesture: { kind: 'set', id: setId } };
      }
      case 'remove_set': {
        const setId = input.setId ?? s.lastSetId;
        if (!setId) return fail(t(L, 'remove.noSet'));
        const r = await this.command(s, 'remove_set', { setId }, origin, 8000, turnId);
        if (!r.ok) return fail(t(L, 'remove.failed', { why: this.why(s, r, r.reasonCode) }));
        s.sets.delete(setId);
        if (s.lastSetId === setId) s.lastSetId = [...s.sets.keys()].pop();
        this.emitBasket(s);
        return { ok: true, say: t(L, 'remove.done') };
      }
      case 'finish_surface': {
        let finish: any;
        let label: string;
        if (input.clear) {
          // v2.4: back to the default material
          finish = { type: 'none' };
          label = t(L, 'finish.default');
        } else if (input.target === 'opening_trim' && input.tileId) {
          return fail(t(L, 'finish.trimTile'));
        } else if (input.tileId) {
          const tiles = this.catalog?.tiles() ?? [];
          const tile = tiles.find((x) => x.id === input.tileId);
          if (tiles.length && !tile) return fail(t(L, 'finish.noTile', { list: tiles.map((x) => tileName(L, x.id, x.name)) }));
          finish = { type: 'tile', tileId: input.tileId };
          label = t(L, 'finish.tile', { name: tile ? tileName(L, tile.id, tile.name) : input.tileId });
        } else if (input.paintCode) {
          finish = { type: 'paint', system: input.paintSystem ?? (/^S\s/.test(input.paintCode) ? 'NCS' : 'RAL'), code: input.paintCode };
          label = t(L, 'finish.paint', { code: input.paintCode });
        } else {
          return fail(t(L, 'finish.floorHint'));
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
        if (!r.ok) return fail(t(L, 'finish.failed', { why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        const surface =
          target.kind === 'all_walls'
            ? t(L, 'surface.walls')
            : target.kind === 'floor'
              ? t(L, 'surface.floor')
              : target.kind === 'ceiling'
                ? t(L, 'surface.ceiling')
                : target.kind === 'baseboard'
                  ? t(L, 'surface.baseboard')
                  : target.kind === 'opening_trim'
                    ? t(L, 'surface.trim')
                    : t(L, 'surface.wall', { id: target.segmentId });
        s.finishes = s.finishes.filter((f) => f.surface !== surface).concat(finish.type === 'none' ? [] : [{ surface, label, finish }]);
        this.emitBasket(s);
        return { ok: true, say: finish.type === 'none' ? t(L, 'finish.cleared', { surface }) : t(L, 'finish.done', { surface, label }) };
      }
      case 'check_fit': {
        const cfg = fullConfig({ ...(s.lastSetId ? s.sets.get(s.lastSetId)?.config : {}), ...input.config } as SetConfig);
        const r = await this.command(s, 'check_fit', { candidates: [{ key: 'q', config: cfg, ...(input.segmentId !== undefined ? { placement: { segmentId: input.segmentId } } : {}) }] }, origin, 8000, turnId);
        const res = r.result?.results?.[0];
        if (!r.ok || !res) return fail(t(L, 'fit.failed'));
        return res.fits
          ? { ok: true, fits: true, spareCm: res.placement?.spareCm, say: t(L, 'fit.fits', { spare: Math.round(res.placement?.spareCm ?? 0) }) }
          : { ok: true, fits: false, reason: res.reason, say: t(L, 'fit.noFit', { why: L === 'ru' ? res.reason : this.why(s, res, res.reason) }) };
      }
      case 'reset_room': {
        const r = await this.reset(s, false, turnId); // keep this turn's messages (tool_use/tool_result pairing)
        if (r.reasonCode === 'PLANNER_BUSY') return fail(t(L, 'reset.busy'), { reasonCode: 'PLANNER_BUSY' });
        return { ok: true, say: t(L, 'reset.done') };
      }
      case 'undo': {
        const r = await this.command(s, 'undo', {}, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'NOTHING_TO_UNDO' ? t(L, 'undo.nothing') : t(L, 'undo.failed'));
        const sets = (r.result?.sets ?? []) as any[];
        if (Array.isArray(r.result?.sets)) {
          const keep = new Map<string, PlacedSetInfo>();
          for (const x of sets) keep.set(x.setId, s.sets.get(x.setId) ?? { setId: x.setId, config: fullConfig(x.config), title: this.titleFor(x.config, L) });
          for (const [id, v] of keep) if (s.sets.has(id)) v.config = fullConfig(sets.find((y) => y.setId === id).config);
          s.sets = keep;
          s.lastSetId = [...keep.keys()].pop();
        }
        await this.refreshFinishes(s, r.result);
        this.emitBasket(s);
        return { ok: true, say: t(L, 'undo.done') };
      }
      case 'save_project': {
        // QA-050: held for PLANNER_BUSY -> no dossier stage at all (no building, no failed); the consultant promises it for later.
        if (await this.ownerHold(s, 'save_project', turnId)) return fail(t(L, 'save.held'), { reasonCode: 'PLANNER_BUSY' });
        s.io.emit('ai.dossier', { stage: 'building' });
        const r = await this.command(s, 'save_project', { projectName: input.projectName ?? t(L, 'save.projectName', { username: s.username }) }, origin, 15000, turnId);
        if (!r.ok) {
          if (r.reasonCode !== 'PLANNER_BUSY') s.io.emit('ai.dossier', { stage: 'failed' });
          return fail(t(L, 'save.failed'), { reasonCode: r.reasonCode });
        }
        s.lastSaveId = r.result?.saveId;
        s.lastSaveUsername = typeof r.result?.username === 'string' && r.result.username ? r.result.username : undefined;
        s.stats.exports++;
        if (this.deps.onSaveProject && s.lastSaveId) {
          this.deps.onSaveProject(s, s.lastSaveId, s.lastSaveUsername).catch((e) => this.log(s, 'dossier_error', { message: e.message }));
        }
        return { ok: true, saveId: s.lastSaveId, say: t(L, 'save.done') };
      }
      case 'take_photo': {
        // v2.2 P3-02: in the salon the photo is the clean capture of a booth (no AI render).
        if (s.mode === 'showroom') return this.boothPhoto(s, input, origin, turnId);
        // QA-050: the same for the photo: held -> no capturing/failed render card.
        if (await this.ownerHold(s, 'capture', turnId)) return fail(t(L, 'photo.held'), { reasonCode: 'PLANNER_BUSY' });
        const renderId = `rn-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        s.announcedRenders.add(renderId);
        // QA-051: /api/render accepts only this id, for this session, once, within the TTL.
        s.pendingRenders.set(renderId, Date.now() + RENDER_PENDING_TTL_MS);
        s.io.emit('ai.render', { renderId, stage: 'capturing' });
        const preset = ['corner', 'frontal', 'wide'].includes(input.preset) ? input.preset : 'corner';
        const r = await this.command(s, 'capture', { renderId, preset, sessionId: s.sessionId }, origin, 20000, turnId);
        if (!r.ok) {
          s.pendingRenders.delete(renderId);
          if (r.reasonCode !== 'PLANNER_BUSY') s.io.emit('ai.render', { renderId, stage: 'failed', reason: this.why(s, r, r.reasonCode) });
          return fail(t(L, 'photo.failed'), { reasonCode: r.reasonCode });
        }
        s.renders.push(renderId);
        s.stats.photos++;
        return { ok: true, renderId, say: t(L, 'photo.taking') };
      }
      case 'catalog_suggest':
        return this.catalogSuggest(s, input, turnId);
      case 'booth_get': {
        const c2 = this.catalog;
        if (!c2) return fail(t(L, 'catalog.unavailable'));
        const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
        if (!r.st) return fail(r.say!, { reasonCode: r.reasonCode });
        const d = describeBoothOptions(c2, r.st, L);
        d.amounts.forEach((a) => s.seenAmounts.add(a));
        return { ok: true, boothId: r.st.boothId, productId: r.st.productId, config: r.st.config, say: d.say };
      }
      case 'booth_configure':
        return this.boothConfigure(s, input, origin, turnId);
      case 'booth_undo': {
        const r = await this.command(s, 'booth_undo', input.boothId ? { boothId: input.boothId } : {}, origin, 8000, turnId);
        if (!r.ok) return fail(r.reasonCode === 'NOTHING_TO_UNDO' ? t(L, 'boothUndo.nothing') : r.reasonCode === 'NO_BOOTH' ? t(L, 'booth.none') : t(L, 'boothUndo.failed', { why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        if (r.result?.productId) {
          s.booth = r.result as BoothState;
          this.noteBooth(s, { boothId: s.booth.boothId, productId: s.booth.productId, collection: s.booth.collection ?? (c ? collectionOf(c, s.booth.productId) : undefined), label: s.booth.label });
        }
        if (s.booth && s.focus?.boothId === s.booth.boothId && c) s.focus = { ...s.focus, productId: s.booth.productId, collection: s.booth.collection ?? collectionOf(c, s.booth.productId) };
        const q = s.booth && c ? c.quote(s.booth.config) : undefined;
        if (q) s.seenAmounts.add(q.total);
        return { ok: true, say: t(L, 'boothUndo.done', s.booth && c ? { title: boothTitle(c, s.booth.config, s.booth.customColours, L), price: boothPrice(q!.total, q!.estimated, s.booth.customColours, L) } : {}) };
      }
      case 'offer_constructor': {
        const tp = this.constructorTopic(s, String(input.topic ?? ''));
        const queued = this.queueConstructorOffer(s, tp.key, false, !!s.focus?.boothId);
        return { ok: true, offered: queued, say: '' };
      }
      case 'exit_constructor': {
        s.exiting = true;
        const r = await this.command(s, 'exit_constructor', {}, origin, 8000, turnId).finally(() => (s.exiting = false));
        if (!r.ok) return fail(t(L, 'exit.failed', { why: this.why(s, r, r.reasonCode) }), { reasonCode: r.reasonCode });
        this.setMode(s, 'showroom', 'exit');
        return { ok: true, say: t(L, 'exit.done') };
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
        return fail(t(L, 'tool.unknown'));
    }
  }

  /** v2.0 showroom: up to three sets as INFORMATION (price, dimensions, materials) — no placement, no fit check. */
  private catalogSuggest(s: AiSession, input: ProposeArgs, turnId = `t-${s.turnSeq}`) {
    const c = this.catalog;
    const L = s.lang;
    if (!c) return { ok: false, say: t(L, 'catalog.loading') };
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
        return { ok: true, items: [], say: t(L, 'suggest.overBudget', { budget: args.budgetBYN, min }) };
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
    if (!picked.length) return { ok: true, items: [], say: t(L, 'catalog.noPriced') };
    const items = picked.map((x) => {
      const p = c.getProduct(x.config.productId);
      const sz = p?.cabinet.sizes.find((z) => z.index === x.config.sizeIndex);
      const dims = t(L, 'dims.cm', { w: sz?.widthCm, d: sz?.depthCm, h: sz?.heightCm, name: sz?.name });
      s.seenAmounts.add(x.quote.total);
      return { title: boothTitle(c, x.config, undefined, L), price: x.quote.total, estimated: x.quote.estimated, dims, material: colourLabel(L, c.colourName(x.config)) };
    });
    // v2.0: the same picks as salon INFORMATION cards (no placement); «Показать в комнате» -> ai.card.show -> consent offer
    const tiers = ['best_fit', 'best_value', 'premium'] as const;
    const cards = picked.map((x, n) => buildInfoCard(x, picked.length === 1 ? ('single' as any) : tiers[n], c.syncedAt, `k-${s.turnSeq}-${++s.cardSeq}`, L));
    s.lastCards = cards;
    for (const k of cards) {
      s.cards.set(k.cardId, k);
      s.seenAmounts.add(k.price);
      k.items.forEach((i) => s.seenAmounts.add(i.price));
    }
    s.stats.cardsShown += cards.length;
    s.io.emit('ai.cards', { turnId, cards });
    const list = items.map((i, n) => t(L, 'suggest.item', { n: n + 1, title: i.title, price: i.price, estimated: i.estimated, dims: i.dims })).join('; ');
    // P3-05: a speakable summary first (the voice says it), the list for the chat after it
    return { ok: true, items, say: t(L, 'suggest.done', { n: items.length, list }) };
  }

  private catalogLookup(s: AiSession, q: string) {
    const c = this.catalog;
    if (!c) return { ok: false, say: t(s.lang, 'catalog.unavailable') };
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
      return { productId: p.productId, collection: p.collection, colours: p.cabinet.colours.map((x) => (s.lang === 'ru' ? x.name : colourLabel(s.lang, x.name))), variants };
    });
    const first = rows[0];
    // P3-05: the lowest price first as one speakable sentence, the sizes after it (chat)
    const min = first?.variants.length ? first.variants.reduce((a, v) => (v.from < a.from ? v : a)) : undefined;
    const say = first ? t(s.lang, 'lookup.say', { collection: first.collection ?? '', min, variants: first.variants }) : t(s.lang, 'lookup.none');
    return { ok: true, products: rows, say };
  }

  private async proposeSets(s: AiSession, input: ProposeArgs, origin: Origin, turnId: string) {
    const c = this.catalog;
    const L = s.lang;
    if (!c) return { ok: false, say: t(L, 'catalog.loading') };
    // QA-025: a collection that is not ready for the 3D room -> honest note + the closest alternative.
    if (input.collection) {
      const col = c.listProducts().find((p) => p.collection?.toLowerCase() === String(input.collection).toLowerCase())?.collection;
      if (col && !c.isCollectionEnabled(col)) {
        const alt = c.alternativeFor(col);
        const prefix = t(L, 'propose.notReady', { col, alt });
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
    if (cands.length === 0) return { ok: false, say: t(L, 'catalog.noPriced') };
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
      return { ok: false, reasonCode: 'PLANNER_BUSY', retry: false, busyHandled: true, say: t(L, 'busy.propose') };
    }
    if (!fitRes.ok) {
      return { ok: false, reasonCode: fitRes.reasonCode, say: fitRes.reasonCode === 'NOT_IN_PLANNER' ? t(L, 'propose.openPlanner') : t(L, 'propose.noWall') };
    }
    const results = (fitRes.result?.results ?? []) as any[];
    if (results.some((r) => r.reasonCode === 'NO_ROOM')) return { ok: false, reasonCode: 'NO_ROOM', say: t(L, 'propose.noRoom') };
    const ranked = rankTiers(cands, results, args);
    s.stats.proposals++;
    if (ranked.length === 0) {
      const noFit = results.every((r) => !r.fits);
      const say = noFit ? t(L, 'propose.noFit') : t(L, 'propose.overBudget', { budget: args.budgetBYN, min: Math.min(...cands.map((x) => x.quote.total)) });
      cands.forEach((x) => s.seenAmounts.add(x.quote.total));
      s.io.emit('ai.cards', { turnId, cards: [] });
      return { ok: true, cards: [], say };
    }
    const cards = ranked.map((r) => buildCard(r, args, c.syncedAt, `k-${s.turnSeq}-${++s.cardSeq}`, ranked.length === 1, L));
    s.lastCards = cards;
    for (const k of cards) {
      s.cards.set(k.cardId, k);
      s.seenAmounts.add(k.price);
      k.items.forEach((i) => s.seenAmounts.add(i.price));
    }
    s.stats.cardsShown += cards.length;
    s.io.emit('ai.cards', { turnId, cards });
    this.log(s, 'cards', { turnId, args, cards: cards.map((k) => ({ cardId: k.cardId, tier: k.tier, title: k.title, price: k.price, spareCm: k.spareCm })) });
    const list = cards.map((k, i) => t(L, 'propose.item', { n: i + 1, title: k.title, price: k.price })).join('; ');
    return {
      ok: true,
      cards: cards.map((k, i) => ({ position: i + 1, cardId: k.cardId, tier: k.tier, title: k.title, price: k.price, spareCm: k.spareCm, reason: k.reason })),
      say: t(L, 'propose.done', {
        n: cards.length,
        list,
        // CR-UE-02: cards can be browsed, but placing them waits until the planner is free.
        tail: !s.plannerBusy ? t(L, 'propose.tapToPlace') : s.busySaidTurn === turnId ? t(L, 'busy.later') : t(L, 'busy.cards'),
      }),
      ...(s.plannerBusy ? { placeable: false } : {}),
    };
  }

  private async configureSet(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    const L = s.lang;
    const setId = input.setId ?? s.lastSetId;
    const set = setId ? s.sets.get(setId) : undefined;
    if (!c) return { ok: false, say: t(L, 'catalog.unavailable') };
    if (!set) {
      if (input.styleHint) return this.proposeSets(s, { style: input.styleHint === 'lighter' ? 'light' : 'dark' }, origin, turnId);
      if (input.config?.closetSizeIndex >= 0) return this.proposeSets(s, { withCloset: true }, origin, turnId);
      return { ok: false, say: t(L, 'configure.pickFirst') };
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
      closetNote = t(L, 'closet.already');
    } else if (change.closetSizeIndex === -1 && curCloset < 0) {
      closetNote = t(L, 'closet.none');
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
        return { ...alt, say: t(L, 'configure.noShade', { lighter: input.styleHint === 'lighter', rest: alt.say ?? '' }) };
      }
      change.colourIndex = opts[0].i;
    }
    if (change.closetSizeIndex !== undefined && change.closetSizeIndex >= 0 && p.closetModels.length === 0) {
      const others = c.collectionsWithCloset().filter((x) => x !== p.collection);
      return { ok: false, reasonCode: 'CATALOG_OPTION_INVALID', say: t(L, 'configure.noCloset', { collection: p.collection, others }) };
    }
    if (change.closetSizeIndex !== undefined && change.closetSizeIndex >= 0 && change.closetColourIndex === undefined) {
      const cab = (c.colourName(set.config) ?? '').toLowerCase().split(/\s+/)[0];
      const m = p.closetModels.find((x) => x.index === change.closetSizeIndex) ?? p.closetModels[0];
      change.closetColourIndex = m?.colours.find((x) => x.name.toLowerCase().startsWith(cab))?.index ?? m?.colours[0]?.index ?? 0;
    }
    const next = fullConfig({ ...set.config, ...change });
    const before = fullConfig(set.config);
    // QA-056: nothing would change -> say so, send nothing.
    if (sameConfig(next, before)) return { ok: true, noChange: true, setId: set.setId, say: closetNote ?? t(L, 'configure.same') };
    const invalid = c.validate(next, L);
    if (invalid) return { ok: false, reasonCode: 'CATALOG_OPTION_INVALID', say: invalid };
    const q = c.quote(next);
    if (!q.complete) return { ok: false, say: t(L, 'configure.noPrice') };
    const r = await this.command(s, 'configure_set', { setId: set.setId, config: change }, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: t(L, 'configure.cannot', { why: this.noFitWhy(s, r) }) };
    // QA-056: never claim a change UE did not make (its result carries the set's config).
    const after = r.result?.config?.productId ? fullConfig(r.result.config) : next;
    if (sameConfig(after, before)) return { ok: false, noChange: true, setId: set.setId, say: t(L, 'configure.notApplied') };
    set.config = after;
    set.title = this.titleFor(after, L);
    this.emitBasket(s);
    const qa = sameConfig(after, next) ? q : c.quote(after);
    s.seenAmounts.add(qa.total);
    const what = input.styleHint
      ? t(L, 'lighter.done', { lighter: input.styleHint === 'lighter', colour: colourLabel(L, c.colourName(after)) })
      : after.closetSizeIndex !== before.closetSizeIndex
        ? after.closetSizeIndex < 0
          ? t(L, 'closet.removed')
          : before.closetSizeIndex < 0
            ? t(L, 'closet.added')
            : t(L, 'closet.resized')
        : t(L, 'done.word');
    return { ok: true, setId: set.setId, total: qa.total, say: t(L, 'configure.done', { note: closetNote, what, total: qa.total, estimated: qa.estimated }), gesture: { kind: 'set', id: set.setId } };
  }

  /** «Так не получится: …» — NO_FIT keeps today's fixed wording; English renders UE's reasonParams when it sends them. */
  private noFitWhy(s: AiSession, r: EnvelopeResult & { reasonParams?: Record<string, any> }): string | undefined {
    if (r.reasonCode === 'NO_FIT' && !(s.lang === 'en' && r.reasonParams)) return t(s.lang, 'configure.noFitWhy');
    return this.why(s, r, r.reasonCode);
  }

  // ── v2.4 (Phase 4) ──────────────────────────────────────────────────────────

  /** configure_set with semantic fields: planned like a salon booth (parts by DataTable id, size, paint, doors), then sent to UE. */
  private async configureSetParts(s: AiSession, set: PlacedSetInfo, live: any, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog!;
    const L = s.lang;
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
    const plan = planBoothChange(c, st, req, L);
    if (plan.kind === 'say') return { ok: plan.ok, ...(plan.noChange ? { noChange: true } : {}), setId: set.setId, say: plan.say };
    const before = fullConfig(set.config);
    const next = fullConfig({ ...before, ...(plan.args.config ?? {}) });
    if (plan.args.config && !c.quote(next).complete) return { ok: false, setId: set.setId, say: t(L, 'configure.noPricePlace') };
    const args: any = { setId: set.setId };
    for (const k of ['config', 'customColour', 'clearCustomColour', 'doors'] as const) if ((plan.args as any)[k] !== undefined) args[k] = (plan.args as any)[k];
    const r = await this.command(s, 'configure_set', args, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, setId: set.setId, say: t(L, 'configure.cannot', { why: this.noFitWhy(s, r) }) };
    const res = r.result ?? {};
    const after = res.config?.productId ? fullConfig(res.config) : next;
    // QA-056: never claim a change UE did not make
    if (plan.args.config && sameConfig(after, before)) return { ok: false, noChange: true, setId: set.setId, say: t(L, 'configure.notApplied') };
    const norm = (x?: string) => String(x ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (plan.args.customColour && Array.isArray(res.customColours) && !res.customColours.some((x: any) => x.component === plan.args.customColour!.component && norm(x.code) === norm(plan.args.customColour!.code))) {
      return { ok: false, noChange: true, setId: set.setId, say: t(L, 'configure.paintFailed', { code: plan.args.customColour.code }) };
    }
    if (plan.args.clearCustomColour && Array.isArray(res.customColours) && res.customColours.some((x: any) => x.component === plan.args.clearCustomColour)) {
      return { ok: false, noChange: true, setId: set.setId, say: t(L, 'configure.clearPaintFailed') };
    }
    const dw = plan.args.doors ? (Object.entries(plan.args.doors)[0] as [string, string]) : undefined;
    if (dw && res.doors && res.doors[dw[0]] !== dw[1]) return { ok: false, noChange: true, setId: set.setId, say: t(L, 'configure.doorsFailed') };
    set.config = after;
    set.title = this.titleFor(after, L);
    this.emitBasket(s);
    const q = c.quote(after);
    s.seenAmounts.add(q.total);
    const paint = (res.customColours ?? []).some((x: any) => x.code) ? t(L, 'price.paintNote') : '';
    return { ok: true, setId: set.setId, total: q.total, say: t(L, 'configure.doneParts', { what: plan.what, total: q.total, estimated: q.estimated, paint }), gesture: { kind: 'set', id: set.setId } };
  }

  /** list_options: every allowed model / colour of the booth in focus or a planner set, by DataTable id, with prices. */
  private async listOptions(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const c = this.catalog;
    if (!c) return { ok: false, say: t(s.lang, 'catalog.unavailable') };
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
      if (s.mode === 'constructor' && !input.boothId && !s.focus?.boothId) return { ok: false, say: t(s.lang, 'options.noSet') };
      const r = await this.readBooth(s, input.boothId ?? s.focus?.boothId, origin, turnId);
      if (!r.st) return { ok: false, reasonCode: r.reasonCode, say: r.say };
      cfg = r.st.config;
      target = { kind: 'booth', boothId: r.st.boothId, collection: r.st.collection ?? collectionOf(c, r.st.productId) };
    }
    const parts = listParts(c, cfg, part, s.lang);
    for (const l of parts) for (const o of l.options) for (const col of o.colours) if (col.priceBYN) s.seenAmounts.add(col.priceBYN);
    return { ok: true, target, parts, say: describeListing(parts, s.lang) };
  }

  /** move_set: the same set to the visitor's left / right by N cm, to the start / end of its wall, or to another wall. */
  private async moveSet(s: AiSession, input: any, origin: Origin, turnId: string): Promise<any> {
    const L = s.lang;
    const setId = input.setId ?? s.lastSetId;
    if (!setId || !s.sets.has(setId)) return { ok: false, say: t(L, 'move.noSet') };
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
      if (!Object.keys(placement).length) return { ok: false, say: t(L, 'move.where') };
      args.placement = placement;
    }
    const r: EnvelopeResult & { reasonParams?: Record<string, any> } = await this.command(s, 'move_set', args, origin, 8000, turnId);
    if (!r.ok) {
      // v2.5 §7: the obstacle / max shift may come as reasonParams (UE M4) besides today's result fields
      const kind = r.result?.obstacle?.kind ?? (typeof r.reasonParams?.obstacle === 'string' ? r.reasonParams.obstacle.toLowerCase() : undefined);
      const what = kind === 'opening' || kind === 'window' || kind === 'door' ? t(L, 'obstacle.opening') : kind === 'set' ? t(L, 'obstacle.set') : t(L, 'obstacle.wall');
      const max = r.result?.maxShiftCm ?? r.reasonParams?.maxShiftCm;
      if (r.reasonCode === 'NO_FIT' && max >= 1) return { ok: false, reasonCode: 'NO_FIT', maxShiftCm: max, say: t(L, 'move.maxShift', { dist: args.distanceCm, what, max }) };
      if (r.reasonCode === 'NO_FIT') return { ok: false, reasonCode: 'NO_FIT', say: t(L, 'move.noFit', { what }) };
      if (r.reasonCode === 'NO_WALL') return { ok: false, reasonCode: 'NO_WALL', say: t(L, 'move.noWall') };
      return { ok: false, reasonCode: r.reasonCode, say: t(L, 'move.failed', { why: this.why(s, r, r.reasonCode) }) };
    }
    const moved = Math.round(Number(r.result?.movedCm ?? args.distanceCm ?? 0));
    const otherWall = args.placement?.segmentId !== undefined && r.result?.from?.segmentId !== undefined && r.result.from.segmentId !== args.placement.segmentId;
    const say = args.direction
      ? t(L, 'move.shifted', { moved, left: args.direction === 'left' })
      : otherWall
        ? t(L, 'move.otherWall')
        : args.placement.anchor === 'start' || args.placement.anchor === 'end'
          ? t(L, 'move.edge')
          : t(L, 'move.moved', { moved });
    return { ok: true, setId, movedCm: moved, say, gesture: { kind: 'set', id: setId } };
  }

  /** v2.4: an opening by id, or the only door / window (optionally on one wall). */
  private async findOpening(s: AiSession, input: any, origin: Origin, turnId: string): Promise<{ openingId: string; kind: string; segmentId: number } | { say: string; reasonCode?: string }> {
    const st = await this.command(s, 'get_state', {}, origin, 8000, turnId);
    if (!st.ok) return { say: t(s.lang, 'room.readFailed'), reasonCode: st.reasonCode };
    const all = ((st.result?.walls ?? []) as any[]).flatMap((w) => (w.openings ?? []).map((o: any) => ({ ...o, segmentId: w.segmentId })));
    if (input.openingId) {
      const o = all.find((x) => x.openingId === input.openingId);
      return o ? { openingId: o.openingId, kind: o.kind, segmentId: o.segmentId } : { say: t(s.lang, 'opening.none'), reasonCode: 'NO_OPENING' };
    }
    const kind = input.kind ?? input.openingKind;
    const cands = all.filter((o) => (!kind || o.kind === kind) && (input.segmentId === undefined || o.segmentId === input.segmentId));
    if (!cands.length) return { say: t(s.lang, 'opening.noneKind', { kind, onWall: input.segmentId !== undefined }), reasonCode: 'NO_OPENING' };
    if (cands.length > 1) return { say: t(s.lang, 'opening.many', { n: cands.length, kind }), reasonCode: 'BAD_ARGS' };
    return { openingId: cands[0].openingId, kind: cands[0].kind, segmentId: cands[0].segmentId };
  }

  /** add_opening / update_opening / remove_opening (doors and windows of the room). */
  private async openingTool(s: AiSession, name: string, input: any, origin: Origin, turnId: string): Promise<any> {
    const L = s.lang;
    const ru = (k?: string) => t(L, 'opening.word', { kind: k });
    // OPENING_CONFLICT: «Так не получится: <UE reason>» (English: the reason code table)
    const conflict = (r: EnvelopeResult) => t(L, 'configure.cannot', { why: L === 'ru' ? r.reason : this.why(s, r, r.reason) });
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
    if (name === 'add_opening') {
      if (input.kind !== 'door' && input.kind !== 'window') return { ok: false, say: t(L, 'opening.whatToAdd') };
      if (input.segmentId === undefined) return { ok: false, say: t(L, 'opening.whichWall', { kind: ru(input.kind) }) };
      const r = await this.command(s, 'add_opening', pick(['kind', 'segmentId', 'offsetCm', 'widthCm', 'heightCm', 'sillCm']), origin, 8000, turnId);
      if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: r.reasonCode === 'OPENING_CONFLICT' ? conflict(r) : t(L, 'opening.addFailed', { kind: ru(input.kind), why: this.why(s, r, r.reasonCode) }) };
      if (input.kind === 'window') s.roomHasWindow = true;
      return { ok: true, openingId: r.result?.openingId, say: t(L, 'opening.added', { kind: ru(input.kind) }) };
    }
    const o = await this.findOpening(s, input, origin, turnId);
    if ('say' in o) return { ok: false, reasonCode: o.reasonCode, say: o.say };
    if (name === 'remove_opening') {
      const r = await this.command(s, 'remove_opening', { openingId: o.openingId, segmentId: o.segmentId }, origin, 8000, turnId);
      if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: t(L, 'opening.removeFailed', { kind: ru(o.kind), why: this.why(s, r, r.reasonCode) }) };
      return { ok: true, say: t(L, 'opening.removed', { kind: ru(o.kind) }) };
    }
    const args: any = { openingId: o.openingId, segmentId: o.segmentId, ...pick(['offsetCm', 'widthCm', 'heightCm', 'sillCm']) };
    if (input.direction === 'left' || input.direction === 'right') {
      args.direction = input.direction;
      args.distanceCm = Math.max(1, Math.min(1000, Math.round(Number(input.distanceCm ?? 10))));
    }
    if (o.kind === 'door') delete args.sillCm;
    const r = await this.command(s, 'update_opening', args, origin, 8000, turnId);
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, say: r.reasonCode === 'OPENING_CONFLICT' ? conflict(r) : t(L, 'opening.updateFailed', { kind: ru(o.kind), why: this.why(s, r, r.reasonCode) }) };
    const res = r.result ?? {};
    const parts = [
      args.direction
        ? t(L, 'opening.shifted', { dist: args.distanceCm, left: args.direction === 'left' })
        : args.offsetCm !== undefined
          ? t(L, 'opening.placedAt', { cm: Math.round(res.offsetCm ?? args.offsetCm) })
          : '',
      args.widthCm !== undefined || args.heightCm !== undefined ? t(L, 'opening.size', { w: Math.round(res.widthCm ?? args.widthCm), h: Math.round(res.heightCm ?? args.heightCm) }) : '',
      args.sillCm !== undefined ? t(L, 'opening.sill', { cm: Math.round(res.sillCm ?? args.sillCm) }) : '',
    ].filter(Boolean);
    return { ok: true, openingId: o.openingId, say: t(L, 'opening.updated', { kind: ru(o.kind), parts }) };
  }

  // ── a visitor turn ────────────────────────────────────────────────────────
  async handleTurn(s: AiSession, text: string, source: 'text' | 'voice' = 'text'): Promise<void> {
    if (s.busy) {
      // Security review: bounded backlog (each queued turn is an LLM call).
      if (s.queue.length >= 3) {
        s.io.emit('ai.error', { code: 'RATE_LIMITED', message: t(s.lang, 'turn.queueFull') });
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
      this.applyPendingLang(s);
    }
  }

  // ── v2.5: the session language ────────────────────────────────────────────
  /**
   * ai.lang: the language applies from the NEXT turn. While a turn runs, the switch waits (the reply in flight finishes in
   * the old language); otherwise it applies now. History is kept; the model gets a one-line note with the next message.
   */
  setLang(s: AiSession, lang: Lang) {
    if (s.busy) {
      s.pendingLang = lang;
      this.log(s, 'lang_pending', { lang });
      return;
    }
    s.pendingLang = lang;
    this.applyPendingLang(s);
  }
  private applyPendingLang(s: AiSession) {
    const lang = s.pendingLang;
    s.pendingLang = undefined;
    if (!lang || lang === s.lang) return;
    s.lang = lang;
    s.notes.push(t(lang, 'note.langChanged'));
    this.log(s, 'lang', { lang });
  }

  /** QA-044: a turn that throws still switches the thinking indicator off. */
  private async safeTurn(s: AiSession, text: string, source: 'text' | 'voice') {
    try {
      await this.runTurn(s, text, source);
    } catch (e: any) {
      this.log(s, 'turn_error', { turnId: `t-${s.turnSeq}`, message: e?.message });
      s.io.emit('ai.thinking', { turnId: `t-${s.turnSeq}`, on: false });
      s.io.emit('ai.error', { code: 'TURN_FAILED', message: t(s.lang, 'turn.failed') });
    }
  }

  private async runTurn(s: AiSession, text: string, source: 'text' | 'voice') {
    this.applyPendingLang(s); // v2.5: an ai.lang received during the previous reply applies from this turn
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
      const reply = pre.reply ?? t(s.lang, 'done');
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
      const system = systemPrompt(this.catalog, s.mode, s.lang);
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
          final = t(s.lang, 'llm.sorry');
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
        s.io.emit('ai.thinking', { turnId, on: true, step: stepLabel(s.lang, u.name) });
        let out: any;
        try {
          out = await this.runTool(s, u.name, u.input ?? {}, origin, turnId);
        } catch (e: any) {
          out = { ok: false, say: t(s.lang, 'tool.error'), error: e.message };
        }
        if (out?.gesture) gesture = out.gesture;
        // v2.5: apply_card logs its structured result (setId + title) — analytics reads it instead of parsing the say text
        const placed = u.name === 'apply_card' && out?.ok && out.setId ? s.sets.get(out.setId) : undefined;
        this.log(s, 'tool', { turnId, name: u.name, input: u.input, ok: out?.ok, say: out?.say, ...(placed ? { setId: placed.setId, title: placed.title, cardId: placed.cardId } : {}) });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out?.ok === false ? { is_error: true } : {}) });
      }
      s.messages.push({ role: 'user', content: results });
      if (step === 7) final = t(s.lang, 'done');
    }
    const g = guardReply(final || t(s.lang, 'done'), [...s.seenAmounts], s.lang === 'ru' ? undefined : t(s.lang, 'guard.fallback'), s.lang);
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
      // v2.5 hook (Milestone 2): the session language is passed on; the providers do not use it yet.
      text = (await this.deps.stt.transcribe(audio, mimeType, s.sessionId, s.lang)).text;
    } catch (e: any) {
      this.log(s, 'stt_error', { message: e.message });
      s.io.emit('ai.error', { code: 'STT_FAILED', message: t(s.lang, 'stt.failed') });
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
      s.sets.set(x.setId, { setId: x.setId, config: fullConfig(x.config), title: this.titleFor(x.config, s.lang) });
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
    if (fin && typeof fin === 'object') s.finishes = finishesFromState(fin, this.catalog?.tiles() ?? [], s.lang);
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
    // v2.5: the language follows the visitor (the page that was just talking)
    into.lang = from.lang;
    into.pendingLang = from.pendingLang ?? into.pendingLang;
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
    s.notes.push(t(s.lang, 'note.staff', { text }));
    await this.say(s, text, `t-staff-${Date.now()}`, undefined, true);
  }

  /** What the visitor told the consultant, for the dossier notes (QA-016: conversation facts, no invented claims). */
  conversationNotes(s: AiSession): string[] {
    const n: string[] = [];
    const L = s.lang;
    const styleKey = s.prefs.style ? `style.${s.prefs.style}` : '';
    if (s.prefs.budgetBYN) n.push(t(L, 'notes.budget', { budget: s.prefs.budgetBYN }));
    if (styleKey && hasKey(styleKey)) n.push(t(L, 'notes.style', { style: t(L, styleKey) }));
    if (s.finishes.length) n.push(t(L, 'notes.finishes', { list: s.finishes.map((f) => `${f.surface} — ${f.label}`).join('; ') }));
    if (s.stats.proposals) n.push(t(L, 'notes.proposals', { shown: s.stats.cardsShown, placed: s.sets.size }));
    return n;
  }

  // ── v2.5 ai.action: page buttons as actions (the same logic the Russian chip phrases trigger) ──
  /**
   * `undo` / `reset_room` / `other_collections` run the tools those chips («Отмени последнее», «Очистить комнату», «Покажи
   * другие коллекции») led to; `offer_answer` = ai.offer.answer (`offerId`, else the open offer that has `optionId`). The
   * reply is in the session language; nothing goes through the LLM.
   */
  async handleAction(s: AiSession, action: UiAction, optionId?: string, offerId?: string) {
    if (action === 'offer_answer') {
      // v2.5 §4 (amended): the page sends the ai.offer id; without it, the session's currently open offer
      if (offerId && optionId) return this.handleOfferAnswer(s, offerId, optionId);
      const cur = s.pendingOffer?.open && s.pendingOffer.options.some((x) => x.id === optionId) ? s.pendingOffer : undefined;
      const offer = cur ?? [...s.offers.values()].reverse().find((o) => o.open && o.options.some((x) => x.id === optionId));
      if (!offer || !optionId) {
        this.log(s, 'action_no_offer', { optionId });
        await this.say(s, t(s.lang, 'action.noOffer'), `t-${s.turnSeq}`);
        return;
      }
      return this.handleOfferAnswer(s, offer.offerId, optionId);
    }
    this.applyPendingLang(s);
    const turnId = `t-${++s.turnSeq}`;
    const label = t(s.lang, `action.${action}` as MsgKey);
    s.transcript.push({ role: 'visitor', text: label, at: new Date().toISOString() });
    s.notes.push(t(s.lang, 'note.action', { label }));
    this.log(s, 'action', { action, turnId, mode: s.mode });
    s.turnOffer = undefined;
    let say: string | undefined;
    if (action === 'other_collections') {
      // the salon chip: with a booth in focus «Какую коллекцию поставить вместо X?» (as wantsOtherCollection), else the catalogue
      if (s.mode === 'showroom' && s.focus?.boothId) {
        const o = this.collectionPickOffer(s);
        if (o) {
          await this.presentOffer(s, o, turnId);
          return;
        }
      }
      const out = await this.runTool(s, s.mode === 'showroom' ? 'catalog_suggest' : 'propose_sets', {}, 'ui', turnId);
      say = out?.say;
    } else if (action === 'undo') {
      // «Отмени последнее»: the room in «Конструктор», the booth in focus in the salon («верни как было»)
      const out = await this.runTool(s, s.mode === 'constructor' ? 'undo' : 'booth_undo', {}, 'ui', turnId);
      say = out?.say;
    } else if (action === 'reset_room') {
      const out = await this.runTool(s, 'reset_room', {}, 'ui', turnId);
      say = out?.say;
    }
    await this.sayUiOutcome(s, say || t(s.lang, 'done'), turnId);
  }
}
