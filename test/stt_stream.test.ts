import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import { ElevenLabsRealtimeStt, MockStreamingStt } from '../src/ai/providers/streamingStt';
import { CostLedger } from '../src/ai/util/costLedger';

describe('streaming STT', () => {
  it('mock: partial transcripts while pushing, final on end; non-PCM falls back (null)', async () => {
    const partials: string[] = [];
    const m = new MockStreamingStt();
    expect(m.start({ sessionId: 's', mimeType: 'audio/webm;codecs=opus', onPartial: () => undefined })).toBeNull();
    const st = m.start({ sessionId: 's', mimeType: 'audio/pcm;rate=16000', onPartial: (t) => partials.push(t) })!;
    st.push(Buffer.from('MOCKTEXT:Сделай'));
    st.push(Buffer.from(' фото'));
    expect(partials).toEqual(['Сделай', 'Сделай фото']);
    expect((await st.end()).text).toBe('Сделай фото');
  });

  it('ElevenLabs realtime: documented URL params, xi-api-key header, input_audio_chunk messages, committed_transcript', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const seen: { url?: string; key?: string; msgs: any[] } = { msgs: [] };
    wss.on('connection', (ws, req) => {
      seen.url = req.url;
      seen.key = String(req.headers['xi-api-key']);
      ws.send(JSON.stringify({ message_type: 'session_started', session_id: 'x' }));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        seen.msgs.push(m);
        if (!m.commit) ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'добавь' }));
        else ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'добавь пенал' }));
      });
    });
    const port = (wss.address() as AddressInfo).port;
    const ledger = new CostLedger({ file: path.join(os.tmpdir(), `stt-${Date.now()}.jsonl`) });
    const el = new ElevenLabsRealtimeStt(ledger, 'test-key', `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`);
    const partials: string[] = [];
    const st = el.start({ sessionId: 'i:u', mimeType: 'audio/pcm;rate=16000', onPartial: (t) => partials.push(t) })!;
    st.push(Buffer.alloc(3200));
    await new Promise((r) => setTimeout(r, 150));
    const res = await st.end();
    wss.close();
    expect(res.text).toBe('добавь пенал');
    expect(partials).toContain('добавь');
    const q = new URLSearchParams(seen.url!.split('?')[1]);
    expect(seen.url!.startsWith('/v1/speech-to-text/realtime?')).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', language_code: 'ru', commit_strategy: 'manual' });
    expect(seen.key).toBe('test-key');
    expect(seen.msgs[0]).toMatchObject({ message_type: 'input_audio_chunk', commit: false, sample_rate: 16000 });
    expect(Buffer.from(seen.msgs[0].audio_base_64, 'base64').length).toBe(3200);
    expect(seen.msgs[seen.msgs.length - 1]).toMatchObject({ message_type: 'input_audio_chunk', commit: true });
    const entries = ledger.entries();
    expect(entries.map((e) => e.status)).toEqual(['reserved', 'settled']);
    expect(entries[1].actualUsd!).toBeCloseTo((0.4 / 3600) * 0.1, 8); // 3200 bytes = 0.1 s of 16 kHz s16le
  });
});
