import type { EnvelopeResult } from '../sim/fakeUe';
import type { FakeUe } from '../sim/fakeUe';

export type { EnvelopeResult };
export type Origin = 'card_tap' | 'model' | 'ui' | 'scripted_fallback' | 'test';

/** envelope.schema.json#/$defs/request */
export interface EnvelopeRequest {
  type: 'MaxiMallAI';
  id: string;
  cmd: string;
  args: Record<string, any>;
  sessionId?: string;
  origin?: Origin;
}

/** How the orchestrator reaches UE: through the player page (Socket.io ai.command) or directly (simulation). */
export interface CommandChannel {
  send(req: EnvelopeRequest, timeoutMs: number): Promise<EnvelopeResult>;
}

let n = 0;
export function newRequestId() {
  return `r-${Date.now()}-${++n}`;
}

export function timeoutResult(req: EnvelopeRequest): EnvelopeResult {
  return { type: 'result', id: req.id, cmd: req.cmd, ok: false, reasonCode: 'TIMEOUT', reason: 'Нет ответа от комнаты', state_rev: 0 };
}

/** Page-mediated channel: emits ai.command, resolves on ai.command.result with the same id. */
/** The page may hold a command up to 30 s while the data channel is down (ueBridge QUEUE_WAIT_MS). */
export const PAGE_QUEUE_WAIT_MS = Number(process.env.AI_PAGE_QUEUE_WAIT_MS ?? 30000);

/** QA-044 / CR-AI-05: the separate "waiting for the room" status (not the thinking indicator). */
export const ROOM_WAIT_TEXT_RU = 'Подключаюсь к 3D-комнате…';
export type RoomWaitEnd = 'sent' | 'result' | 'timeout' | 'closed';

export class SocketChannel implements CommandChannel {
  private pending = new Map<string, { resolve: (r: EnvelopeResult) => void; timer: NodeJS.Timeout; req: EnvelopeRequest; execMs: number; state: 'pending' | 'queued' | 'sent' }>();
  constructor(private emit: (event: string, payload: any) => void) {}
  /**
   * QA-043 / CR-AI-04: the timeout covers the page queue + execution. Until the page reports `ai.command.status sent`,
   * the deadline is PAGE_QUEUE_WAIT_MS + execution time; on `sent` the execution timeout restarts from that moment.
   * A page without status events therefore never gets a TIMEOUT while it may still deliver the command.
   */
  /** QA-044: ai.command.wait off for a command that was shown as queued (sent, answered, timed out or connection closed). */
  private waitOff(id: string, p: { req: EnvelopeRequest; state: string }, reason: RoomWaitEnd) {
    if (p.state === 'queued') this.emit('ai.command.wait', { id, cmd: p.req.cmd, on: false, reason });
  }
  send(req: EnvelopeRequest, timeoutMs: number): Promise<EnvelopeResult> {
    return new Promise((resolve) => {
      const timer = this.arm(req.id, PAGE_QUEUE_WAIT_MS + timeoutMs);
      this.pending.set(req.id, { resolve, timer, req, execMs: timeoutMs, state: 'pending' });
      this.emit('ai.command', { request: req });
    });
  }
  private arm(id: string, ms: number) {
    return setTimeout(() => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.waitOff(id, p, 'timeout');
      p.resolve(timeoutResult(p.req));
    }, ms);
  }
  /** ai.command.status {id, state: queued|sent} from the page. Returns the new state, or null for an unknown id. */
  status(id: string, state: string): string | null {
    const p = this.pending.get(id);
    if (!p) return null;
    if (state === 'sent' && p.state !== 'sent') {
      clearTimeout(p.timer);
      p.timer = this.arm(id, p.execMs);
      this.waitOff(id, p, 'sent');
      p.state = 'sent';
    } else if (state === 'queued' && p.state === 'pending') {
      p.state = 'queued';
      this.emit('ai.command.wait', { id, cmd: p.req.cmd, on: true, text: ROOM_WAIT_TEXT_RU });
    }
    return p.state;
  }
  isQueued(id: string) {
    return this.pending.get(id)?.state === 'queued';
  }
  /** Returns false for ids this channel did not send (e.g. card taps sent by the page itself). */
  deliver(result: EnvelopeResult): boolean {
    const p = this.pending.get(result.id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    this.waitOff(result.id, p, 'result');
    p.resolve(result);
    return true;
  }
  cancelAll() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.waitOff(id, p, 'closed');
      p.resolve({ type: 'result', id, cmd: '', ok: false, reasonCode: 'TIMEOUT', reason: 'Соединение закрыто', state_rev: 0 });
    }
    this.pending.clear();
  }
}

/** Direct channel to the in-process simulator (tests, phrase harness, LOCAL_MODE dev endpoint). */
export class DirectChannel implements CommandChannel {
  constructor(public ue: FakeUe) {}
  async send(req: EnvelopeRequest): Promise<EnvelopeResult> {
    return this.ue.execute(req);
  }
}
