import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';

/**
 * MONTH2_SPEC m2.2 §11.3 / M6: POST /api/ai/estimate exists only with AI_ENABLED=1 (the catalog loads only then). With the AI layer off
 * the route is absent (404) and its 64 KB parser is not mounted.
 */
let server: http.Server;
let url: string;
const saved = { ...process.env };

beforeAll(async () => {
  process.env.LOCAL_MODE = '1';
  delete process.env.AI_ENABLED;
  const appMod = await import('../src/app');
  expect(appMod.aiModule).toBeNull();
  server = http.createServer(appMod.default);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env = saved;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('M6 estimate route with AI disabled', () => {
  it('is absent: 404, also for a body above 64 KB', async () => {
    const small = await fetch(`${url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(small.status).toBe(404);
    const big = await fetch(`${url}/api/ai/estimate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(70 * 1024) }) });
    expect(big.status).toBe(404);
  });
});
