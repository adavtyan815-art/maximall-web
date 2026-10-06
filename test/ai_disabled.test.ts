import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { io as ioc } from 'socket.io-client';

/**
 * Integration (AI_ENABLED, default off): without AI_ENABLED=1 the app is the pre-AI orchestrator — no AI module, no /ai
 * namespace, no AI routes; only GET /api/ai/health answers {ok:true, enabled:false} with its own CORS (reflect Origin,
 * GET only, no credentials) because the player page probes it cross-origin.
 */
let server: http.Server;
let url: string;
let ws: any;
let appMod: any;
const saved = { ...process.env };

beforeAll(async () => {
  process.env.LOCAL_MODE = '1';
  delete process.env.AI_ENABLED;
  appMod = await import('../src/app');
  const { WebSocketService } = await import('../src/services/websocketService');
  server = http.createServer(appMod.default);
  ws = new WebSocketService(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env = saved;
  ws?.getIo().close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('AI_ENABLED unset (default)', () => {
  it('creates no AI module', () => {
    expect(appMod.AI_ENABLED).toBe(false);
    expect(appMod.aiModule).toBeNull();
  });

  it('aiEnabledFromEnv accepts only 1 / true', () => {
    for (const v of ['1', 'true', 'TRUE', ' 1 ']) expect(appMod.aiEnabledFromEnv({ AI_ENABLED: v }), v).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'yes', 'on']) expect(appMod.aiEnabledFromEnv({ AI_ENABLED: v }), String(v)).toBe(false);
  });

  it('GET /api/ai/health -> {ok:true, enabled:false}, CORS reflects the Origin without credentials', async () => {
    const r = await fetch(`${url}/api/ai/health`, { headers: { Origin: 'http://localhost:8090' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, enabled: false });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:8090');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    const pre = await fetch(`${url}/api/ai/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8090', 'Access-Control-Request-Method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:8090');
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET');
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('AI routes are not mounted (they fall through exactly like before the AI layer)', async () => {
    for (const p of ['/api/ai/spend', '/api/ai/clips/x.wav', '/d/abc']) {
      const r = await fetch(url + p);
      expect(r.headers.get('content-type'), p).toMatch(/text\/html/); // SPA fallback (index.html), as in the pre-AI server
    }
    expect((await fetch(`${url}/api/render`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${url}/api/dossier`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${url}/api/admin/ai/stats`)).status).toBe(401); // admin guard first, as for every /api/admin path
  });

  it('there is no /ai Socket.io namespace', async () => {
    const sock = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-x', username: 'nobody' }, reconnection: false });
    const err = await new Promise<string>((resolve) => {
      sock.on('connect_error', (e) => resolve(e.message));
      sock.on('connect', () => resolve('connected'));
    });
    sock.close();
    expect(err).toBe('Invalid namespace');
  });

  it('the live /api/ar/upload handler (UE client contract: 200 JSON with a string url) is unchanged', async () => {
    const glb = Buffer.alloc(24);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    const r = await fetch(`${url}/api/ar/upload`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary', 'X-File-Name': 'vitest_ai_off.glb' }, body: new Uint8Array(glb) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.success).toBe(true);
    expect(j.url).toMatch(/\/ar\/viewer\.html\?model=vitest_ai_off\.glb$/);
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    fs.rmSync(path.join(__dirname, '../public/ar/models/vitest_ai_off.glb'), { force: true });
  });
});
