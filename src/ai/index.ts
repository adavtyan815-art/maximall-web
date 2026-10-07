import express from 'express';
import fs from 'fs';
import type { Server as SocketServer } from 'socket.io';
import { CatalogIndex } from './catalog/index';
import { createProviders, Providers } from './providers';
import { SimliAvatarService } from './avatar/simli';
import { ClipStore } from './providers/voice';
import { AiSession, Orchestrator } from './orchestrator/orchestrator';
import { AiSocketNamespace } from './socket';
import { DirectChannel } from './orchestrator/channel';
import { FakeUe } from './sim/fakeUe';
import multer from 'multer';
import { checkMeta, RENDER_FAILED_RU, RENDER_GIVEUP_RU, RenderEvent, RenderService } from './render/service';
import { normalizeLang, t } from './i18n';
import { MockRender } from './render/providers';
import { styleFromPreference } from './render/prompts';
import { DossierError, DossierService } from './dossier/service';
import { buildReport, reportMarkdown } from './analytics/report';
import { spendPageHtml } from './analytics/spendPage';
import path from 'path';
import sharp from 'sharp';
import { RateLimiter, clientIp, envInt } from './util/rateLimit';
import { RetentionResult, retentionAgesFromEnv, runRetention } from './util/retention';

export interface AiModule {
  router: express.Router;
  render: RenderService;
  dossier: DossierService;
  orchestrator: Orchestrator;
  providers: Providers;
  /** v2.3: Simli avatar session tokens */
  avatar: SimliAvatarService;
  attach(io: SocketServer): AiSocketNamespace;
  namespace?: AiSocketNamespace;
  /** GET /api/ai/health payload (enabled:true; booleans and totals only, never key values). */
  health(): Record<string, unknown>;
  /** QA-058: retention of runtime data (renders, clips, dossier files, logs, AR); on start and every hour. */
  runRetention(): RetentionResult[];
  startRetention(): (() => void) | null;
}

/** Public base URL for clip/render links that UE and the page download (PUBLIC_BASE_URL, else http://localhost:PORT). */
/** Security review: the largest capture we accept (8K is 33 MP); sharp would otherwise decode up to 268 MP. */
const MAX_RENDER_PIXELS = 36_000_000;

/** A real PNG whose decoded size equals the declared capture size; null when fine. */
async function pngProblem(buf: Buffer, w: number, h: number): Promise<string | null> {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return 'not a PNG';
  try {
    const m = await sharp(buf, { limitInputPixels: MAX_RENDER_PIXELS }).metadata();
    if (m.format !== 'png') return 'not a PNG';
    if (m.width !== w || m.height !== h) return `size ${m.width}x${m.height} does not match meta ${w}x${h}`;
    return null;
  } catch {
    return 'unreadable PNG';
  }
}

export function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
}

