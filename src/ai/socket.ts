import type { Server as SocketServer, Socket } from 'socket.io';
import { AiSession, consultantName, greetingFor, Orchestrator, type UiAction } from './orchestrator/orchestrator';
import { normalizeLang, t, type Lang } from './i18n';
import { RateLimiter, envInt } from './util/rateLimit';
import { SocketChannel } from './orchestrator/channel';
import { isGuest } from './util/identity';
import { checkClientPayload, knownClientEvents } from './contractValidation';

/** Client events whose contract has no required field: a missing payload counts as {}. */
const OPTIONAL_PAYLOAD = new Set(['ai.audio.start', 'ai.audio.end', 'ai.audio.cancel', 'ai.reset', 'ai.render.request', 'ai.dossier.request']);
import type { StreamingSttProvider, SttStream } from './providers/streamingStt';
import { applySttCorrectionFor } from './voice/sttCorrect';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK = 32 * 1024;
/** QA-096: chunks arriving this long after ai.audio.end are still counted (chunksAfterEnd / stt_late_chunks). */
const LATE_GRACE_MS = Number(process.env.AI_STT_LATE_GRACE_MS ?? 2000);

export interface AiNamespaceOptions {
  mockFlags: () => Record<string, boolean>;
  greetOnStart?: boolean;
  sttStream?: StreamingSttProvider;
  /** Security review: is this hostToken a live session of that pool instance? Enforced only with AI_REQUIRE_HOST_TOKEN=1. */
  verifyHostToken?: (instanceUuid: string, hostToken: string) => boolean;
  /** Session pruning: a session with no connected socket and no activity for this long is dropped (default AI_SESSION_IDLE_MIN=120 min). */
  sessionIdleMs?: number;
  /** Upper bound on kept sessions; beyond it the longest-idle disconnected ones go first (default AI_MAX_SESSIONS=2000). */
  maxSessions?: number;
  /** Sweep period (default AI_SESSION_SWEEP_MIN=5 min); 0 = no timer (call pruneSessions() yourself). */
  sweepMs?: number;
}

const rateLimited = (lang: Lang) => ({ code: 'RATE_LIMITED', message: t(lang, 'err.rateLimited') });

/**
 * Socket.io namespace /ai (socket-events.schema.json). One AiSession per sessionId = instanceUuid:username.
 * A reconnecting page rebinds its session (history, cards and basket survive a reload).
 */
let uiSeq = 0;
/** The implicit start from the socket auth (only there does auth.lang count as asked). */
const START_FROM_AUTH: { lang?: string } = {};

