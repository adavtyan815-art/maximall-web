/**
 * v2.5 Milestone 2 — ONE-SHOT PAID English voice check (prepared for the coordinator; NOT run by the backend engineer).
 *
 *   PowerShell (from D:\AI_Consultant_Workspace\int\web):
 *     $env:AI_PAID_CALLS_APPROVED='1'; npx tsx scripts/paid_en_voice_check.ts
 *
 * What it does, in-process (no server, no page, no UE, no Simli, no render provider):
 *   for each of 3 English visitor utterances
 *     1. ElevenLabs TTS synthesises the visitor's phrase (English, raw PCM16 16 kHz, like the page's microphone audio);
 *     2. that audio goes through the realtime STT path exactly as the page streams it (ElevenLabsRealtimeStt, lang en,
 *        3200-byte = 100 ms chunks at real-time pace, then the commit);
 *     3. the transcript runs a visitor turn: Orchestrator with the real Anthropic model against the in-process FakeUe
 *        (session language en; the Russian STT correction is not applied to English);
 *     4. the consultant's reply is synthesised by ElevenLabs TTS (English, PCM 24 kHz -> WAV).
 *   Prints and writes: transcript, reply text, spokenText, clip duration, language codes / model / voice sent, the cost of
 *   every paid call, the ledger total. Output folder: D:\AI_Consultant_Workspace\int\paid_en_check\ (report.txt,
 *   report.json, visitor_N.wav, reply_N.wav).
 *
 * Dry run ($0, no network, mocks only — checks the flow and the output files):
 *     npx tsx scripts/paid_en_voice_check.ts --dry-run
 *
 * Safety: refuses without AI_PAID_CALLS_APPROVED=1, refuses under AI_FORCE_MOCK / vitest; keys come from process.env or the
 * Windows User scope (in memory only, never printed, never written); AI_RENDER_FORCE_MOCK=1; a hard script-level cap of
 * $1.00 (PAID_CHECK_CAP_USD may lower it) is checked against the spend ledger BEFORE every paid call — the next call's
 * estimate must fit, otherwise the run stops. Every call also goes through the normal ledger (global and per-session caps).
 */
import fs from 'fs';
import path from 'path';
import { CatalogIndex } from '../src/ai/catalog/index';
import { AiSession, Orchestrator } from '../src/ai/orchestrator/orchestrator';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';
import { AnthropicLlm, estimateAnthropicCostUsd, LlmProvider, LlmRequest, LlmResponse } from '../src/ai/providers/llm';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { ClipStore, ElevenLabsTts, MockStt, MockTts, pcmDurationMs, TtsProvider, wavFromPcm } from '../src/ai/providers/voice';
import { ElevenLabsRealtimeStt, MockStreamingStt, StreamingSttProvider } from '../src/ai/providers/streamingStt';
import { applySttCorrectionFor } from '../src/ai/voice/sttCorrect';
import { CostLedger } from '../src/ai/util/costLedger';
import { flag, hydrateProviderKeysInMemory } from '../src/ai/util/env';

const DRY = process.argv.includes('--dry-run');
const OUT = process.env.PAID_CHECK_OUT ?? (DRY ? path.join(require('os').tmpdir(), 'paid_en_check_dry') : 'D:/AI_Consultant_Workspace/int/paid_en_check');
const CAP_USD = Math.min(1.0, Number(process.env.PAID_CHECK_CAP_USD ?? 1.0) || 1.0);
const UTTERANCES = ['Hi, tell me about the Urban collection', 'Yes, open the room planner', 'Make the room three by two and a half metres'];
const SESSION_ID = `paid-en-check:${new Date().toISOString().replace(/[:.]/g, '-')}`;

class CapReached extends Error {}

function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

