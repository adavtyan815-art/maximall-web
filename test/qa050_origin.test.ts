import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { io as ioc } from 'socket.io-client';

/**
 * QA-050 (env note): a player page served from a second local signalling (:8081) got no /ai socket.
 * The backend does not restrict origins (express cors and the shared Socket.io server both reflect any origin),
 * so this pins that down on the real app + the real WebSocketService: a page on :8081 gets CORS and a socket.
 */
let server: http.Server;
let url: string;
let ws: any;

beforeAll(async () => {
  process.env.LOCAL_MODE = '1';
  const { default: app, aiModule } = await import('../src/app');
  const { WebSocketService } = await import('../src/services/websocketService');
  server = http.createServer(app);
  ws = new WebSocketService(server);
  aiModule.attach(ws.getIo());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  ws?.getIo().close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('backend origins for local pages (:8080 and :8081)', () => {
  for (const origin of ['http://localhost:8080', 'http://localhost:8081', 'http://127.0.0.1:8081']) {
    it(`HTTP CORS reflects ${origin}`, async () => {
      const r = await fetch(`${url}/api/ai/health`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
      expect(r.headers.get('access-control-allow-origin')).toBe(origin);
    });
    it(`/ai socket connects from ${origin} (polling handshake carries the Origin header)`, async () => {
      const sock = ioc(`${url}/ai`, { transports: ['polling'], extraHeaders: { Origin: origin }, auth: { instanceUuid: 'inst-o', username: 'origin_probe' }, reconnection: false });
      const ready = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no socket')), 5000);
        sock.on('ai.session.ready', (p) => {
          clearTimeout(t);
          resolve(p);
        });
        sock.on('connect_error', (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      expect(ready.sessionId).toBe('inst-o:origin_probe');
      sock.close();
    });
  }
});