export function createAiModule(opts: { providers?: Providers; catalog?: CatalogIndex | null; logDir?: string; clips?: ClipStore; renderDir?: string; savesDir?: string; dossierDir?: string; arDir?: string; verifyHostToken?: (instanceUuid: string, hostToken: string) => boolean; avatar?: SimliAvatarService } = {}): AiModule {
  const providers = opts.providers ?? createProviders();
  const catalog = opts.catalog !== undefined ? opts.catalog : CatalogIndex.tryLoad();
  const clips = opts.clips ?? new ClipStore();
  const orchestrator = new Orchestrator({
    catalog,
    llm: providers.llm,
    fallbackLlm: providers.fallbackLlm,
    stt: providers.stt,
    tts: providers.tts,
    clips,
    publicBaseUrl,
    logDir: opts.logDir,
    llmTimeoutMs: Number(process.env.AI_LLM_TIMEOUT_MS ?? 12000),
  });
  const router = express.Router();
  const devSessions = new Map<string, { s: AiSession; events: { event: string; payload: any }[] }>();
  const emitRender = (sessionId: string, ev: RenderEvent) => {
    const s = mod.namespace?.sessionFor(sessionId) ?? devSessions.get(sessionId)?.s;
    if (!s) return;
    if (ev.stage === 'final' && !s.renders.includes(ev.renderId)) s.renders.push(ev.renderId);
    orchestrator.log(s, 'render', ev);
    // v2.5: the render service's own failure lines in the session language (Russian unchanged)
    if (s.lang !== 'ru' && ev.stage === 'failed' && (ev.reason === RENDER_GIVEUP_RU || ev.reason === RENDER_FAILED_RU)) ev = { ...ev, reason: t(s.lang, ev.reason === RENDER_GIVEUP_RU ? 'render.giveUp' : 'render.failed') };
    s.io.emit('ai.render', ev);
  };
  const render = new RenderService(providers.render ?? new MockRender(), providers.renderFallback ?? null, emitRender, opts.renderDir, publicBaseUrl);
  const dossier = new DossierService(() => orchestrator.catalog, opts.savesDir ?? path.join(process.cwd(), 'src', 'data', 'saves'), render.dir, publicBaseUrl, opts.dossierDir);
  // save_project -> dossier (task 7): built after UE confirms the save; the page gets ai.dossier building -> ready.
  orchestrator.setOnSaveProject(async (s, saveId, saveUsername) => {
    try {
      // QA-035: the save lives under the login UE used (save_project result.username), not the page/session name.
      const placements = await orchestrator.placements(s).catch(() => ({}));
      const { response } = await dossier.build({ sessionId: s.sessionId, username: saveUsername || s.username, saveId, renderIds: s.renders, conversationNotes: orchestrator.conversationNotes(s), placements, lang: s.lang });
      orchestrator.log(s, 'dossier', response);
      s.io.emit('ai.dossier', { ...response, stage: 'ready' });
    } catch (e: any) {
      orchestrator.log(s, 'dossier_error', { message: e.message });
      s.io.emit('ai.dossier', { stage: 'failed' });
    }
  });
  // QA-058: only these folders, only files older than the configured ages; leads, ledger, index files, catalog and saves never.
  const logDirForRetention = opts.logDir ?? path.join(process.cwd(), 'data', 'ai_logs');
  const arDirForRetention = opts.arDir ?? path.join(process.cwd(), 'data', 'ar');
  const retentionTargets = () => {
    const a = retentionAgesFromEnv();
    return [
      { name: 'renders', dir: render.dir, maxAgeDays: a.renders },
      { name: 'clips', dir: clips.dir, maxAgeDays: a.clips },
      { name: 'dossiers', dir: dossier.dir, maxAgeDays: a.dossiers },
      { name: 'logs', dir: logDirForRetention, maxAgeDays: a.logs },
      { name: 'ar', dir: arDirForRetention, maxAgeDays: a.ar },
    ];
  };
  const avatar = opts.avatar ?? new SimliAvatarService({ ledger: providers.ledger });
  const mod: AiModule = {
    health: () => ({ ok: true, enabled: true }),
    router,
    render,
    dossier,
    orchestrator,
    providers,
    avatar,
    runRetention() {
      const targets = retentionTargets();
      return runRetention(targets, { allowedRoots: targets.map((t) => t.dir), dryRun: process.env.AI_RETENTION_DRY_RUN === '1' });
    },
    startRetention() {
      // Production default: on. LOCAL_MODE default: off (local data/ holds QA evidence) unless AI_RETENTION_ENABLED=1.
      const enabled = process.env.AI_RETENTION_ENABLED !== undefined ? process.env.AI_RETENTION_ENABLED === '1' : process.env.LOCAL_MODE !== '1';
      if (!enabled) {
        console.log('[Retention] off (LOCAL_MODE default; set AI_RETENTION_ENABLED=1 to enable)');
        return null;
      }
      const tick = () => {
        try {
          mod.runRetention();
        } catch (e: any) {
          console.error('[Retention] failed:', e?.message);
        }
      };
      tick();
      const h = setInterval(tick, envInt('AI_RETENTION_INTERVAL_MIN', 60) * 60_000);
      h.unref();
      return () => clearInterval(h);
    },
    attach(io: SocketServer) {
      mod.namespace = new AiSocketNamespace(io, orchestrator, { mockFlags: () => providers.mock, sttStream: providers.sttStream, verifyHostToken: opts.verifyHostToken });
      return mod.namespace;
    },
  };

  router.get('/api/ai/clips/:clip', (req, res) => {
    const f = clips.path(String(req.params.clip));
    if (!f) return res.status(404).json({ error: 'clip not found' });
    // v2.0: WAV / MP3 for the browser (ai.say.audioUrl); legacy raw PCM still served.
    const ext = path.extname(f).slice(1);
    res.setHeader('Content-Type', ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream');
    if (ext === 'pcm') res.setHeader('X-Audio-Format', 'pcm_s16le;rate=24000;channels=1');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(f).pipe(res);
  });

  mod.health = () => ({
    ok: true,
    enabled: true,
    mock: providers.mock,
    keysPresent: providers.keys, // booleans only
    llmModel: providers.llm.model,
    catalog: orchestrator.catalog ? { syncedAt: orchestrator.catalog.syncedAt, products: orchestrator.catalog.listProducts().length, mappings: orchestrator.catalog.data.mappings.length } : null,
    spendUsd: providers.ledger.totalUsd(),
    budgetUsd: providers.ledger.capUsd,
    localMode: process.env.LOCAL_MODE === '1',
    avatar: avatar.mode, // v2.3: 'simli' | 'none'
    sessions: mod.namespace?.sessions.size ?? 0,
  });
  // Integration (AI_ENABLED): app.ts answers /api/ai/health first (with its own CORS); this route serves module-only apps (tests).
  router.get('/api/ai/health', (_req, res) => res.json(mod.health()));

  // v2.3: Simli avatar session token for the page (the key stays here). Body {sessionId} of a live /ai session.
  // Always answers {provider:"simli", …} or {provider:"none", reason}; the page falls back to the 2D avatar on "none".
  const avatarPerIp = new RateLimiter(envInt('AI_AVATAR_TOKENS_PER_IP_10MIN', 30), 10 * 60_000);
  router.post('/api/ai/avatar/session', express.json({ limit: '4kb' }), async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '').slice(0, 200);
    const s = sessionId ? mod.namespace?.sessionFor(sessionId) ?? devSessions.get(sessionId)?.s : undefined;
    if (!s) return res.status(404).json({ provider: 'none', reason: 'unknown_session' });
    if (avatar.mode === 'simli' && !avatarPerIp.take(clientIp(req))) return res.status(429).json({ provider: 'none', reason: 'rate_limited' });
    const out = await avatar.createSession(sessionId);
    orchestrator.log(s, 'avatar_session', out.provider === 'simli' ? { provider: 'simli', faceId: out.faceId, maxSessionLength: out.maxSessionLength, maxIdleTime: out.maxIdleTime } : out);
    res.json(out);
  });

  // Cost dashboard (task 10, minimal): totals per provider and per session from the spend ledger.
  // Public: totals only (no session ids / logins). QA-020.
  router.get('/api/ai/spend', (_req, res) => {
    const entries = providers.ledger.entries();
    const byProvider: Record<string, number> = {};
    for (const e of entries.filter((x) => x.status !== 'reserved')) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + (e.actualUsd ?? e.estUsd);
    res.json({ totalUsd: providers.ledger.totalUsd(), capUsd: providers.ledger.capUsd, byProvider, calls: entries.length });
  });

  // Cost dashboard page (task 10), Russian.
  // Admin only (QA-020): the page lists session ids = visitor logins.
  router.get('/api/admin/ai/spend.html', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(spendPageHtml(providers.ledger.entries(), providers.ledger.totalUsd(), providers.ledger.capUsd, providers.ledger.perSessionCapUsd, providers.mock));
  });

  // Post-Expo report (task 9) — under /api/admin, so the existing admin login protects it.
  const logDir = opts.logDir ?? path.join(process.cwd(), 'data', 'ai_logs');
  const report = () => buildReport(logDir, { leadsFile: path.join(dossier.dir, 'leads.jsonl'), exclude: /^(harness|dev|test):/ });
  router.get('/api/admin/ai/report.json', (_req, res) => res.json(report()));
  router.get('/api/admin/ai/report.md', (_req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(reportMarkdown(report()));
  });

  // Analytics (task 9, minimal): per-session counters.
  // CR-WEB-03: staff co-pilot view (admin only): transcript + basket/spec + total; optional «Написать от имени консультанта».
  router.get('/api/admin/ai/session/:sessionId', (req, res) => {
    const s = mod.namespace?.sessionFor(String(req.params.sessionId));
    if (!s) return res.status(404).json({ error: 'session not found' });
    const basket = orchestrator.basket(s);
    res.json({ sessionId: s.sessionId, username: s.username, transcript: s.transcript.slice(-200), basket, total: basket.total, currency: 'BYN', prefs: s.prefs, stats: s.stats, lastSaveId: s.lastSaveId ?? null });
  });
  router.post('/api/admin/ai/session/:sessionId/say', express.json(), async (req, res) => {
    const s = mod.namespace?.sessionFor(String(req.params.sessionId));
    if (!s) return res.status(404).json({ error: 'session not found' });
    const text = String(req.body?.text ?? '').trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: 'text required' });
    await orchestrator.staffSay(s, text);
    res.json({ ok: true });
  });

  // Admin only (QA-020): per-session ids = visitor logins.
  router.get('/api/admin/ai/stats', (_req, res) => {
    const sessions = [...(mod.namespace?.sessions.values() ?? [])].map((s) => ({ sessionId: s.sessionId, ...s.stats, sets: s.sets.size }));
    res.json({ sessions });
  });

  // ── Render (task 6): POST /api/render multipart {beauty, depth, mask, [maskDepth], meta} -> 202 {renderId, status}
  // Security review: live session only, one upload per renderId (no overwrite), PNG parts whose real size = meta size,
  // per-session and per-address limits (a render may be a paid provider call).
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 5, fields: 8, fieldSize: 64 * 1024 } });
  const renderPerSession = new RateLimiter(envInt('AI_RENDER_MAX_PER_SESSION_10MIN', 12), 10 * 60_000);
  const renderPerIp = new RateLimiter(envInt('AI_RENDER_MAX_PER_IP_10MIN', 60), 10 * 60_000);
  const renderParts = [{ name: 'beauty', maxCount: 1 }, { name: 'depth', maxCount: 1 }, { name: 'mask', maxCount: 1 }, { name: 'maskDepth', maxCount: 1 }, { name: 'meta', maxCount: 1 }];
  router.post('/api/render', upload.fields(renderParts), async (req, res) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    let meta: any;
    try {
      const raw = files.meta?.[0]?.buffer?.toString('utf8') ?? (req.body?.meta as string);
      meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return res.status(400).json({ error: 'meta is not valid JSON' });
    }
    const bad = checkMeta(meta);
    if (bad) return res.status(400).json({ error: bad });
    for (const k of ['beauty', 'depth', 'mask']) if (!files[k]?.[0]) return res.status(400).json({ error: `missing part ${k}` });
    const owner = mod.namespace?.sessionFor(meta.sessionId) ?? devSessions.get(meta.sessionId)?.s;
    if (!owner) return res.status(404).json({ error: 'unknown session' });
    // QA-051: only a renderId this session's own capture command issued, still pending (TTL), single use.
    const pendingUntil = owner.pendingRenders.get(meta.renderId);
    if (!pendingUntil || pendingUntil < Date.now()) {
      owner.pendingRenders.delete(meta.renderId);
      return res.status(403).json({ error: 'renderId was not issued for this session or has expired' });
    }
    if (fs.existsSync(path.join(render.dir, meta.renderId))) return res.status(409).json({ error: 'renderId already used' });
    if (meta.width * meta.height > MAX_RENDER_PIXELS) return res.status(400).json({ error: 'image too large' });
    for (const k of ['beauty', 'depth', 'mask', 'maskDepth']) {
      const buf = files[k]?.[0]?.buffer;
      if (!buf) continue;
      const bad = await pngProblem(buf, meta.width, meta.height);
      if (bad) return res.status(400).json({ error: `${k}: ${bad}` });
    }
    if (!renderPerSession.take(meta.sessionId) || !renderPerIp.take(clientIp(req))) return res.status(429).json({ error: 'too many renders, try later' });
    if (!owner.pendingRenders.delete(meta.renderId)) return res.status(403).json({ error: 'renderId already used' }); // consumed by a concurrent upload
    if (!meta.style) {
      const sess = mod.namespace?.sessionFor(meta.sessionId) ?? devSessions.get(meta.sessionId)?.s;
      meta.style = styleFromPreference(sess?.prefs.style, meta.finishes ?? sess?.finishes.map((x) => x.finish));
    }
    if (meta.hasWindow === undefined) meta.hasWindow = (mod.namespace?.sessionFor(meta.sessionId) ?? devSessions.get(meta.sessionId)?.s)?.roomHasWindow ?? false;
    const announcedBy = mod.namespace?.sessionFor(meta.sessionId) ?? devSessions.get(meta.sessionId)?.s;
    if (!announcedBy?.announcedRenders.has(meta.renderId)) {
      announcedBy?.announcedRenders.add(meta.renderId);
      emitRender(meta.sessionId, { renderId: meta.renderId, stage: 'capturing' });
    }
    void render.accept(meta, { beauty: files.beauty[0].buffer, depth: files.depth[0].buffer, mask: files.mask[0].buffer, maskDepth: files.maskDepth?.[0]?.buffer });
    res.status(202).json({ renderId: meta.renderId, status: 'accepted' });
  });
  router.get('/api/render/:renderId/:file', (req, res) => {
    const f = render.filePath(String(req.params.renderId), String(req.params.file).replace(/.png$/, ''));
    if (!f) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(f).pipe(res);
  });

  // X3 AR upload: intentionally not mounted here. Production keeps the live /api/ar/upload in app.ts
  // (public/ar/viewer.html), which the UE client (UARExportSubsystem) already uses; nothing in the AI layer needs it.

  // ── Dossier (task 7): POST /api/dossier {sessionId, username?, saveId?, renderIds?} -> {dossierId, pdfUrl, shortUrl, qrPngUrl}
  // Security review: a live session only (outside LOCAL_MODE), its own login only, rate-limited (Chrome PDF is heavy; each build may write a lead).
  const dossierPerSession = new RateLimiter(envInt('AI_DOSSIER_MAX_PER_SESSION_10MIN', 5), 10 * 60_000);
  const dossierPerIp = new RateLimiter(envInt('AI_DOSSIER_MAX_PER_IP_10MIN', 30), 10 * 60_000);
  router.post('/api/dossier', express.json(), async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.sessionId !== 'string' || !b.sessionId) return res.status(400).json({ error: 'sessionId required' });
    const session = mod.namespace?.sessionFor(b.sessionId);
    const local = process.env.LOCAL_MODE === '1';
    if (!session && !local) return res.status(404).json({ error: 'unknown session' });
    if (session && b.username !== undefined && !local && ![session.lastSaveUsername, session.username].includes(String(b.username))) return res.status(403).json({ error: 'username does not belong to this session' });
    if (!dossierPerSession.take(b.sessionId) || !dossierPerIp.take(clientIp(req))) return res.status(429).json({ error: 'too many requests, try later' });
    const username = String(b.username ?? session?.lastSaveUsername ?? session?.username ?? b.sessionId.split(':').slice(1).join(':'));
    const renderIds: string[] = Array.isArray(b.renderIds) ? b.renderIds.map(String) : session?.renders ?? [];
    try {
      const placements = session ? await orchestrator.placements(session).catch(() => ({})) : undefined;
      const { response } = await dossier.build({ sessionId: b.sessionId, username, saveId: b.saveId ?? session?.lastSaveId, renderIds, conversationNotes: session ? orchestrator.conversationNotes(session) : [], placements, lang: session?.lang });
      session?.io.emit('ai.dossier', { ...response, stage: 'ready' });
      res.json(response);
    } catch (e: any) {
      res.status(e instanceof DossierError ? e.status : 500).json({ error: e.message });
    }
  });
  router.get('/api/dossier/:file', (req, res) => {
    const id = String(req.params.file).replace(/\.pdf$/, '');
    const f = dossier.pdfPath(id);
    if (!f && dossier.isExpired(id)) return res.status(410).type('html').send(dossier.expiredPage(dossier.langOf(id))); // QA-058
    if (!f) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="oliveeka-proekt.pdf"');
    fs.createReadStream(f).pipe(res);
  });
  router.get('/api/dossier/:id/qr.png', (req, res) => {
    const f = dossier.qrPath(String(req.params.id));
    if (!f) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(f).pipe(res);
  });
  // QA-060: «Записаться на визит в салон» on the short page -> visit request on the existing lead (consent required).
  const visitPerIp = new RateLimiter(envInt('AI_VISIT_MAX_PER_IP_10MIN', 10), 10 * 60_000);
  router.post('/d/:shortId/visit', express.json({ limit: '2kb' }), (req, res) => {
    const vLang = dossier.langOf(String(req.params.shortId));
    if (!visitPerIp.take(clientIp(req))) return res.status(429).json({ ok: false, code: 'RATE_LIMITED', message: t(vLang, 'visit.rateLimited') });
    const r = dossier.requestVisit(String(req.params.shortId), req.body?.consent);
    if (!r.ok) return res.status(r.status).json(r);
    res.json({ ok: true, already: r.already, message: t(vLang, 'page.visitDone') });
  });
  router.get('/d/:shortId', (req, res) => {
    const html = dossier.shortPage(String(req.params.shortId));
    if (!html && dossier.isExpired(String(req.params.shortId))) return res.status(410).type('html').send(dossier.expiredPage(dossier.langOf(String(req.params.shortId)))); // QA-058
    if (!html) return res.status(404).send(t('ru', 'page.notFound'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); // the short id is a capability; do not leak it to linked sites
    res.send(html);
  });

  // LOCAL_MODE only: drive a turn against the in-process UE simulator (QA without a page / UE).
  if (process.env.LOCAL_MODE === '1') {
    router.post('/api/ai/dev/turn', express.json(), async (req, res) => {
      const sessionId = String(req.body?.sessionId ?? 'dev:qa');
      const text = String(req.body?.text ?? '');
      if (!orchestrator.catalog) return res.status(503).json({ error: 'catalog index not built' });
      let d = devSessions.get(sessionId);
      if (!d) {
        const events: { event: string; payload: any }[] = [];
        // v2.0: dev sessions start in the constructor (QA room probes) unless mode:'showroom' is asked for
        const s = new AiSession(sessionId, 'dev', 'qa', new DirectChannel(new FakeUe(orchestrator.catalog, { inPlanner: req.body?.mode !== 'showroom' })), { emit: (event, payload) => events.push({ event, payload }) }, req.body?.mode === 'showroom' ? 'showroom' : 'constructor');
        if (typeof req.body?.lang === 'string') s.lang = normalizeLang(req.body.lang); // v2.5
        d = { s, events };
        devSessions.set(sessionId, d);
      }
      const from = d.events.length;
      await orchestrator.handleTurn(d.s, text, 'text');
      res.json({ events: d.events.slice(from), basket: orchestrator.basket(d.s) });
    });
  }
  return mod;
}
