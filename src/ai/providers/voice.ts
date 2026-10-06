import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CostLedger } from '../util/costLedger';

export const TTS_SAMPLE_RATE = 24000; // raw PCM s16le mono 24 kHz for Unreal (commands.schema consultant_say.clipUrl)

export interface SttProvider {
  readonly name: string;
  readonly mock: boolean;
  transcribe(audio: Buffer, mimeType: string, sessionId?: string): Promise<{ text: string; durationMs?: number }>;
}
export interface TtsProvider {
  readonly name: string;
  readonly mock: boolean;
  /** v2.0: what synthesize() returns — raw PCM s16le mono 24 kHz (wrapped into WAV for the browser) or MP3. */
  readonly audioFormat?: 'pcm_24000' | 'mp3';
  /** Returns the audio in audioFormat (default raw PCM s16le mono 24 kHz). */
  synthesize(text: string, sessionId?: string): Promise<Buffer>;
}

/** v2.0: a browser-playable WAV around raw PCM s16le mono. */
export function wavFromPcm(pcm: Buffer, rate = TTS_SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function pcmDurationMs(pcm: Buffer, rate = TTS_SAMPLE_RATE) {
  return Math.round((pcm.length / 2 / rate) * 1000);
}

/**
 * Mock STT. Real audio cannot be decoded without a provider, so the mock accepts a test convention: a buffer that
 * starts with "MOCKTEXT:" carries UTF-8 text (used by the fake page and tests). Anything else returns a fixed phrase.
 */
export class MockStt implements SttProvider {
  readonly name = 'mock';
  readonly mock = true;
  async transcribe(audio: Buffer): Promise<{ text: string }> {
    const head = audio.subarray(0, 9).toString('utf8');
    if (head === 'MOCKTEXT:') return { text: audio.subarray(9).toString('utf8').trim() };
    return { text: 'Покажите варианты для моей ванной' };
  }
}

/** Mock TTS: deterministic speech-like PCM (syllable envelope over a 180 Hz tone), ~65 ms per character, so UE lip/jaw
 * envelope and bIsSpeaking timing can be tested end to end without a key. */
export class MockTts implements TtsProvider {
  readonly name = 'mock';
  readonly mock = true;
  readonly audioFormat = 'pcm_24000' as const;
  async synthesize(text: string): Promise<Buffer> {
    const ms = Math.min(20000, Math.max(400, text.length * 65));
    const n = Math.round((ms / 1000) * TTS_SAMPLE_RATE);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / TTS_SAMPLE_RATE;
      const syll = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t); // 4 syllables/s
      const v = Math.sin(2 * Math.PI * 180 * t) * syll * 0.25;
      buf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return buf;
  }
}

const EL_BASE = 'https://api.elevenlabs.io/v1';

/** ElevenLabs speech-to-text (batch, model scribe_v1, language rus). Cost estimate: ELEVENLABS_STT_USD_PER_HOUR (default 0.40). */
export class ElevenLabsStt implements SttProvider {
  readonly name = 'elevenlabs';
  readonly mock = false;
  constructor(private ledger: CostLedger, private apiKey = process.env.ELEVENLABS_API_KEY ?? '') {}
  async transcribe(audio: Buffer, mimeType: string, sessionId?: string) {
    const perHour = Number(process.env.ELEVENLABS_STT_USD_PER_HOUR ?? 0.4);
    // Duration estimate: PCM 16 kHz s16le = 32000 B/s; compressed audio ~ 4000 B/s (conservative upper bound).
    const seconds = mimeType.startsWith('audio/pcm') ? audio.length / 32000 : audio.length / 4000;
    const est = Math.max(0.0005, (seconds / 3600) * perHour);
    const r = this.ledger.reserve('elevenlabs', 'speech-to-text scribe_v1', est, sessionId);
    try {
      const form = new FormData();
      form.append('model_id', process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v1');
      form.append('language_code', 'rus');
      if (mimeType.startsWith('audio/pcm')) form.append('file_format', 'pcm_s16le_16');
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType.split(';')[0] }), 'turn.audio');
      const res = await fetch(`${EL_BASE}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form });
      if (!res.ok) throw new Error(`ElevenLabs STT HTTP ${res.status}`);
      const j: any = await res.json();
      r.settle(est, true);
      return { text: String(j.text ?? '').trim() };
    } catch (e) {
      r.settle(est, false);
      throw e;
    }
  }
}

/** ElevenLabs text-to-speech, v2.0: output_format mp3_44100_128 (the browser plays it). Cost: ELEVENLABS_TTS_USD_PER_1K_CHARS (default 0.30). */
export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';
  readonly mock = false;
  readonly audioFormat = 'mp3' as const;
  constructor(private ledger: CostLedger, private apiKey = process.env.ELEVENLABS_API_KEY ?? '') {}
  async synthesize(text: string, sessionId?: string): Promise<Buffer> {
    const est = (text.length / 1000) * Number(process.env.ELEVENLABS_TTS_USD_PER_1K_CHARS ?? 0.3);
    const r = this.ledger.reserve('elevenlabs', 'text-to-speech mp3_44100_128', est, sessionId);
    const voice = process.env.ELEVENLABS_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL'; // replace with an approved Russian female voice
    try {
      const res = await fetch(`${EL_BASE}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5', language_code: 'ru' }),
      });
      if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}`);
      const pcm = Buffer.from(await res.arrayBuffer());
      r.settle(est, true);
      return pcm;
    } catch (e) {
      r.settle(est, false);
      throw e;
    }
  }
}

/** Clip storage: data/ai_clips/<id>.pcm, served at GET /api/ai/clips/:id.pcm */
export class ClipStore {
  constructor(public readonly dir = path.join(process.cwd(), 'data', 'ai_clips')) {
    fs.mkdirSync(dir, { recursive: true });
  }
  save(pcm: Buffer): { clipId: string; file: string; durationMs: number } {
    const clipId = crypto.createHash('sha1').update(pcm).digest('hex').slice(0, 16);
    const file = path.join(this.dir, `${clipId}.pcm`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, pcm);
    else {
      // QA-058: a reused clip (same audio) is fresh again, so retention never deletes a clip that was just announced
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch {
        /* non-fatal */
      }
    }
    return { clipId, file, durationMs: pcmDurationMs(pcm) };
  }
  /** v2.0: store a browser clip: raw PCM -> <id>.wav, MP3 -> <id>.mp3 (content-addressed; reuse refreshes the time for retention). */
  saveAudio(audio: Buffer, format: 'pcm_24000' | 'mp3' = 'pcm_24000'): { clipId: string; ext: 'wav' | 'mp3'; file: string; durationMs: number } {
    const ext = format === 'mp3' ? 'mp3' : 'wav';
    const bytes = ext === 'wav' ? wavFromPcm(audio) : audio;
    const clipId = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
    const file = path.join(this.dir, `${clipId}.${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    else {
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch {
        /* non-fatal */
      }
    }
    const durationMs = ext === 'wav' ? pcmDurationMs(audio) : Math.round((audio.length * 8) / 128); // 128 kbit/s
    return { clipId, ext, file, durationMs };
  }
  /** clipId with or without extension (.wav / .mp3 / legacy .pcm). */
  path(clipId: string) {
    const m = /^([a-f0-9]{16})(?:\.(wav|mp3|pcm))?$/.exec(clipId);
    if (!m) return null;
    for (const ext of m[2] ? [m[2]] : ['wav', 'mp3', 'pcm']) {
      const f = path.join(this.dir, `${m[1]}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }
}
