import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';

let server: http.Server;
let url: string;

beforeAll(async () => {
  process.env.LOCAL_MODE = '1';
  const { default: app } = await import('../src/app');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('/api/saves (existing route) — QA-004 path-safe usernames (Unicode logins allowed)', () => {
  it('still saves, lists and deletes for a valid username', async () => {
    const body = { username: 'qa_test.user-1', saveId: 's-1', saveName: 'Ванная', date: '2026-09-30', boothStates: [], metrics: { floorAreaM2: 5 } };
    const r1 = await fetch(`${url}/api/saves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r1.status).toBe(200);
    const list = await (await fetch(`${url}/api/saves/qa_test.user-1`)).json();
    expect(list.find((s: any) => s.saveId === 's-1').metrics.floorAreaM2).toBe(5);
    const r3 = await fetch(`${url}/api/saves/qa_test.user-1/s-1`, { method: 'DELETE' });
    expect(r3.status).toBe(200);
  });

  it('keeps saving for existing Cyrillic / spaced logins (production users)', async () => {
    for (const u of ['Артур', 'Иван Петров', 'ivan.petrov@mail.ru', 'Ёлка_2026-x']) {
      const body = { username: u, saveId: 'cyr-1', saveName: 'Ванная', date: '2026-10-06' };
      const r1 = await fetch(`${url}/api/saves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(r1.status, u).toBe(200);
      const list = await (await fetch(`${url}/api/saves/${encodeURIComponent(u)}`)).json();
      expect(list.some((s: any) => s.saveId === 'cyr-1'), u).toBe(true);
      expect((await fetch(`${url}/api/saves/${encodeURIComponent(u)}/cyr-1`, { method: 'DELETE' })).status, u).toBe(200);
    }
  });

  it('rejects path traversal and other unsafe usernames on POST, GET and DELETE', async () => {
    for (const u of ['../../etc/passwd', '..', '.', 'a..b', 'a/b', 'a\\b', 'x'.repeat(65), 'я'.repeat(65), 'a\u0000b', 'a\nb', 'a\u0085b', 'a<b>', 'a:b', 'a*b', 42]) {
      const p = await fetch(`${url}/api/saves`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, saveId: 's', saveName: 'n', date: 'd' }) });
      expect(p.status, String(u)).toBe(400);
    }
    expect((await fetch(`${url}/api/saves/${encodeURIComponent('..%2F..%2Fapp')}`)).status).toBe(400);
    expect((await fetch(`${url}/api/saves/${encodeURIComponent('../x')}`)).status).toBe(400);
    expect((await fetch(`${url}/api/saves/${encodeURIComponent('../x')}/s1`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${url}/api/saves/${encodeURIComponent('a\u0000b')}`)).status).toBe(400);
  });

  it('isSafeUsername: Unicode letters/digits/space/._@- up to 64 characters', async () => {
    const { isSafeUsername } = await import('../src/app');
    for (const ok of ['Артур', 'Анна Мария', 'user_1.test@x-y', '学生', 'Ж'.repeat(64), '.hidden']) expect(isSafeUsername(ok), ok).toBe(true);
    for (const bad of ['', '..', 'a..b', 'a/b', 'a\\b', 'a\tb', 'Ж'.repeat(65), 'a+b', null, undefined, {}]) expect(isSafeUsername(bad), String(bad)).toBe(false);
  });

  it('serves the AI health endpoint from the same app (mock providers, catalog loaded)', async () => {
    const h = await (await fetch(`${url}/api/ai/health`)).json();
    expect(h.ok).toBe(true);
    expect(h.enabled).toBe(true);
    expect(h.localMode).toBe(true);
    expect(h.mock.llm).toBe(true);
    expect(h.catalog.mappings).toBeGreaterThan(400);
  });

  it("QA-020: per-session data (logins) only behind the admin login", async () => {
    expect((await fetch(url + "/api/admin/ai/stats")).status).toBe(401);
    expect((await fetch(url + "/api/admin/ai/spend.html")).status).toBe(401);
    expect((await fetch(url + "/api/admin/ai/report.json")).status).toBe(401);
    expect((await fetch(url + "/api/admin/ai/session/inst-1%3Aanna")).status).toBe(401); // CR-WEB-03 admin only
    expect((await fetch(url + "/api/admin/ai/session/inst-1%3Aanna/say", { method: "POST" })).status).toBe(401);
    const spend = await (await fetch(url + "/api/ai/spend")).json();
    expect(Object.keys(spend).sort()).toEqual(["byProvider", "calls", "capUsd", "totalUsd"]);
    const stats = await (await fetch(url + "/api/ai/stats")).text();
    expect(stats).not.toContain("sessionId");
  });
});