(async () => {
  if (!DRY && !flag('AI_PAID_CALLS_APPROVED')) refuse('set AI_PAID_CALLS_APPROVED=1 (coordinator approval) to run the paid English voice check.');
  if (!DRY && (flag('AI_FORCE_MOCK') || process.env.VITEST)) refuse('AI_FORCE_MOCK / vitest is set — this script only makes sense with the real providers.');
  process.env.AI_RENDER_FORCE_MOCK = '1'; // no paid render provider (none is created here anyway)
  // no avatar: Simli is never started by this script
  const keys = DRY ? { ANTHROPIC_API_KEY: true, ELEVENLABS_API_KEY: true } : hydrateProviderKeysInMemory();
  if (!keys.ANTHROPIC_API_KEY || !keys.ELEVENLABS_API_KEY) refuse('ANTHROPIC_API_KEY and ELEVENLABS_API_KEY must be in the process env or the Windows User scope.');

  fs.mkdirSync(OUT, { recursive: true });
  const ledger = DRY ? new CostLedger({ file: path.join(OUT, 'dry_spend.jsonl') }) : new CostLedger();
  const base = ledger.totalUsd();
  const baseCount = ledger.entries().length;
  const spent = () => ledger.totalUsd() - base;
  /** Hard script-level cap: the next call's estimate must fit under CAP_USD (measured on the ledger). */
  const guard = (estUsd: number, what: string) => {
    const s = spent();
    if (s + estUsd > CAP_USD) throw new CapReached(`cap $${CAP_USD.toFixed(2)}: spent $${s.toFixed(4)} + next ${what} ~$${estUsd.toFixed(4)} would exceed it`);
  };

  const model = process.env.AI_LLM_MODEL ?? 'claude-sonnet-5-5';
  const realLlm = new AnthropicLlm(model, ledger, { timeoutMs: 30000 });
  const llm: LlmProvider = DRY ? new MockLlm() : {
    name: realLlm.name,
    model: realLlm.model,
    mock: false,
    create: async (req: LlmRequest): Promise<LlmResponse> => {
      guard(estimateAnthropicCostUsd(model, req), `messages.create ${model}`);
      return realLlm.create(req);
    },
  };
  const ttsPerChar = Number(process.env.ELEVENLABS_TTS_USD_PER_1K_CHARS ?? 0.3) / 1000;
  const sttPerSec = Number(process.env.ELEVENLABS_STT_USD_PER_HOUR ?? 0.4) / 3600;
  const visitorTts = DRY ? Object.assign(new MockTts(), { lastRequest: { languageCode: 'en', voiceId: 'mock' } }) : new ElevenLabsTts(ledger, undefined, { outputFormat: 'pcm_16000' });
  const replyTtsReal = new ElevenLabsTts(ledger, undefined, { outputFormat: 'pcm_24000' });
  const replyRequests: any[] = [];
  const replyTts: TtsProvider = {
    name: replyTtsReal.name,
    mock: false,
    audioFormat: 'pcm_24000',
    synthesize: async (text, sessionId, lang) => {
      guard(text.length * ttsPerChar, 'reply TTS');
      const pcm = DRY ? await new MockTts().synthesize(text) : await replyTtsReal.synthesize(text, sessionId, lang);
      replyRequests.push({ ...(DRY ? { languageCode: lang, voiceId: 'mock' } : replyTtsReal.lastRequest), durationMs: pcmDurationMs(pcm) });
      return pcm;
    },
  };
  const stt: StreamingSttProvider & { lastRequest?: { model: string; languageCode: string } } = DRY ? Object.assign(new MockStreamingStt(), { lastRequest: { model: 'mock', languageCode: 'en' } }) : new ElevenLabsRealtimeStt(ledger);

  const catalog = CatalogIndex.load();
  const clipsDir = path.join(OUT, 'clips');
  const orch = new Orchestrator({ catalog, llm, fallbackLlm: new MockLlm(), stt: new MockStt(), tts: replyTts, clips: new ClipStore(clipsDir), logDir: path.join(OUT, 'logs'), llmTimeoutMs: 30000 });
  const ue = new FakeUe(catalog, { inPlanner: false });
  const events: [string, any][] = [];
  const s = new AiSession(SESSION_ID, 'paid-en-check', 'check', new DirectChannel(ue), { emit: (e, p) => events.push([e, p]) }, 'showroom');
  s.lang = 'en';
  await orch.onUeEvent(s, ue.focusEvent('Booth_Urban_1')); // the visitor stands at the Urban display (before greeted: no extra clip)
  s.greeted = true;

  const report: any = { startedAt: new Date().toISOString(), sessionId: SESSION_ID, model, capUsd: CAP_USD, ledgerTotalBeforeUsd: Math.round(base * 10000) / 10000, turns: [] as any[] };
  const lines: string[] = [];
  const log = (x: string) => {
    console.log(x);
    lines.push(x);
  };
  log(`${DRY ? 'DRY RUN (mocks, $0) — ' : ''}Paid English voice check — ${report.startedAt}; model ${model}; cap $${CAP_USD.toFixed(2)}; ledger before $${base.toFixed(4)}`);

  try {
    for (let i = 0; i < UTTERANCES.length; i++) {
      const phrase = UTTERANCES[i];
      const turn: any = { n: i + 1, phrase };
      report.turns.push(turn);
      log(`\n— Turn ${i + 1}: «${phrase}»`);
      // 1. the visitor's voice (English TTS, PCM16 16 kHz)
      guard(phrase.length * ttsPerChar, 'visitor TTS');
      const pcm16 = await visitorTts.synthesize(phrase, SESSION_ID, 'en');
      fs.writeFileSync(path.join(OUT, `visitor_${i + 1}.wav`), wavFromPcm(pcm16, 16000));
      turn.visitorTts = { ...visitorTts.lastRequest, audioMs: Math.round(pcm16.length / 32) };
      log(`  visitor TTS: lang ${visitorTts.lastRequest?.languageCode}, voice ${visitorTts.lastRequest?.voiceId}, ${turn.visitorTts.audioMs} ms`);
      // 2. realtime STT, streamed like the page (100 ms chunks at real-time pace, then the commit), lang en
      guard(sttPerSec * 30, 'realtime STT');
      const partials: string[] = [];
      const stream = stt.start({ sessionId: SESSION_ID, mimeType: 'audio/pcm;rate=16000', lang: s.lang, onPartial: (p) => partials.push(p) });
      if (!stream) throw new Error('realtime STT refused the audio format');
      if (DRY) stream.push(Buffer.from(`MOCKTEXT:${phrase}`)); // the mock transcribes this convention
      for (let off = 0; !DRY && off < pcm16.length; off += 3200) {
        stream.push(pcm16.subarray(off, Math.min(pcm16.length, off + 3200)));
        if (!DRY) await new Promise((r) => setTimeout(r, 100));
      }
      const raw = (await stream.end()).text;
      const { text } = applySttCorrectionFor(raw, s.lang); // English: unchanged
      turn.stt = { ...stt.lastRequest, transcript: text, partials: partials.length, stats: stream.stats?.() };
      log(`  STT: model ${stt.lastRequest?.model}, language_code ${stt.lastRequest?.languageCode} -> «${text}»`);
      if (!text.trim()) {
        log('  (empty transcript — turn skipped)');
        continue;
      }
      // 3 + 4. the turn with the real model against FakeUe; the reply is synthesised (English)
      const from = events.length;
      const reqFrom = replyRequests.length;
      await orch.handleTurn(s, text, 'voice');
      const says = events.slice(from).filter(([e]) => e === 'ai.say').map(([, p]) => p);
      const say = says[says.length - 1];
      const tools = s.messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? (m.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.name) : []));
      turn.mode = s.mode;
      turn.reply = say?.text;
      turn.spokenText = say?.spokenText;
      turn.clipDurationMs = say?.durationMs;
      turn.replyTts = replyRequests.slice(reqFrom);
      turn.ueCommands = ue.log.map((l) => l.cmd);
      turn.toolsSoFar = tools;
      const clip = say?.audioUrl ? path.join(clipsDir, String(say.audioUrl).split('/').pop()!) : '';
      if (clip && fs.existsSync(clip)) fs.copyFileSync(clip, path.join(OUT, `reply_${i + 1}.wav`));
      log(`  reply: ${say?.text}`);
      log(`  spoken: ${say?.spokenText}`);
      log(`  clip: ${say?.durationMs} ms; TTS lang ${turn.replyTts.map((r: any) => r.languageCode).join(',')}, voice ${turn.replyTts.map((r: any) => r.voiceId).join(',')}; mode now ${s.mode}`);
      log(`  spent so far $${spent().toFixed(4)}`);
    }
  } catch (e: any) {
    log(`\nSTOPPED: ${e instanceof CapReached ? e.message : e?.message ?? e}`);
    report.stopped = String(e?.message ?? e);
  }

  const calls = ledger
    .entries()
    .slice(baseCount)
    .filter((e) => e.status !== 'reserved');
  report.calls = calls.map((e) => ({ provider: e.provider, call: e.call, status: e.status, estUsd: e.estUsd, actualUsd: e.actualUsd }));
  report.spentUsd = Math.round(spent() * 10000) / 10000;
  report.ledgerTotalAfterUsd = Math.round(ledger.totalUsd() * 10000) / 10000;
  log('\nPaid calls:');
  for (const c of report.calls) log(`  ${c.provider.padEnd(11)} ${c.call.padEnd(40)} ${c.status.padEnd(8)} $${(c.actualUsd ?? c.estUsd).toFixed(5)}`);
  log(`This run: $${report.spentUsd.toFixed(4)} (cap $${CAP_USD.toFixed(2)}); ledger total $${report.ledgerTotalAfterUsd.toFixed(4)}`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
  fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(`\nWritten: ${OUT}`);
})();
