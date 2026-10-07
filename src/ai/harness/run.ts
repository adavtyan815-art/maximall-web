import os from 'os';
import fs from 'fs';
import path from 'path';
import type { CatalogIndex } from '../catalog/index';
import type { LlmProvider, LlmRequest, LlmResponse } from '../providers/llm';
import { MockLlm } from '../providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../providers/voice';
import { Orchestrator, AiSession } from '../orchestrator/orchestrator';
import { DirectChannel } from '../orchestrator/channel';
import { FakeUe } from '../sim/fakeUe';
import { ANTHROPIC_PRICES } from '../util/costLedger';
import { PHRASES, Phrase } from './phrases';
import { SPOKEN_MAX_CHARS, speechLength } from '../orchestrator/speech';

/** Token estimate without an API call: Cyrillic ≈ 2.5 chars/token, other text/JSON ≈ 3.5 chars/token (conservative). */
export function estimateTokens(s: string): number {
  const cyr = (s.match(/[Ѐ-ӿ]/g) ?? []).length;
  return Math.ceil(cyr / 2.5 + (s.length - cyr) / 3.5);
}

interface CallMeter {
  calls: number;
  scoredCalls: number;
  prefixTokens: number[]; // system + tools (cacheable) per call
  messageTokens: number[]; // conversation per call
  scoring: boolean;
}

/** Wraps a provider to record request sizes (for the cost estimate of a live run). */
class MeteredLlm implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mock: boolean;
  constructor(private inner: LlmProvider, private meter: CallMeter) {
    this.name = inner.name;
    this.model = inner.model;
    this.mock = inner.mock;
  }
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.meter.calls++;
    if (this.meter.scoring) this.meter.scoredCalls++;
    this.meter.prefixTokens.push(estimateTokens(req.system) + estimateTokens(JSON.stringify(req.tools)));
    this.meter.messageTokens.push(estimateTokens(JSON.stringify(req.messages)));
    return this.inner.create(req);
  }
}

export interface PhraseResult {
  id: string;
  group: string;
  text: string;
  pass: boolean;
  tools: string[];
  reply: string;
  /** v2.2 P3-05: what the voice says (ai.say.spokenText of the scored reply) */
  spoken: string;
  why: string[];
  ms: number;
}

