import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';

/** Security review: failed admin logins per address are limited (here 3 per 15 min), then 429 even for the right password. */
let server: http.Server;
let url: string;
let user = 'admin';
const saved = { ...process.env };

beforeAll(async () => {
  Object.assign(process.env, { LOCAL_MODE: '1', ADMIN_PASSWORD_HASH: 'bf-test-pass', ADMIN_LOGIN_MAX_FAILURES_15MIN: '3' });
  const { default: app } = await import('../src/app');
  user = (await import('../src/config')).config.ADMIN_USERNAME;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env = saved;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('admin login brute-force guard', () => {
  it('3 failures, then 429; a success before the limit does not count', async () => {
    const login = (password: string) => fetch(`${url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password }) });
    expect((await login('bf-test-pass')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await login('wrong')).status).toBe(401);
    expect((await login('wrong')).status).toBe(429);
    expect((await login('bf-test-pass')).status).toBe(429);
  });
});
