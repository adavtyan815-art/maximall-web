import dotenv from 'dotenv';
dotenv.config(); // the untracked .env may hold LOCAL_ADMIN_PASSWORD for local QA
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import http from 'http';
import { AddressInfo } from 'net';
import { verifyAdminLogin, adminAuthMode } from '../src/services/adminAuth';

const base = { ADMIN_USERNAME: 'admin' };

describe('admin login fails closed', () => {
  it('empty ADMIN_PASSWORD_HASH refuses everything, including the empty password', async () => {
    const cfg = { ...base, ADMIN_PASSWORD_HASH: '' };
    expect(adminAuthMode(cfg)).toBe('disabled');
    expect(await verifyAdminLogin('admin', '', cfg)).toBe(false);
    expect(await verifyAdminLogin('admin', 'anything', cfg)).toBe(false);
    expect(await verifyAdminLogin('admin', undefined, cfg)).toBe(false);
  });
  it('bcrypt hashes are verified with bcrypt.compare', async () => {
    const hash = await bcrypt.hash('s3cret-test', 4);
    const cfg = { ...base, ADMIN_PASSWORD_HASH: hash };
    expect(adminAuthMode(cfg)).toBe('bcrypt');
    expect(await verifyAdminLogin('admin', 's3cret-test', cfg)).toBe(true);
    expect(await verifyAdminLogin('admin', hash, cfg)).toBe(false); // the hash itself is not the password
    expect(await verifyAdminLogin('root', 's3cret-test', cfg)).toBe(false);
  });
  it('a plaintext value still works (legacy env form), compared in constant time', async () => {
    const cfg = { ...base, ADMIN_PASSWORD_HASH: 'plain-pass' };
    expect(adminAuthMode(cfg)).toBe('plaintext');
    expect(await verifyAdminLogin('admin', 'plain-pass', cfg)).toBe(true);
    expect(await verifyAdminLogin('admin', 'plain-pas', cfg)).toBe(false);
    expect(await verifyAdminLogin('admin', '', cfg)).toBe(false);
  });
  it('LOCAL_ADMIN_PASSWORD only counts in LOCAL_MODE and only when no production value is set', async () => {
    expect(adminAuthMode({ ...base, ADMIN_PASSWORD_HASH: '', LOCAL_MODE: false, LOCAL_ADMIN_PASSWORD: 'x' })).toBe('disabled');
    expect(await verifyAdminLogin('admin', 'x', { ...base, ADMIN_PASSWORD_HASH: '', LOCAL_MODE: true, LOCAL_ADMIN_PASSWORD: 'x' })).toBe(true);
    expect(await verifyAdminLogin('admin', 'x', { ...base, ADMIN_PASSWORD_HASH: 'prod', LOCAL_MODE: true, LOCAL_ADMIN_PASSWORD: 'x' })).toBe(false);
  });
});

describe('POST /api/admin/login in the app', () => {
  let server: http.Server;
  let url: string;
  const saved = { ...process.env };
  beforeAll(async () => {
    process.env.LOCAL_MODE = '1';
    delete process.env.ADMIN_PASSWORD_HASH;
    const { default: app } = await import('../src/app');
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    process.env = saved;
    await new Promise<void>((r) => server.close(() => r()));
  });
  const login = (username: string, password: string) => fetch(`${url}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  it('admin with an empty password is refused (the old bypass)', async () => {
    expect((await login('admin', '')).status).toBe(401);
    expect((await login('admin', 'wrong')).status).toBe(401);
  });
  it.skipIf(!process.env.LOCAL_ADMIN_PASSWORD)('the local test password from the untracked .env logs in and opens an admin endpoint', async () => {
    const r = await login('admin', process.env.LOCAL_ADMIN_PASSWORD!);
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(`${url}/api/admin/ai/report.json`, { headers: { cookie } })).status).toBe(200);
  });
});