export class AiSocketNamespace {
  readonly sessions = new Map<string, AiSession>();
  private channels = new Map<string, SocketChannel>();
  // Security review: every visitor turn / recording may be a paid LLM / STT call -> per-session limits.
  private turnLimit = new RateLimiter(envInt('AI_TURNS_PER_SESSION_MIN', 15), 60_000);
  private audioStartLimit = new RateLimiter(envInt('AI_AUDIO_STARTS_PER_SESSION_MIN', 20), 60_000);
  /**
   * Integration (long-running production process): sessions used to live forever. Now each session tracks its connected
   * sockets and last activity; a disconnected session idle for sessionIdleMs is dropped (a page reload / reconnect within
   * that window still resumes it), and the map never exceeds maxSessions.
   */
  private lastSeen = new Map<string, number>();
  private connected = new Map<string, Set<string>>();
  readonly sessionIdleMs: number;
  readonly maxSessions: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private io: SocketServer, private orch: Orchestrator, private opts: AiNamespaceOptions) {
    this.sessionIdleMs = opts.sessionIdleMs ?? envInt('AI_SESSION_IDLE_MIN', 120) * 60_000;
    this.maxSessions = opts.maxSessions ?? envInt('AI_MAX_SESSIONS', 2000);
    const sweepMs = opts.sweepMs ?? envInt('AI_SESSION_SWEEP_MIN', 5) * 60_000;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.pruneSessions();
        } catch (e: any) {
          console.error('[AI] session pruning failed:', e?.message);
        }
      }, sweepMs);
      this.sweepTimer.unref?.();
    }
    io.of('/ai').on('connection', (socket) => this.onConnection(socket));
  }

  private touch(sessionId: string) {
    this.lastSeen.set(sessionId, Date.now());
  }

  private bindSocket(sessionId: string, socketId: string, previous?: string) {
    if (previous && previous !== sessionId) this.connected.get(previous)?.delete(socketId);
    let set = this.connected.get(sessionId);
    if (!set) this.connected.set(sessionId, (set = new Set()));
    set.add(socketId);
    this.touch(sessionId);
  }

  private forget(sessionId: string) {
    this.sessions.delete(sessionId);
    this.channels.get(sessionId)?.cancelAll();
    this.channels.delete(sessionId);
    this.lastSeen.delete(sessionId);
    this.connected.delete(sessionId);
  }

  /**
   * Drop sessions that have no connected /ai socket, are not mid-turn, and were idle longer than sessionIdleMs; then,
   * if still above maxSessions, the longest-idle disconnected ones. Returns the dropped session ids.
   */
  pruneSessions(now = Date.now()): string[] {
    const dropped: string[] = [];
    const idle: { id: string; at: number }[] = [];
    for (const [id, s] of this.sessions) {
      if ((this.connected.get(id)?.size ?? 0) > 0 || s.busy) continue;
      const at = this.lastSeen.get(id) ?? 0;
      if (now - at >= this.sessionIdleMs) {
        this.forget(id);
        dropped.push(id);
      } else idle.push({ id, at });
    }
    if (this.sessions.size > this.maxSessions) {
      idle.sort((a, b) => a.at - b.at);
      for (const { id } of idle) {
        if (this.sessions.size <= this.maxSessions) break;
        this.forget(id);
        dropped.push(id);
      }
    }
    if (dropped.length) console.log(`[AI] pruned ${dropped.length} idle /ai session(s); ${this.sessions.size} kept`);
    return dropped;
  }

  /** Stop the pruning timer (tests / shutdown). */
  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private onConnection(socket: Socket) {
    let session: AiSession | null = null;
    /**
     * P3-04 timing per utterance (all on the backend clock): t0 = ai.audio.start, first/last chunk arrival, chunk count. The
     * `stt` log then proves where time goes: chunkSpanMs ≈ holdMs means the page streamed while the button was held;
     * chunkSpanMs ≈ 0 with all chunks just before ai.audio.end means the page sent the audio at release.
     */
    /** v2.5: `lang` = the session language when the utterance STARTED (an ai.lang switch mid-utterance applies to the next one). */
    let audio: { chunks: Buffer[]; bytes: number; mimeType: string; stream: SttStream | null; t0: number; firstAt: number; lastAt: number; n: number; maxGapMs: number; lang: Lang } | null = null;
    /** chunks that arrive after ai.audio.end of the last utterance (dropped; counted for the log) */
    let ended: { at: number; late: number; maxMs: number; loggedLate: number | null } | null = null;
    const auth = (socket.handshake.auth ?? {}) as { sessionId?: string; instanceUuid?: string; username?: string; hostToken?: string; lang?: string };
    /** v2.5: the language of this socket's messages before a session exists (auth / ai.session.start), then the session's. */
    let socketLang: Lang = normalizeLang(auth.lang);
    const L = (): Lang => session?.lang ?? socketLang;
    const RATE_LIMITED_ = () => rateLimited(L());

    // QA-059: every incoming packet is checked against socket-events.schema.json (x-client-to-server) before any handler
    // runs. Unknown events, wrong types, missing fields and oversize values get ai.error BAD_PAYLOAD and are dropped.
    const known = knownClientEvents();
    const badPayload = (event: string, why: string) => {
      if (session) this.orch.log(session, 'bad_payload', { event: String(event).slice(0, 80), why });
      socket.emit('ai.error', { code: 'BAD_PAYLOAD', message: t(L(), 'err.badPayload') });
    };
    socket.use((packet, next) => {
      if (session) this.touch(session.sessionId);
      const event = String(packet[0]);
      if (!known.has(event)) return badPayload(event, 'unknown event');
      if (event === 'ai.audio.chunk') return next(); // binary: type and size checked in the handler
      if (packet[1] === undefined && OPTIONAL_PAYLOAD.has(event)) packet[1] = {};
      const why = checkClientPayload(event, packet[1]);
      if (!why) return next();
      const p: any = packet[1];
      if (event === 'ai.command.result' && p && typeof p === 'object' && typeof p.id === 'string') {
        // A pending backend command must never hang on a malformed result: deliver it as a normalised failure / result.
        if (session) this.orch.log(session, 'bad_payload', { event, why, id: p.id.slice(0, 80) });
        packet[1] = {
          type: 'result',
          id: p.id,
          cmd: typeof p.cmd === 'string' ? p.cmd : '',
          ok: p.ok === true,
          ...(p.ok === true ? {} : { reasonCode: typeof p.reasonCode === 'string' ? p.reasonCode : 'INTERNAL', reason: typeof p.reason === 'string' ? p.reason : t(L(), 'err.badResult'), ...(p.reasonParams && typeof p.reasonParams === 'object' && !Array.isArray(p.reasonParams) ? { reasonParams: p.reasonParams } : {}) }),
          result: p.result && typeof p.result === 'object' ? p.result : {},
          state_rev: Number.isInteger(p.state_rev) && p.state_rev >= 0 ? p.state_rev : 0,
        };
        return next();
      }
      badPayload(event, why);
    });

    /** Refused start: the error, then the server closes this /ai socket (not the shared connection), so the page's own disconnect handler shows «нет связи» (no auto-reconnect after a server disconnect). */
    const refuse = (code: string, message: string) => {
      socket.emit('ai.error', { code, message });
      setTimeout(() => socket.disconnect(), 50); // QA-054: this /ai namespace only — the shared connection (default-namespace back-channel) stays up
    };

    const start = (p: { instanceUuid?: string; username?: string; viewport?: string; hostToken?: string; lang?: string }) => {
      // v2.5: an explicit lang (start payload, or the socket auth for the implicit start) sets the language; absent -> the session's
      const askedLang = typeof p.lang === 'string' ? normalizeLang(p.lang) : p === START_FROM_AUTH && typeof auth.lang === 'string' ? normalizeLang(auth.lang) : undefined;
      if (askedLang) socketLang = askedLang;
      const instanceUuid = String(p.instanceUuid ?? auth.instanceUuid ?? '').slice(0, 100);
      const username = String(p.username ?? auth.username ?? '').slice(0, 100);
      const hostToken = String(p.hostToken ?? auth.hostToken ?? '').slice(0, 200);
      if (!instanceUuid || !username) {
        socket.emit('ai.error', { code: 'BAD_SESSION', message: t(L(), 'err.badSession') });
        return;
      }
      const sessionId = `${instanceUuid}:${username}`;
      // Security review (session takeover): with AI_REQUIRE_HOST_TOKEN=1 the page must prove it holds a live pool session
      // of that instance; and a session once bound to a hostToken is never taken over by a socket with another one.
      if (process.env.AI_REQUIRE_HOST_TOKEN === '1' && (!hostToken || !this.opts.verifyHostToken?.(instanceUuid, hostToken))) return refuse('BAD_SESSION', t(L(), 'err.unconfirmed'));
      const bound = this.sessions.get(sessionId)?.hostToken;
      if (bound && hostToken !== bound) return refuse('SESSION_TAKEN', t(L(), 'err.taken'));
      if (session && session.sessionId === sessionId) {
        // repeated start with the same identity (auth + explicit start): just confirm
        if (askedLang) this.orch.setLang(session, askedLang);
        socket.emit('ai.session.ready', this.readyPayload(session, sessionId));
        this.orch.emitMode(session, 'start');
        return this.orch.emitBasket(session);
      }
      // CR-WEB-01 (v1.3): a guest session (guest-<deviceId>) that learns the real login merges into the named session (the lead).
      const guest = session && session.instanceUuid === instanceUuid && isGuest(session.username) && !isGuest(username) ? session : this.soleGuestOn(instanceUuid, username);
      const guestChannel = guest && guest === session ? this.channels.get(guest.sessionId) : undefined;
      const channel = guestChannel ?? new SocketChannel((ev, payload) => socket.emit(ev, payload), () => L());
      if (!guestChannel) this.channels.get(sessionId)?.cancelAll();
      this.channels.set(sessionId, channel);
      const io = { emit: (ev: string, payload: any) => socket.emit(ev, payload) };
      let s = this.sessions.get(sessionId);
      let isNew = !s;
      if (!s) {
        s = new AiSession(sessionId, instanceUuid, username, channel, io);
        this.sessions.set(sessionId, s);
      } else {
        s.channel = channel;
        s.io = io;
      }
      if (guest && guest !== s) {
        this.orch.mergeSessions(guest, s);
        this.sessions.delete(guest.sessionId);
        this.channels.delete(guest.sessionId);
        this.lastSeen.delete(guest.sessionId);
        this.connected.get(guest.sessionId)?.delete(socket.id);
        if (!this.connected.get(guest.sessionId)?.size) this.connected.delete(guest.sessionId);
        isNew = false; // the visitor was already greeted as a guest
      }
      if (hostToken && !s.hostToken) s.hostToken = hostToken;
      // v2.5: a new session starts in the asked language; a resumed one keeps its own unless the page asks for another
      if (isNew) s.lang = askedLang ?? 'ru';
      else if (askedLang) this.orch.setLang(s, askedLang);
      this.bindSocket(sessionId, socket.id, session?.sessionId);
      session = s;
      socket.emit('ai.session.ready', this.readyPayload(s, sessionId));
      this.orch.emitMode(s, 'start'); // v2.0
      this.orch.log(s, 'session_start', { viewport: p.viewport, resumed: !isNew, lang: s.lang });
      if (isNew && this.opts.greetOnStart !== false) void this.orch.greet(s);
      else this.orch.emitBasket(s);
    };

    socket.on('ai.session.start', (p) => start(p ?? {}));
    // v2.5: the consultant panel's language switch — applies from the next turn; the session keeps it (reconnect / F5)
    socket.on('ai.lang', (p) => {
      const lang = normalizeLang(p?.lang);
      socketLang = lang;
      if (session) this.orch.setLang(session, lang);
      socket.emit('ai.lang.changed', { lang });
    });
    // v2.5: page buttons as actions (undo / reset_room / other_collections / offer_answer)
    socket.on('ai.action', (p) => {
      if (!session) return socket.emit('ai.error', { code: 'NO_SESSION', message: t(L(), 'err.noSession') });
      if (!this.turnLimit.take(session.sessionId)) return socket.emit('ai.error', RATE_LIMITED_());
      void this.orch.handleAction(session, String(p.action) as UiAction, typeof p.optionId === 'string' ? p.optionId : undefined, typeof p.offerId === 'string' ? p.offerId : undefined);
    });
    socket.on('ai.turn.text', (p) => {
      if (!session) return socket.emit('ai.error', { code: 'NO_SESSION', message: t(L(), 'err.noSession') });
      const text = String(p?.text ?? '').slice(0, 1000).trim();
      if (!text) return;
      if (!this.turnLimit.take(session.sessionId)) return socket.emit('ai.error', RATE_LIMITED_());
      void this.orch.handleTurn(session, text, 'text');
    });
    socket.on('ai.audio.start', (p) => {
      audio?.stream?.cancel();
      if (session && !this.audioStartLimit.take(session.sessionId)) {
        audio = null;
        return socket.emit('ai.error', RATE_LIMITED_());
      }
      const mimeType = String(p?.mimeType ?? 'audio/pcm;rate=16000');
      const uttLang: Lang = session?.lang ?? 'ru';
      let stream: SttStream | null = null;
      try {
        // Streaming STT (partials as ai.transcript final:false) for PCM 16 kHz; other formats use batch STT on release.
        stream = session && this.opts.sttStream ? this.opts.sttStream.start({ sessionId: session.sessionId, mimeType, lang: uttLang, onPartial: (text) => socket.emit('ai.transcript', { final: false, text }) }) : null;
      } catch (e: any) {
        if (session) this.orch.log(session, 'stt_stream_error', { message: e.message });
      }
      audio = { chunks: [], bytes: 0, mimeType, stream, t0: Date.now(), firstAt: 0, lastAt: 0, n: 0, maxGapMs: 0, lang: uttLang };
      ended = null;
    });
    socket.on('ai.audio.chunk', (chunk: any) => {
      if (!audio) {
        // QA-096: a chunk that arrives after ai.audio.end (within the grace window) is dropped and counted
        const ms = ended ? Date.now() - ended.at : Infinity;
        if (ended && ms <= LATE_GRACE_MS) {
          ended.late++;
          ended.maxMs = Math.max(ended.maxMs, ms);
        }
        return;
      }
      const b = Buffer.isBuffer(chunk) ? chunk : chunk instanceof ArrayBuffer ? Buffer.from(chunk) : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : null;
      if (!b || b.length > MAX_CHUNK || audio.bytes + b.length > MAX_AUDIO_BYTES) {
        socket.emit('ai.error', { code: 'AUDIO_TOO_LARGE', message: t(L(), 'err.audioTooLarge') });
        audio = null;
        return;
      }
      const now = Date.now();
      if (!audio.n) audio.firstAt = now;
      else audio.maxGapMs = Math.max(audio.maxGapMs, now - audio.lastAt);
      audio.lastAt = now;
      audio.n++;
      audio.chunks.push(b);
      audio.bytes += b.length;
      audio.stream?.push(b); // forwarded to the realtime STT as it arrives (held only while its socket is connecting)
    });
    socket.on('ai.audio.end', () => {
      if (!session || !audio) return;
      if (!this.turnLimit.take(session.sessionId)) {
        audio.stream?.cancel();
        audio = null;
        return socket.emit('ai.error', RATE_LIMITED_());
      }
      const buf = Buffer.concat(audio.chunks);
      const a = audio;
      const { mimeType: mime, stream, t0, lang: uttLang } = a;
      const tEnd = Date.now();
      audio = null;
      const lateRef = (ended = { at: tEnd, late: 0, maxMs: 0, loggedLate: null as number | null });
      // QA-096: chunks may still arrive after the final transcript was logged: after the grace window a follow-up line
      // `stt_late_chunks` reports any the `stt` line did not include (the batch path has no `stt` timing line: all of them).
      const sLate = session;
      setTimeout(() => {
        const already = stream ? (lateRef.loggedLate ?? lateRef.late) : 0;
        if (lateRef.late > already) this.orch.log(sLate, 'stt_late_chunks', { chunksAfterEnd: lateRef.late, notInSttLine: lateRef.late - already, maxMsAfterEnd: lateRef.maxMs, graceMs: LATE_GRACE_MS });
      }, LATE_GRACE_MS + 50).unref?.();
      if (!buf.length) return stream?.cancel();
      if (stream) {
        const s = session;
        void stream.end().then(async ({ text: rawText }) => {
          const tFinal = Date.now();
          const { text, logFields: fixed } = applySttCorrectionFor(rawText, uttLang);
          lateRef.loggedLate = lateRef.late;
          // P3-04: msAfterRelease is now measured from ai.audio.end (before 2026-10-02 it was from ai.audio.start, i.e. it
          // included the whole hold; that number is msFromStart).
          this.orch.log(s, 'stt', {
            streaming: true,
            msAfterRelease: tFinal - tEnd,
            msFromStart: tFinal - t0,
            holdMs: tEnd - t0,
            audioMs: /pcm/.test(mime) ? Math.round(buf.length / 32) : undefined,
            bytes: buf.length,
            chunks: a.n,
            chunksAfterEnd: lateRef.late,
            lateGraceMs: LATE_GRACE_MS,
            msToFirstChunk: a.firstAt - t0,
            chunkSpanMs: a.lastAt - a.firstAt,
            msLastChunkToEnd: tEnd - a.lastAt,
            maxChunkGapMs: a.maxGapMs,
            provider: stream.stats?.(),
            text,
            ...fixed,
            ...(uttLang !== 'ru' ? { lang: uttLang } : {}),
          });
          socket.emit('ai.transcript', { final: true, text });
          if (text.trim()) await this.orch.handleTurn(s, text, 'voice');
          else socket.emit('ai.error', { code: 'STT_EMPTY', message: t(s.lang, 'stt.failed') });
        });
      } else void this.orch.handleAudio(session, buf, mime, uttLang);
    });
    socket.on('ai.audio.cancel', () => {
      audio?.stream?.cancel();
      audio = null;
    });
    socket.on('ai.command.result', (r) => {
      if (!session || !r?.id) return;
      const ch = this.channels.get(session.sessionId);
      if (!ch?.deliver(r)) this.orch.log(session, 'unsolicited_result', { id: r.id, cmd: r.cmd, ok: r.ok });
    });
    socket.on('ai.card.tap', (p) => {
      if (!session || !p?.cardId) return;
      void this.orch.handleCardTap(session, { cardId: String(p.cardId), requestId: String(p.requestId ?? ''), result: p.result });
    });
    socket.on('ai.command.status', (p) => {
      // CR-AI-04 (pre-approved, optional): the page reports queued/sent so the execution timeout starts at "sent".
      if (!session || !p?.id) return;
      const ch = this.channels.get(session.sessionId);
      // QA-044: the channel itself emits ai.command.wait on/off (queued -> sent / result / timeout); the thinking indicator is not used for it.
      ch?.status(String(p.id), String(p.state ?? ''));
    });
    socket.on('ai.ue.event', (e) => {
      if (!session) return;
      this.orch.log(session, 'ue_event', { event: e?.event, state_rev: e?.state_rev });
      // QA-017: UE's capture_progress must not announce a photo a second time
      const rid = e?.data?.renderId;
      if (e?.event === 'capture_progress' && rid && !session.announcedRenders.has(rid)) {
        session.announcedRenders.add(rid);
        socket.emit('ai.render', { renderId: rid, stage: 'capturing' });
      }
      // v2.0: planner_mode (HUD entry/exit) and booth_focus
      if (e?.event === 'planner_mode' || e?.event === 'booth_focus') void this.orch.onUeEvent(session, e);
    });
    // v2.1 CR-WEB-04: «Показать в комнате» on a salon info card
    socket.on('ai.card.show', (p) => {
      if (!session) return;
      void this.orch.handleCardShow(session, String(p.cardId));
    });
    // v2.0: a button under a consultant message
    socket.on('ai.offer.answer', (p) => {
      if (!session) return;
      void this.orch.handleOfferAnswer(session, String(p.offerId), String(p.optionId));
    });
    socket.on('ai.render.request', (p) => {
      if (!session) return;
      const s = session;
      void this.uiTool(s, 'take_photo', { preset: p?.preset });
    });
    socket.on('ai.dossier.request', (p) => {
      if (!session) return;
      void this.uiTool(session, 'save_project', { projectName: p?.projectName });
    });
    socket.on('ai.reset', () => {
      if (session) void this.orch.reset(session);
    });
    socket.on('disconnect', () => {
      if (session) {
        const ch = this.channels.get(session.sessionId);
        ch?.cancelAll();
        this.connected.get(session.sessionId)?.delete(socket.id);
        this.touch(session.sessionId); // the idle clock starts at the disconnect
      }
    });

    if (auth.instanceUuid && auth.username) start(START_FROM_AUTH);
  }

  /** v2.5 ai.session.ready: the session's language and the greeting in it (contract v2.5 §2). */
  private readyPayload(s: AiSession, sessionId: string) {
    return { sessionId, lang: s.lang, consultantName: consultantName(s.lang), greeting: greetingFor(s.lang, 'showroom'), catalogSyncedAt: this.orch.catalog?.syncedAt ?? '', mock: this.opts.mockFlags() };
  }

  /** Page buttons (photo / dossier): QA-050 — a PLANNER_BUSY hold is answered by the consultant, never by a failed card. */
  private async uiTool(s: AiSession, name: string, input: any) {
    const turnId = `ui-${Date.now()}-${++uiSeq}`; // unique per press: each press gets its own answer
    const out = await this.orch.runTool(s, name, input, 'ui', turnId);
    // v2.2 P3-02: the salon photo button without a booth nearby (NO_BOOTH) is answered too, with the Constructor offer.
    if (['PLANNER_BUSY', 'NOT_IN_PLANNER', 'NO_BOOTH'].includes(out?.reasonCode) && out.say) await this.orch.sayUiOutcome(s, out.say, turnId);
  }

  /** A guest session on this instance that a named start may adopt (only when it is the only guest there). */
  private soleGuestOn(instanceUuid: string, username: string): AiSession | null {
    if (isGuest(username)) return null;
    const guests = [...this.sessions.values()].filter((x) => x.instanceUuid === instanceUuid && isGuest(x.username));
    return guests.length === 1 ? guests[0] : null;
  }

  sessionFor(sessionId: string) {
    return this.sessions.get(sessionId);
  }
}
