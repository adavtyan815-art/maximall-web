/**
 * Contracts v2.5 Milestone 2 — voice follows the session language. ElevenLabs is mocked (local WS server / stubbed
 * fetch); no paid call. Russian behaviour unchanged (the rest of the suite + the stt_stream test pin it).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as ioc, Socket } from 'socket.io-client';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import { fixtureIndex } from './helpers/catalog';
import { createAiModule, AiModule } from '../src/ai';
import { CostLedger } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { ClipStore, ElevenLabsStt, ElevenLabsTts, MockStt, MockTts, ttsVoiceId, sttLanguageCode, TtsProvider } from '../src/ai/providers/voice';
import { ElevenLabsRealtimeStt, MockStreamingStt, StreamingSttProvider } from '../src/ai/providers/streamingStt';
import { applySttCorrectionFor } from '../src/ai/voice/sttCorrect';
import { spokenSummary, speechLength, SPOKEN_MAX_CHARS_EN, estimateSpokenSeconds, SPOKEN_CHARS_PER_SEC_EN } from '../src/ai/orchestrator/speech';
import { AiSession, Orchestrator } from '../src/ai/orchestrator/orchestrator';
import { DirectChannel } from '../src/ai/orchestrator/channel';
import { FakeUe } from '../src/ai/sim/fakeUe';

const f = fixtureIndex();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v25voice-'));
const ledger = () => new CostLedger({ file: path.join(tmp, `spend-${Math.random()}.jsonl`) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('v2.5 realtime STT language', () => {
  async function run(lang: 'ru' | 'en' | undefined, env: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const wss = new WebSocketServer({ port: 0 });
    let url = '';
    wss.on('connection', (ws, req) => {
      url = String(req.url);
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.commit) ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'make the room three by two' }));
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const el = new ElevenLabsRealtimeStt(ledger(), 'k', `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`);
    const st = el.start({ sessionId: 's', mimeType: 'audio/pcm;rate=16000', onPartial: () => undefined, lang })!;
    st.push(Buffer.alloc(1600));
    await new Promise((r) => setTimeout(r, 100));
    const res = await st.end();
    wss.close();
    return { q: Object.fromEntries(new URLSearchParams(url.split('?')[1])), res, last: el.lastRequest };
  }
  it('language_code follows the utterance language; the model is ELEVENLABS_STT_REALTIME_MODEL (default scribe_v2_realtime)', async () => {
    const en = await run('en');
    expect(en.q).toEqual({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', language_code: 'en', commit_strategy: 'manual' });
    expect(en.res.text).toBe('make the room three by two');
    expect(en.last).toEqual({ provider: 'elevenlabs-stt-realtime', model: 'scribe_v2_realtime', languageCode: 'en' });
    expect((await run(undefined)).q.language_code).toBe('ru');
    expect((await run('ru', { ELEVENLABS_STT_REALTIME_MODEL: 'scribe_v3_test' })).q.model_id).toBe('scribe_v3_test');
  });
});

describe('v2.5 batch STT and TTS payloads (fetch stubbed)', () => {
  function stubFetch() {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('speech-to-text')) return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    });
    return calls;
  }
  it('batch STT sends language_code eng / rus', async () => {
    const calls = stubFetch();
    const stt = new ElevenLabsStt(ledger(), 'k');
    await stt.transcribe(Buffer.alloc(3200), 'audio/pcm;rate=16000', 's', 'en');
    await stt.transcribe(Buffer.alloc(3200), 'audio/pcm;rate=16000', 's');
    expect((calls[0].init.body as FormData).get('language_code')).toBe('eng');
    expect((calls[1].init.body as FormData).get('language_code')).toBe('rus');
    expect(sttLanguageCode('en')).toBe('eng');
    expect(stt.lastRequest).toMatchObject({ languageCode: 'rus', model: 'scribe_v1' });
  });

  it('TTS: language_code en|ru and ELEVENLABS_VOICE_ID_EN for English, else ELEVENLABS_VOICE_ID', async () => {
    const calls = stubFetch();
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'voice-ru');
    vi.stubEnv('ELEVENLABS_VOICE_ID_EN', 'voice-en');
    const tts = new ElevenLabsTts(ledger(), 'k');
    await tts.synthesize('Hello', 's', 'en');
    await tts.synthesize('Привет', 's', 'ru');
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-en?output_format=mp3_44100_128');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ text: 'Hello', language_code: 'en', model_id: 'eleven_flash_v2_5' });
    expect(calls[1].url).toContain('/text-to-speech/voice-ru?');
    expect(JSON.parse(calls[1].init.body).language_code).toBe('ru');
    expect(calls[0].init.headers['xi-api-key']).toBe('k');
    vi.stubEnv('ELEVENLABS_VOICE_ID_EN', '');
    expect(ttsVoiceId('en')).toBe('voice-ru'); // no English voice configured -> the same multilingual voice
    const pcm = new ElevenLabsTts(ledger(), 'k', { outputFormat: 'pcm_16000' });
    await pcm.synthesize('Yes', 's', 'en');
    expect(calls[2].url).toContain('output_format=pcm_16000');
    expect(pcm.lastRequest).toMatchObject({ languageCode: 'en', outputFormat: 'pcm_16000', chars: 3 });
  });
});

describe('v2.5 STT correction only for Russian', () => {
  it('the Russian dictionary is skipped for English utterances', () => {
    expect(applySttCorrectionFor('два на три метра', 'ru').text).not.toBe('два на три метра');
    expect(applySttCorrectionFor('два на три метра', 'en')).toEqual({ text: 'два на три метра', logFields: {} });
    expect(applySttCorrectionFor('make it two by three', 'en').text).toBe('make it two by three');
  });
});

describe('v2.5 English spoken summary', () => {
  const sp = (s: string) => spokenSummary(s, undefined, 'en').text;
  it('reads money, units, sizes and № in English; never Russian grammar words', () => {
    expect(sp('The set costs ≈ 2,040 BYN (estimate).')).toBe('The set costs about 2,040 Belarusian rubles.');
    expect(sp('Make the room 3 × 2.5 m.')).toBe('Make the room 3 by 2.5 metres.');
    expect(sp("I've built a 200 by 300 cm room.")).toBe("I've built a 200 by 300 centimetre room.");
    expect(sp('The mirror is 80 cm wide. It is display № 2.')).toBe('The mirror is 80 centimetres wide. It is display number 2.');
    expect(sp('Tell me your budget in BYN.')).toBe('Tell me your budget in Belarusian rubles.');
    for (const s of [sp('Done: walls — paint RAL 9010.'), sp('The set costs 2,773 BYN.')]) expect(s).not.toMatch(/[А-Яа-яЁё]|рубл|ориентировочно/);
  });
  it('first sentence + action + closing question, lists and three-part sizes to the chat, ~170 chars', () => {
    const list = "I've picked 3 options: 1) Milu 100, walnut, with worktop — 3,588 BYN; 2) Urban 100, grey — 3,127 BYN. Tap a card, and I'll place the set.";
    expect(sp(list)).toBe("I've picked 3 options. Tap a card, and I'll place the set. Details are on the screen.");
    expect(sp('The display now shows Urban 80, black MDF (80 × 46 × 40 cm), 2,040 BYN. What shall I change?')).toBe('The display now shows Urban 80, black MDF, 2,040 Belarusian rubles. What shall I change?');
    const offer = 'Milu 100 takes 100 cm of width, depth 50 cm, height 40 cm. Your long wall is 170 cm — the set fits in width, with about 70 cm to spare (not counting the door and passages). I can show this model in real size in our room planner. Shall we go?';
    const s = sp(offer);
    expect(s).toMatch(/Shall we open the room planner\?$/);
    expect(speechLength(s, 'en')).toBeLessThanOrEqual(SPOKEN_MAX_CHARS_EN);
    expect(estimateSpokenSeconds(s, SPOKEN_CHARS_PER_SEC_EN, 'en')).toBeLessThanOrEqual(12);
    expect(sp("I've moved the set 20 cm to the left.")).toBe("I've moved the set 20 centimetres to the left.");
    expect(spokenSummary('', undefined, 'en').text).toBe('');
    expect(sp('1) a\n2) b')).toBe("I've written everything in the chat on the screen.");
  });
  it('Russian summary unchanged (defaults)', () => {
    expect(spokenSummary('Поставила Avenu 80, дуб — 3718 BYN.').text).toBe('Поставила Avenu 80, дуб — 3718 рублей.');
    expect(spokenSummary('Скажите бюджет в BYN.', undefined, 'ru').text).toBe('Скажите бюджет в рублях.');
  });
});

describe('v2.5 TTS clip language in the orchestrator', () => {
  class SpyTts extends MockTts implements TtsProvider {
    langs: (string | undefined)[] = [];
    async synthesize(text: string, _sid?: string, lang?: 'ru' | 'en') {
      this.langs.push(lang);
      return super.synthesize(text);
    }
  }
  it('a clip in flight keeps the old language; the next one is in the new language', async () => {
    const tts = new SpyTts();
    const orch = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts, clips: new ClipStore(path.join(tmp, 'clips')), logDir: path.join(tmp, 'logs') });
    const s = new AiSession('v:1', 'v', 'u', new DirectChannel(new FakeUe(f.catalog, { inPlanner: true })), { emit: () => undefined }, 'constructor');
    s.greeted = true;
    const p = orch.handleTurn(s, 'Привет');
    orch.setLang(s, 'en');
    await p;
    await orch.handleTurn(s, 'Hello');
    expect(tts.langs).toEqual(['ru', 'en']);
  });

  it('batch STT: the utterance language goes to the provider; STT_FAILED is in the session language', async () => {
    const seen: (string | undefined)[] = [];
    const failing = { name: 'x', mock: true, transcribe: async (_a: Buffer, _m: string, _s?: string, lang?: 'ru' | 'en') => { seen.push(lang); throw new Error('down'); } };
    const events: [string, any][] = [];
    const orch = new Orchestrator({ catalog: f.catalog, llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: failing, tts: new MockTts(), clips: new ClipStore(path.join(tmp, 'clips2')), logDir: path.join(tmp, 'logs') });
    const s = new AiSession('v:2', 'v', 'u', new DirectChannel(new FakeUe(f.catalog, { inPlanner: true })), { emit: (e, p) => events.push([e, p]) }, 'constructor');
    s.lang = 'en';
    await orch.handleAudio(s, Buffer.alloc(10), 'audio/webm');
    await orch.handleAudio(s, Buffer.alloc(10), 'audio/webm', 'ru'); // an utterance that started in Russian
    expect(seen).toEqual(['en', 'ru']);
    expect(events.filter(([e]) => e === 'ai.error').map(([, p]) => p)).toEqual([
      { code: 'STT_FAILED', message: "I didn't catch that, please say it again." },
      { code: 'STT_FAILED', message: "I didn't catch that, please say it again." },
    ]);
  });
});

// ── socket: the utterance language is taken at ai.audio.start ───────────────
describe('v2.5 mid-utterance language switch (socket)', () => {
  let server: http.Server;
  let url: string;
  let mod: AiModule;
  const starts: (string | undefined)[] = [];
  class SpyStream implements StreamingSttProvider {
    readonly name = 'spy';
    readonly mock = true;
    inner = new MockStreamingStt();
    start(opts: any) {
      starts.push(opts.lang);
      return this.inner.start(opts);
    }
  }
  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mod = createAiModule({
      catalog: f.catalog,
      logDir: path.join(tmp, 'slogs'),
      clips: new ClipStore(path.join(tmp, 'sclips')),
      renderDir: path.join(tmp, 'renders'),
      savesDir: path.join(tmp, 'saves'),
      dossierDir: path.join(tmp, 'dossiers'),
      providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), sttStream: new SpyStream(), tts: new MockTts(), ledger: ledger(), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} },
    });
    app.use(mod.router);
    mod.attach(new SocketServer(server, { cors: { origin: true } }));
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it('ai.lang during an utterance applies to the next one: STT language and the Russian correction', async () => {
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-voice', username: 'olga' }, forceNew: true });
    const events: [string, any][] = [];
    sock.onAny((e, p) => events.push([e, p]));
    const waitFor = (pred: (e: [string, any]) => boolean, from = 0, ms = 5000) =>
      new Promise<[string, any]>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = events.slice(from).find(pred);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > ms) return reject(new Error('timeout'));
          setTimeout(tick, 10);
        };
        tick();
      });
    await waitFor(([e]) => e === 'ai.session.ready');
    // utterance 1 starts in Russian; the visitor switches to English while holding the button
    sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    sock.emit('ai.lang', { lang: 'en' });
    await waitFor(([e]) => e === 'ai.lang.changed');
    sock.emit('ai.audio.chunk', Buffer.from('MOCKTEXT:два на три метра'));
    sock.emit('ai.audio.end');
    const [, tr1] = await waitFor(([e, p]) => e === 'ai.transcript' && p.final);
    expect(tr1.text).not.toBe('два на три метра'); // the Russian correction ran (Russian utterance)
    // utterance 2 is English: no Russian correction, English STT
    let n = events.length;
    sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    sock.emit('ai.audio.chunk', Buffer.from('MOCKTEXT:два на три метра'));
    sock.emit('ai.audio.end');
    const [, tr2] = await waitFor(([e, p]) => e === 'ai.transcript' && p.final, n);
    expect(tr2.text).toBe('два на три метра');
    expect(starts).toEqual(['ru', 'en']);
    // a mock utterance without text in an English session: the mock STT answers in English (stream started with lang en)
    n = events.length;
    sock.emit('ai.audio.start', { mimeType: 'audio/pcm;rate=16000' });
    sock.emit('ai.audio.chunk', Buffer.alloc(320));
    sock.emit('ai.audio.end');
    const [, tr3] = await waitFor(([e, p]) => e === 'ai.transcript' && p.final, n);
    expect(tr3.text).toBe('Show me options for my bathroom');
    expect(starts).toEqual(['ru', 'en', 'en']);
    sock.disconnect();
  });
});

describe('v2.5 English room size words', () => {
  it('«three by two and a half metres» = 300 × 250 cm', async () => {
    const { parseRoomSizeEn } = await import('../src/ai/orchestrator/intents');
    expect(parseRoomSizeEn('Make the room three by two and a half metres')).toEqual({ widthCm: 300, depthCm: 250 });
    expect(parseRoomSizeEn('one and a half by two meters')).toEqual({ widthCm: 150, depthCm: 200 });
  });
});
