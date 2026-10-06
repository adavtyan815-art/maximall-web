import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as ioc, Socket } from 'socket.io-client';
import { AddressInfo } from 'net';
import { fixtureIndex } from './helpers/catalog';
import { createAiModule, AiModule } from '../src/ai';
import { AiSocketNamespace } from '../src/ai/socket';
import { CostLedger, usdEnv } from '../src/ai/util/costLedger';
import { MockLlm } from '../src/ai/providers/mockLlm';
import { MockStt, MockTts, ClipStore } from '../src/ai/providers/voice';

/**
 * Integration: the /ai sessions map used to grow forever in a long-running production process. Disconnected sessions
 * idle longer than sessionIdleMs are now pruned (a reconnect inside that window resumes), and the map is capped.
 */
const f = fixtureIndex();
let server: http.Server;
let url: string;
let mod: AiModule;
let ns: AiSocketNamespace;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiprune-'));

beforeAll(async () => {
  const app = express();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mod = createAiModule({
    catalog: f.catalog,
    logDir: path.join(tmp, 'logs'),
    clips: new ClipStore(path.join(tmp, 'clips')),
    renderDir: path.join(tmp, 'renders'),
    savesDir: path.join(tmp, 'saves'),
    dossierDir: path.join(tmp, 'dossiers'),
    providers: { llm: new MockLlm(), fallbackLlm: new MockLlm(), stt: new MockStt(), tts: new MockTts(), ledger: new CostLedger({ file: path.join(tmp, 'spend.jsonl') }), mock: { llm: true, stt: true, tts: true, render: true, renderFallback: true }, keys: {} } as any,
  });
  ns = new AiSocketNamespace(new SocketServer(server), mod.orchestrator, { mockFlags: () => ({}), greetOnStart: false, sessionIdleMs: 1000, maxSessions: 2, sweepMs: 0 });
});
afterAll(async () => {
  ns.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function connect(username: string): Promise<Socket> {
  const sock = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-p', username }, reconnection: false });
  await new Promise<void>((r) => sock.on('ai.session.ready', () => r()));
  return sock;
}
async function disconnect(sock: Socket, sessionId: string) {
  sock.close();
  // wait until the server side saw the disconnect
  for (let i = 0; i < 100 && (ns as any).connected.get(sessionId)?.size; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('/ai session pruning', () => {
  it('keeps connected sessions, drops a disconnected one only after the idle window, a reconnect inside it resumes', async () => {
    const a = await connect('anna');
    expect(ns.sessions.has('inst-p:anna')).toBe(true);
    expect(ns.pruneSessions(Date.now() + 60_000)).toEqual([]); // connected: never pruned
    await disconnect(a, 'inst-p:anna');
    expect(ns.pruneSessions(Date.now() + 500)).toEqual([]); // inside the idle window
    const a2 = await connect('anna'); // resume
    expect(ns.sessions.size).toBe(1);
    await disconnect(a2, 'inst-p:anna');
    expect(ns.pruneSessions(Date.now() + 2000)).toEqual(['inst-p:anna']);
    expect(ns.sessions.size).toBe(0);
    expect(ns.sessionFor('inst-p:anna')).toBeUndefined();
  });

  it('caps the map at maxSessions, dropping the longest-idle disconnected sessions first', async () => {
    for (const u of ['u1', 'u2', 'u3']) {
      const s = await connect(u);
      await disconnect(s, `inst-p:${u}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const live = await connect('u4'); // connected: never evicted
    const dropped = ns.pruneSessions(Date.now());
    expect(dropped).toEqual(['inst-p:u1', 'inst-p:u2']);
    expect([...ns.sessions.keys()].sort()).toEqual(['inst-p:u3', 'inst-p:u4']);
    live.close();
  });
});

describe('budget env validation (usdEnv)', () => {
  it('unset -> default; empty -> 0 (refuse); non-numeric / negative -> default cap, never "no cap"', () => {
    expect(usdEnv('X', 50, {})).toBe(50);
    expect(usdEnv('X', 50, { X: '' })).toBe(0);
    expect(usdEnv('X', 50, { X: '  ' })).toBe(0);
    expect(usdEnv('X', 50, { X: 'abc' })).toBe(50);
    expect(usdEnv('X', 50, { X: '-5' })).toBe(50);
    expect(usdEnv('X', 50, { X: 'Infinity' })).toBe(50);
    expect(usdEnv('X', 50, { X: '12.5' })).toBe(12.5);
    expect(usdEnv('X', 1.5, { X: '0' })).toBe(0);
  });
});