/** v2.5: `lang` = the session language of every phrase (the English set is PHRASES_EN). */
export async function runHarness(catalog: CatalogIndex, llm: LlmProvider = new MockLlm(), phrases: Phrase[] = PHRASES, lang: 'ru' | 'en' = 'ru') {
  const meter: CallMeter = { calls: 0, scoredCalls: 0, prefixTokens: [], messageTokens: [], scoring: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const orch = new Orchestrator({ catalog, llm: new MeteredLlm(llm, meter), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), clips: new ClipStore(path.join(dir, 'clips')), logDir: path.join(dir, 'logs'), llmTimeoutMs: 30000 });
  const results: PhraseResult[] = [];
  for (const p of phrases) {
    const mode = p.mode ?? 'constructor';
    const ue = new FakeUe(catalog, { inPlanner: mode === 'constructor' });
    const said: string[] = [];
    const spokenAll: string[] = [];
    const offers: any[] = [];
    const s = new AiSession(`harness:${p.id}`, 'harness', p.id, new DirectChannel(ue), {
      emit: (e, x) => {
        if (e === 'ai.say') {
          said.push(x.text);
          spokenAll.push(x.spokenText ?? '');
        }
        if (e === 'ai.offer') offers.push(x);
      },
    }, mode);
    meter.scoring = false;
    s.lang = lang;
    s.greeted = true;
    if (p.focus) await orch.onUeEvent(s, ue.focusEvent(`Booth_${p.focus}_1`));
    const step = async (x: string | { answer: string }) => {
      if (typeof x === 'string') return orch.handleTurn(s, x);
      const last = [...offers].reverse().find((o) => o.options.some((op: any) => op.id === x.answer));
      if (last) await orch.handleOfferAnswer(s, last.offerId, x.answer);
    };
    for (const t of p.setup ?? []) await step(t);
    const from = s.messages.length;
    const cmdFrom = ue.log.length;
    const offerFrom = offers.length;
    meter.scoring = true;
    const t0 = Date.now();
    await step(p.answer !== undefined ? { answer: p.answer } : p.text);
    const ms = Date.now() - t0;
    meter.scoring = false;
    const tools = s.messages
      .slice(from)
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .flatMap((m) => (m.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.name as string));
    const reply = said[said.length - 1] ?? '';
    const spoken = spokenAll[spokenAll.length - 1] ?? '';
    const why: string[] = [];
    for (const t of p.expect.tools ?? []) if (!tools.includes(t)) why.push(`missing ${t}`);
    for (const t of p.expect.not ?? []) if (tools.includes(t)) why.push(`unexpected ${t}`);
    if (p.expect.none && tools.length) why.push(`expected no tool, got ${tools.join(',')}`);
    if (p.expect.reply && !new RegExp(p.expect.reply, 'i').test(reply)) why.push(`reply does not match /${p.expect.reply}/`);
    // v2.0 checks
    const cmds = ue.log.slice(cmdFrom).map((l) => l.cmd);
    // v2.2 P3-02: a salon booth photo (capture preset booth) is not a room command
    const roomCmds = ue.log.slice(cmdFrom).filter((l) => !(l.cmd === 'capture' && l.args?.preset === 'booth')).map((l) => l.cmd);
    const newOffers = offers.slice(offerFrom);
    if (p.expect.offer === 'none' && newOffers.length) why.push(`unexpected offer ${newOffers.map((o) => o.kind).join(',')}`);
    else if (p.expect.offer && p.expect.offer !== 'none' && !newOffers.some((o) => o.kind === p.expect.offer)) why.push(`missing offer ${p.expect.offer}`);
    for (const o of p.expect.offerNot ?? []) if (newOffers.some((x) => x.options.some((op: any) => op.id === o))) why.push(`offer lists ${o}`);
    if (p.expect.modeAfter && s.mode !== p.expect.modeAfter) why.push(`mode ${s.mode}, expected ${p.expect.modeAfter}`);
    for (const c of p.expect.cmds ?? []) if (!cmds.includes(c)) why.push(`missing UE command ${c}`);
    for (const c of p.expect.notCmds ?? []) if (cmds.includes(c)) why.push(`unexpected UE command ${c}`);
    const ROOM = ['build_room', 'add_opening', 'check_fit', 'apply_config', 'configure_set', 'swap_set', 'remove_set', 'finish_surface', 'undo', 'reset', 'save_project', 'capture'];
    if (p.expect.noRoom && roomCmds.some((c) => ROOM.includes(c))) why.push(`room command sent: ${roomCmds.filter((c) => ROOM.includes(c)).join(',')}`);
    // v2.2 P3-05: the voice never says more than the 10 s cap, and only what the chat text contains
    if (speechLength(spoken) > SPOKEN_MAX_CHARS) why.push(`spoken summary too long (${speechLength(spoken)} speech chars)`);
    if (mode === 'showroom' && ue.log.some((l) => !l.ok && /NOT_IN_PLANNER/.test(JSON.stringify(l)))) why.push('UE refused a room command (NOT_IN_PLANNER)');
    results.push({ id: p.id, group: p.group, text: p.text, pass: why.length === 0, tools, reply, spoken, why, ms });
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length, meter };
}

/**
 * Cost of one full live run (setup + scored turns), from the request sizes the mock policy produced. The live model
 * usually needs about as many calls (one per tool round + the final answer). Output: ~350 tokens per call on
 * claude-sonnet-5-5 at low effort (tool JSON + short Russian reply + some adaptive thinking), ~200 on claude-haiku-4-5.
 * Two bounds: no cache hits, and system+tools cached (write once 1.25×, then reads 0.1×).
 */
export function estimateRunCost(meter: CallMeter, callFactor = 1.3) {
  const out: Record<string, { calls: number; inputTokens: number; outputTokens: number; usdNoCache: number; usdCached: number }> = {};
  for (const [model, outPerCall] of [['claude-sonnet-5-5', 350], ['claude-haiku-4-5', 200]] as const) {
    const p = ANTHROPIC_PRICES[model];
    const calls = Math.ceil(meter.calls * callFactor);
    const prefix = meter.prefixTokens.reduce((a, b) => a + b, 0) * callFactor;
    const msgs = meter.messageTokens.reduce((a, b) => a + b, 0) * callFactor;
    const outputTokens = calls * outPerCall;
    const usdNoCache = ((prefix + msgs) * p.in + outputTokens * p.out) / 1e6;
    const prefixOne = meter.prefixTokens[0] ?? 0;
    const usdCached = ((prefixOne * p.cacheWrite + (prefix - prefixOne) * p.cacheRead + msgs * p.in) + outputTokens * p.out) / 1e6;
    out[model] = { calls, inputTokens: Math.round(prefix + msgs), outputTokens, usdNoCache: Math.round(usdNoCache * 1000) / 1000, usdCached: Math.round(usdCached * 1000) / 1000 };
  }
  return out;
}
