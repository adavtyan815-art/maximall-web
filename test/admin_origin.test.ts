import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { io as ioc, Socket } from 'socket.io-client';

/**
 * Admin CSRF hardening (coordinator 23:45): /api/admin/* with a foreign Origin -> 403 and no CORS allow headers;
 * same origin works; the session cookie is SameSite=Strict + HttpOnly (+ Secure behind https); other routes keep
 * reflecting any origin (player pages on changing EC2 IPs / ngrok).
 */
const PASS = 'origin-test-pass';
const EVIL = 'https://evil.example';
let server: http.Server;
let url: string;
let ws: any;
let user = 'admin';
const saved = { ...process.env };

beforeAll(async () => {
  process.env.LOCAL_MODE = '1';
  process.env.ADMIN_PASSWORD_HASH = PASS; // legacy plaintext form, read at call time
  delete process.env.PUBLIC_ORIGIN;
  const { default: app, aiModule } = await import('../src/app');
  const { config } = await import('../src/config');
  user = config.ADMIN_USERNAME;
  const { WebSocketService } = await import('../src/services/websocketService');
  server = http.createServer(app);
  ws = new WebSocketService(server);
  aiModule.attach(ws.getIo());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env = saved;
  ws?.getIo().close();
  await new Promise<void>((r) => server.close(() => r()));
});

const login = async (headers: Record<string, string> = {}) =>
  fetch(`${url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: user, password: PASS }) });
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

describe('admin API origin check', () => {
  it('session cookie: SameSite=Strict, HttpOnly; Secure only when the request came over https (X-Forwarded-Proto)', async () => {
    const r = await login();
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).not.toMatch(/;\s*Secure/i);
    const rs = await login({ 'X-Forwarded-Proto': 'https' });
    expect(rs.status).toBe(200);
    expect(rs.headers.get('set-cookie')!).toMatch(/;\s*Secure/i);
  });

  it('a cross-origin POST to /say with a valid cookie gets 403 and no CORS allow header; same origin says it', async () => {
    // a live visitor session on the /ai namespace
    const sock: Socket = ioc(`${url}/ai`, { transports: ['websocket'], auth: { instanceUuid: 'inst-a', username: 'visitor_a' }, reconnection: false });
    const got: string[] = [];
    sock.on('ai.message', (p: any) => got.push(p.text));
    await new Promise<void>((res) => sock.on('ai.session.ready', () => res()));
    const cookie = cookieOf(await login());
    const say = (origin: string | undefined, text: string) =>
      fetch(`${url}/api/admin/ai/session/${encodeURIComponent('inst-a:visitor_a')}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie, ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ text }),
      });

    const bad = await say(EVIL, 'Скидка 90%!');
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect(bad.headers.get('access-control-allow-credentials')).toBeNull();
    const pre = await fetch(`${url}/api/admin/ai/session/x/say`, { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(pre.status).toBe(403);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    for (const o of ['null', `${url}.evil.example`, url.replace('127.0.0.1', 'localhost')]) expect((await say(o, 'x')).status).toBe(403);
    // cross-origin login is refused too (login CSRF)
    expect((await login({ Origin: EVIL })).status).toBe(403);

    const ok = await say(url, 'Здравствуйте, я менеджер салона.');
    expect(ok.status).toBe(200);
    expect((await say(undefined, 'Без Origin — как раньше.')).status).toBe(200); // curl / same-origin navigation
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContain('Здравствуйте, я менеджер салона.');
    expect(got).not.toContain('Скидка 90%!');
    sock.close();
  });

  it('behind nginx the own origin is https://Host (X-Forwarded-Proto); PUBLIC_ORIGIN adds origins', async () => {
    const cookie = cookieOf(await login());
    const get = (origin: string, extra: Record<string, string> = {}) => fetch(`${url}/api/admin/ai/stats`, { headers: { cookie, Origin: origin, ...extra } });
    const host = new URL(url).host;
    expect((await get(`https://${host}`, { 'X-Forwarded-Proto': 'https' })).status).toBe(200);
    expect((await get(`http://${host}`, { 'X-Forwarded-Proto': 'https' })).status).toBe(403);
    expect((await get('http://localhost:8080')).status).toBe(403);
    process.env.PUBLIC_ORIGIN = 'http://localhost:8080, https://18-185-5-251.nip.io/';
    try {
      expect((await get('http://localhost:8080')).status).toBe(200);
      expect((await get('https://18-185-5-251.nip.io')).status).toBe(200);
      expect((await get(url)).status).toBe(200); // own origin still allowed
      expect((await get(EVIL)).status).toBe(403);
    } finally {
      delete process.env.PUBLIC_ORIGIN;
    }
  });

  it('other routes keep reflecting any origin (player pages on EC2 IPs / ngrok)', async () => {
    const r = await fetch(`${url}/api/ai/health`, { headers: { Origin: EVIL } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(EVIL);
  });

  it('mixed-case admin paths are protected (Express routing is case-insensitive)', async () => {
    for (const p of ['/API/admin/ai/report.json', '/Api/Admin/instances', '/api/Admin/ai/stats', '/API/DEBUG/x']) expect((await fetch(url + p)).status, p).toBe(401);
    const cookie = cookieOf(await login());
    expect((await fetch(`${url}/API/Admin/ai/stats`, { headers: { cookie, Origin: EVIL } })).status).toBe(403);
  });
});
