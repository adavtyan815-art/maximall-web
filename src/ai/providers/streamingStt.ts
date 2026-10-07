import WebSocket from 'ws';
import { CostLedger } from '../util/costLedger';

export interface SttStream {
  push(chunk: Buffer): void;
  /** Commits the utterance and resolves with the final transcript. */
  end(): Promise<{ text: string }>;
  cancel(): void;
  /**
   * P3-04: timing of the provider socket for the `stt` log: ms from start to the STT socket being open, chunks held back
   * because it was not open yet (then sent in order on open), chunks forwarded directly, ms from the commit to the final.
   */
  stats?(): SttStreamStats;
}
export interface SttStreamStats {
  openMs?: number;
  heldBeforeOpen: number;
  forwardedLive: number;
  partials: number;
  commitToFinalMs?: number;
  finalBy?: 'committed' | 'timeout' | 'error';
}
export interface StreamingSttProvider {
  readonly name: string;
  readonly mock: boolean;
  /** Returns null when the audio format is not supported (the caller then uses batch STT). */
  /** v2.5: `lang` = the session language when the utterance starts (sets language_code; a later switch applies to the next one). */
  start(opts: { sessionId: string; mimeType: string; onPartial: (text: string) => void; lang?: 'ru' | 'en' }): SttStream | null;
}

const isPcm16k = (mime: string) => /^audio\/pcm/.test(mime) && /rate=16000/.test(mime.replace(/\s/g, ''));

/**
 * Mock streaming STT: the test convention of MockStt ("MOCKTEXT:" + UTF-8) streamed chunk by chunk; partials are the
 * text received so far, so the page's live transcript can be tested without a key.
 */
export class MockStreamingStt implements StreamingSttProvider {
  readonly name = 'mock-stream';
  readonly mock = true;
  start(opts: { sessionId: string; mimeType: string; onPartial: (text: string) => void; lang?: 'ru' | 'en' }): SttStream | null {
    if (!isPcm16k(opts.mimeType)) return null;
    const parts: Buffer[] = [];
    const text = () => {
      const b = Buffer.concat(parts);
      return b.subarray(0, 9).toString('utf8') === 'MOCKTEXT:' ? b.subarray(9).toString('utf8').trim() : '';
    };
    let partials = 0;
    return {
      push: (c) => {
        parts.push(c);
        const t = text();
        if (t) {
          partials++;
          opts.onPartial(t);
        }
      },
      end: async () => ({ text: text() || (opts.lang === 'en' ? 'Show me options for my bathroom' : 'Покажите варианты для моей ванной') }),
      cancel: () => undefined,
      stats: () => ({ openMs: 0, heldBeforeOpen: 0, forwardedLive: parts.length, partials, commitToFinalMs: 0, finalBy: 'committed' }),
    };
  }
}

/**
 * ElevenLabs realtime STT (docs checked 2026-09-30:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
 *   wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&language_code=ru&commit_strategy=manual
 *   header xi-api-key; client -> {message_type:'input_audio_chunk', audio_base_64, commit, sample_rate};
 *   server -> session_started, partial_transcript {text}, committed_transcript {text}, error types.
 * Only PCM 16 kHz (the page's preferred format); WebM/Opus goes to batch STT. Cost estimate per second of audio
 * (ELEVENLABS_STT_USD_PER_HOUR, default 0.40) is reserved at start for 30 s and settled with the real duration.
 */
export class ElevenLabsRealtimeStt implements StreamingSttProvider {
  readonly name = 'elevenlabs-realtime';
  readonly mock = false;
  /** v2.5: model + language code of the last stream (logs / the paid check; never the key). */
  lastRequest?: { provider: string; model: string; languageCode: string };
  constructor(private ledger: CostLedger, private apiKey = process.env.ELEVENLABS_API_KEY ?? '', private url = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime') {}

  start(opts: { sessionId: string; mimeType: string; onPartial: (text: string) => void; lang?: 'ru' | 'en' }): SttStream | null {
    if (!isPcm16k(opts.mimeType)) return null;
    const perSec = Number(process.env.ELEVENLABS_STT_USD_PER_HOUR ?? 0.4) / 3600;
    // v2.5: the model is configurable; the language is the session's when the utterance starts
    const model = process.env.ELEVENLABS_STT_REALTIME_MODEL || 'scribe_v2_realtime';
    const languageCode = opts.lang === 'en' ? 'en' : 'ru';
    this.lastRequest = { provider: 'elevenlabs-stt-realtime', model, languageCode };
    const reservation = this.ledger.reserve('elevenlabs', `stt realtime ${model}`, perSec * 30, opts.sessionId);
    const q = new URLSearchParams({ model_id: model, audio_format: 'pcm_16000', language_code: languageCode, commit_strategy: 'manual' });
    const t0 = Date.now();
    const ws = new WebSocket(`${this.url}?${q}`, { headers: { 'xi-api-key': this.apiKey } });
    // P3-04: chunks are forwarded the moment they arrive; only while the socket is still connecting are they held here
    // (and sent in order on open). The commit goes only with end() (ai.audio.end).
    const pending: string[] = [];
    const st: SttStreamStats = { heldBeforeOpen: 0, forwardedLive: 0, partials: 0 };
    let commitAt = 0;
    let bytes = 0;
    let finalText = '';
    let partial = '';
    let resolveFinal: ((t: string) => void) | null = null;
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      reservation.settle(perSec * (bytes / 32000), ok);
    };
    const send = (m: object, audio = false) => {
      const s = JSON.stringify(m);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(s);
        if (audio) st.forwardedLive++;
      } else {
        pending.push(s);
        if (audio) st.heldBeforeOpen++;
      }
    };
    ws.on('open', () => {
      st.openMs = Date.now() - t0;
      for (const s of pending.splice(0)) ws.send(s);
    });
    ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.message_type === 'partial_transcript' && typeof m.text === 'string') {
        st.partials++;
        partial = m.text;
        opts.onPartial(m.text);
      } else if (m.message_type === 'committed_transcript' && typeof m.text === 'string') {
        finalText = [finalText, m.text].filter(Boolean).join(' ');
        if (resolveFinal) st.finalBy = 'committed';
        resolveFinal?.(finalText);
      } else if (/error|exceeded|limited/.test(String(m.message_type))) {
        if (resolveFinal) st.finalBy = 'error';
        resolveFinal?.(finalText || partial);
      }
    });
    ws.on('error', () => {
      if (resolveFinal) st.finalBy = 'error';
      resolveFinal?.(finalText || partial);
    });
    return {
      push: (chunk) => {
        bytes += chunk.length;
        send({ message_type: 'input_audio_chunk', audio_base_64: chunk.toString('base64'), commit: false, sample_rate: 16000 }, true);
      },
      end: () =>
        new Promise<{ text: string }>((resolve) => {
          const done = (t: string) => {
            clearTimeout(timer);
            if (commitAt) st.commitToFinalMs = Date.now() - commitAt;
            resolveFinal = null;
            settle(true);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            resolve({ text: t.trim() });
          };
          const timer = setTimeout(() => {
            st.finalBy = 'timeout';
            done(finalText || partial);
          }, 5000);
          resolveFinal = done;
          commitAt = Date.now();
          send({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 });
        }),
      stats: () => ({ ...st }),
      cancel: () => {
        settle(true);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
  }
}
