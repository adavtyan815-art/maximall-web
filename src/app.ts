import express from 'express';
import http from 'http';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto'; // before SESSION_SECRET below (CommonJS output keeps import order)
import { config } from './config';
import type { WebSocketService } from './services/websocketService';

// WebSocket service is injected after server creation (see server.ts)
let wsService: WebSocketService | null = null;
export function setWsService(ws: WebSocketService) { wsService = ws; }

// Import services (pure in-memory — no MongoDB)
import { DatabaseService } from './services/databaseService';
import { SettingsService } from './services/settingsService';
import { adminAuthMode, safeEqual, verifyAdminLogin } from './services/adminAuth';
import { adminOriginGuard } from './services/adminOrigin';
import { RateLimiter, clientIp, envInt } from './ai/util/rateLimit';
import type { AiModule } from './ai';

const app = express();
app.disable('x-powered-by');

// Security review: never sign admin sessions with the public default secret ('secret' in config when SESSION_SECRET is unset).
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[Auth] SESSION_SECRET is not set: using a random per-process secret (admin sessions end on restart). Set it in .env.');
  return crypto.randomBytes(32).toString('hex');
})();

/**
 * AI consultant on/off (default off). Without AI_ENABLED=1|true the AI layer is not even loaded: no catalog, no AI dirs,
 * no /ai Socket.io namespace, no AI routes — the server behaves like the pre-AI orchestrator. Only GET /api/ai/health
 * always answers, so the player page can tell whether to show the consultant ({ok:true, enabled:false} here).
 */
export function aiEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.AI_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}
export const AI_ENABLED = aiEnabledFromEnv();

const NGROK_ORIGIN = 'https://hooly-superblessed-shan.ngrok-free.dev';

// AI health probe: fetched by the player page (cross-origin in local tests), so it has its own CORS — reflect the
// Origin, GET only, no credentials. Mounted before the app-wide cors() so that one (credentials: true) does not apply.
const aiHealthCors = (req: express.Request, res: express.Response) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', String(origin));
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store');
};
app.options('/api/ai/health', (req, res) => {
  aiHealthCors(req, res);
  res.status(204).end();
});
app.get('/api/ai/health', (req, res) => {
  aiHealthCors(req, res);
  if (!aiModule) return res.json({ ok: true, enabled: false });
  const h = aiModule.health();
  // Public endpoint: in production only what the player needs; spend, budget, key presence and session counts stay
  // for LOCAL_MODE / AI_HEALTH_VERBOSE=1 (the admin AI pages show them behind the login).
  const verbose = process.env.LOCAL_MODE === '1' || process.env.AI_HEALTH_VERBOSE === '1';
  res.json(verbose ? h : { ok: h.ok, enabled: h.enabled, avatar: h.avatar });
});

// Middleware
// Admin CSRF hardening: /api/admin/* with a foreign Origin -> 403 before cors() can add allow headers.
app.use(adminOriginGuard());
app.use(cors({
  origin: (origin, callback) => {
    // Allow ngrok domain, localhost variants, and the EC2 instances (any IP)
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'ngrok-skip-browser-warning'],
}));
app.options('*', cors());    // Pre-flight for all routes
app.use(express.json({ limit: '25mb' })); // save records carry a thumbnail + metrics (save_project)
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Only the admin login uses this session. Strict + httpOnly; Secure whenever the request arrived over https
  // (nginx terminates TLS and sets X-Forwarded-Proto; `proxy: true` trusts it for this cookie only, not app-wide).
  proxy: true,
  cookie: { sameSite: 'strict', httpOnly: true, secure: 'auto' },
}));

import { EC2Service } from './services/ec2Service';
import { TimeTrackerService } from './services/timeTrackerService';
import { ScalingService } from './services/scalingService';

// Authentication Middleware
app.use((req, res, next) => {
  // Express routing is case-insensitive: /API/Admin/... reaches the admin handlers, so the check must be too.
  const p = req.path.toLowerCase();
  if (p === '/admin.html' || p.startsWith('/api/admin') || p.startsWith('/api/debug')) {
    if (p === '/api/admin/login' || p === '/api/admin/logout') {
      return next();
    }
    if (!(req.session as any).isAdmin) {
      if (p === '/admin.html') {
        return res.redirect('/login.html');
      } else {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
  }
  next();
});

// ── Instance HTTP Reverse Proxy ───────────────────────────────────────────
// Redirects base UUID requests to the main player page
app.get('/instance/:uuid', (req, res) => {
  const query = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query as any).toString() : '';
  res.redirect(`/instance/${req.params.uuid}/player.html${query}`);
});

// Wildcard proxy route to fetch player assets directly from the EC2 instance's port 80
app.all('/instance/:uuid/*', (req, res) => {
  const uuid = req.params.uuid;
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(uuid);

  if (!inst) {
    return res.status(404).send('Instance not found in database');
  }

  if (inst.status !== 'running') {
    return res.status(503).send(`Instance is currently: ${inst.status}. Please wait for it to boot.`);
  }

  const ip = inst.privateIp || inst.publicIp;
  if (!ip) {
    return res.status(503).send('Instance network address is not yet available. Please reload in a moment.');
  }

  const targetPath = (req.params as any)[0];
  const query = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query as any).toString() : '';

  // Copy and normalize incoming headers
  const headers = { ...req.headers };
  headers.host = ip; // Set target host
  // Security review: the backend's own cookies (the admin session) never go to the pool instance.
  delete headers.cookie;
  delete headers.authorization;

  if (targetPath.endsWith('player.html') || targetPath.endsWith('player.js')) {
    console.log(`[HTTP-Proxy] [${uuid}] Serving ${targetPath} -> http://${ip}:8000/${targetPath}`);
  }

  const proxyReq = http.request({
    host: ip,
    port: 8000,
    path: `/${targetPath}${query}`,
    method: req.method,
    headers: headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[HTTP-Proxy] Failed proxying request for ${uuid} to ${ip}:`, err.message);
    res.status(502).send('Error connecting to the dynamic 3D server. Please reload the page.');
  });

  req.pipe(proxyReq);
});

// Setup static files
app.use(express.static(path.join(__dirname, '../public')));

const ec2Service = new EC2Service();

// ── Admin: list all instances ─────────────────────────────────────────────────
app.get('/api/admin/instances', (req, res) => {
  const db = DatabaseService.getInstance();
  const instances = db.getInstances();
  const graceList = TimeTrackerService.getInstance().getInstancesInGrace();
  
  const enriched: Record<string, any> = {};
  for (const [uuid, inst] of Object.entries(instances)) {
    enriched[uuid] = {
      ...inst,
      activeSessions: Object.fromEntries(inst.activeSessions),
      inGracePeriod: graceList.includes(uuid)
    };
  }
  res.json(enriched);
});

// ── Admin: dashboard summary (categorized by pool role) ───────────────────────
app.get('/api/admin/dashboard', async (req, res) => {
  const db = DatabaseService.getInstance();
  const scaling = ScalingService.getInstance();
  const timeTracker = TimeTrackerService.getInstance();
  const instances = db.getInstances();
  const graceList = timeTracker.getInstancesInGrace();
  const prewarmPhases = scaling.getPrewarmPhases();

  const activeSessions: any[] = [];
  const bufferReady:    any[] = [];
  const prewarm:        any[] = [];

  let totalTimeSeconds = db.getArchivedSeconds();

  for (const [uuid, inst] of Object.entries(instances)) {
    // Dynamic audit for pending/stopping states to avoid UI getting stuck on "pending"
    if (inst.status === 'pending' || inst.status === 'stopping') {
      try {
        const awsStatus = await ec2Service.getInstanceStatus(inst.instanceId);
        let updated = false;
        if (inst.status === 'stopping' && (awsStatus.state === 'stopped' || awsStatus.state === 'terminated')) {
          inst.status = 'stopped';
          updated = true;
        } else if (inst.status === 'pending' && awsStatus.state === 'running') {
          inst.status = 'running';
          updated = true;
          // Start the session timer if this is a claimed active user session
          if (inst.assignedTo !== 'Buffer' && inst.assignedTo !== 'Prewarm') {
            timeTracker.startRealTimer(uuid);
          }
        } else if (inst.status === 'pending' && awsStatus.state === 'stopped') {
          inst.status = 'stopped';
          updated = true;
        }
        if (updated) {
          await db.saveInstance(uuid, inst);
        }
      } catch (err: any) {
        console.warn(`[Dashboard Audit] Failed to fetch state for instance ${inst.instanceId}:`, err.message);
      }
    }

    const base = {
      uuid,
      instanceId:  inst.instanceId,
      status:      inst.status,
      assignedTo:  inst.assignedTo,
      pinggyUrl:   inst.pinggyUrl || null,
      createdAt:   inst.createdAt,
      inGracePeriod: graceList.includes(uuid),
      realTimeUsedSeconds: inst.realTimeUsedSeconds || 0,
    };

    // Accumulate running time of ALL instances (active, prewarm, buffer)
    totalTimeSeconds += base.realTimeUsedSeconds;

    if (inst.assignedTo === 'Buffer') {
      bufferReady.push(base);
    } else if (inst.assignedTo === 'Prewarm' || prewarmPhases.has(uuid)) {
      prewarm.push({
        ...base,
        phase: prewarmPhases.get(uuid) ?? 1,
      });
    } else {
      // Real client session
      activeSessions.push(base);
    }
  }

  const settings = SettingsService.getInstance().getSettings();
  const hourlyRate = settings.serverHourlyRate ?? 0.94;
  const minBufferTarget = settings.minBufferTarget ?? 3;
  const totalCost = (totalTimeSeconds / 3600) * hourlyRate;

  res.json({
    activeSessions,
    bufferReady,
    prewarm,
    stats: {
      activeSessions: activeSessions.length,
      bufferReady:    bufferReady.length,
      prewarm:        prewarm.length,
      gracePeriod:    graceList.length,
      totalTimeSeconds,
      totalCost,
      serverHourlyRate: hourlyRate,
      minBufferTarget,
    },
    // EC2 launch status for the admin banner (2026-10-06: g6.xlarge capacity errors were invisible in the UI)
    launch: {
      instanceTypes: EC2Service.instanceTypeCandidates(config.DEFAULT_INSTANCE_TYPE),
      last: EC2Service.lastLaunch,
      lastError: EC2Service.lastLaunchError,
    },
  });
});

// ── Admin: get / save settings ────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(SettingsService.getInstance().getSettings());
});

app.put('/api/admin/settings', async (req, res) => {
  const settings = SettingsService.getInstance();
  await settings.save(req.body);
  res.json({ success: true, settings: settings.getSettings() });
});

// ── Admin: create instance ────────────────────────────────────────────────
app.post('/api/admin/instances', async (req, res) => {
  const db = DatabaseService.getInstance();
  const uuid = crypto.randomUUID();
  await db.saveInstance(uuid, {
    uuid,
    instanceId: req.body.explicitInstanceId || ('i-mock' + Math.floor(Math.random() * 10000)),
    displayLimitHours: 0,    // Not used anymore — no quota tracking
    realLimitHours: 0,
    displayTimeUsedSeconds: 0,
    realTimeUsedSeconds: 0,
    status: 'stopped',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    assignedTo: req.body.assignedTo || 'Unassigned',
    ec2Config: {
      instanceType: req.body.instanceType || config.DEFAULT_INSTANCE_TYPE,
      region: 'us-east-2',
      amiId: 'ami-123',
      securityGroupId: 'sg-123',
      subnetId: 'sub-123'
    },
    activeSessions: new Map()
  });
  res.json({ success: true, uuid });
});

// ── Admin: start instance ────────────────────────────────────────────────
app.post('/api/admin/instances/:uuid/start', async (req, res) => {
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (inst && inst.instanceId) {
    try {
      await ec2Service.startInstance(inst.instanceId);
      inst.status = 'pending';
      await db.saveInstance(req.params.uuid, inst);
      res.json({ success: true, status: inst.status });
    } catch (e: any) {
      console.error('AWS Start Failed', e);
      res.status(500).json({ success: false, error: e.message || 'AWS Start Failed' });
    }
  } else {
    res.status(404).json({ success: false, error: 'Instance Not Found' });
  }
});

// ── Admin: stop instance ─────────────────────────────────────────────────
app.post('/api/admin/instances/:uuid/stop', async (req, res) => {
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (inst && inst.instanceId) {
    try {
      await ec2Service.stopInstance(inst.instanceId);
      inst.status = 'stopping';
      await db.saveInstance(req.params.uuid, inst);
      res.json({ success: true, status: inst.status });

      // Start AWS Stop Polling
      const pollInterval = setInterval(async () => {
        const currentInst = db.getInstance(req.params.uuid);
        if (!currentInst || currentInst.status !== 'stopping') {
          clearInterval(pollInterval);
          return;
        }
        try {
          const awsStatus = await ec2Service.getInstanceStatus(currentInst.instanceId);
          if (awsStatus.state === 'stopped' || awsStatus.state === 'terminated') {
            currentInst.status = 'stopped';
            TimeTrackerService.getInstance().stopRealTimer(req.params.uuid);
            await db.saveInstance(req.params.uuid, currentInst);
            clearInterval(pollInterval);
          }
        } catch (e: any) {
          console.error('[Admin API] AWS stop poll error:', e.message);
        }
      }, 5000);
      
    } catch (e: any) {
      console.error('AWS Stop Failed', e);
      res.status(500).json({ success: false, error: e.message || 'AWS Stop Failed' });
    }
  } else {
    res.status(404).json({ success: false, error: 'Instance Not Found' });
  }
});

// ── Admin: reset time (single) ───────────────────────────────────────────
app.post('/api/admin/instances/:uuid/reset-time', async (req, res) => {
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (!inst) return res.status(404).json({ error: 'Instance Not Found' });
  
  inst.realTimeUsedSeconds = 0;
  await db.saveInstance(req.params.uuid, inst);
  res.json({ success: true });
});

// ── Admin: reset time (all) ──────────────────────────────────────────────
app.post('/api/admin/instances/reset-all-time', async (req, res) => {
  const db = DatabaseService.getInstance();
  const instances = db.getInstances();
  for (const [uuid, inst] of Object.entries(instances)) {
    inst.realTimeUsedSeconds = 0;
    await db.saveInstance(uuid, inst);
  }
  db.resetArchivedSeconds();
  res.json({ success: true });
});

// ── Admin: delete instance ───────────────────────────────────────────────
app.delete('/api/admin/instances/:uuid', async (req, res) => {
  const uuid = req.params.uuid;
  const db = DatabaseService.getInstance();

  if (uuid.startsWith('i-mock')) {
    // Mock instances: just remove from DB, no AWS call needed
    await db.deleteInstance(uuid);
    console.log(`[Admin API] Mock instance ${uuid} deleted from DB.`);
  } else {
    // Real instances: physically terminate on AWS, then remove from DB
    await ScalingService.getInstance().terminateAndRemove(uuid);
  }
  res.json({ success: true });
});

// ── Admin: abort a prewarm instance ────────────────────────────────────────
app.post('/api/admin/instances/:uuid/abort-prewarm', async (req, res) => {
  const { uuid } = req.params;
  try {
    await ScalingService.getInstance().abortPrewarm(uuid);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin API] abort-prewarm failed:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Abort failed' });
  }
});

// Helper to perform AWS sync and audit buffer pool to trigger prewarm loop if needed
async function performAwsSyncAndBufferAudit(): Promise<number> {
  const db = DatabaseService.getInstance();
  const scaling = ScalingService.getInstance();
  const discovered = await ec2Service.discoverInstancesByTag('Name', process.env.EC2_DISCOVERY_TAG ?? 'LinuxClient');
  const currentInstances = db.getInstances();
  const discoveredUuids = new Set<string>();

  for (const inst of discovered) {
    discoveredUuids.add(inst.uuid);
    const existing = currentInstances[inst.uuid];
    if (existing) {
      // Preserve in-memory pool role assignment (e.g. Prewarm, Buffer, or User)
      inst.assignedTo = existing.assignedTo;
      inst.activeSessions = existing.activeSessions;
      inst.realTimeUsedSeconds = existing.realTimeUsedSeconds;
      inst.displayTimeUsedSeconds = existing.displayTimeUsedSeconds;
      if (existing.pinggyUrl && !inst.pinggyUrl) {
        inst.pinggyUrl = existing.pinggyUrl;
      }
      // Preserve the backend-managed flag from the existing DB record
      inst.managedByBackend = existing.managedByBackend;
      await db.saveInstance(inst.uuid, inst);
    } else {
      // ── NEW instance not yet tracked in DB ──────────────────────────────
      // Only absorb running/pending instances if the backend launched them
      // (ManagedByBackend=true tag on EC2). Manually-created instances that
      // are still running are SKIPPED — they will be absorbed as Buffer by
      // the reconcilePool lightweight sync once they reach 'stopped'.
      // This prevents a manual instance from being injected into the Prewarm
      // lifecycle and eventually being auto-terminated.
      if (inst.status === 'stopped') {
        inst.assignedTo = 'Buffer';
        await db.saveInstance(inst.uuid, inst);
      } else if (inst.managedByBackend === true) {
        // Backend-launched, not yet stopped — safe to track for re-adoption
        await db.saveInstance(inst.uuid, inst);
      } else {
        console.log(
          `[Sync] Skipping untracked running instance ${inst.instanceId} ` +
          `(no ManagedByBackend tag — manually created). Will absorb once stopped.`
        );
      }
    }
  }

  // Delete any instance from memory that wasn't found in AWS (excluding mocks)
  for (const uuid of Object.keys(currentInstances)) {
    if (!discoveredUuids.has(uuid) && !uuid.startsWith('i-mock')) {
      await db.deleteInstance(uuid);
    }
  }

  // Audit buffer pool and trigger prewarm replenishment loop if count < 3
  await scaling.forceReconcile();

  return discovered.length;
}

// ── Admin: sync instances with AWS ───────────────────────────────────────
app.post('/api/admin/instances/sync', async (req, res) => {
  try {
    const count = await performAwsSyncAndBufferAudit();
    res.json({ success: true, count });
  } catch (err: any) {
    console.error('[Admin API] Instance sync failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Sync failed' });
  }
});

// ── Admin: apply & re-align pool (single button, bidirectional) ──────────
// Body: { baseTarget: number, extraBoost: number }
// combinedTarget = baseTarget + extraBoost
// Launches if deficit, terminates stopped Buffer instances if surplus.
// Also persists baseTarget as new minBufferTarget for the auto-loop.
app.post('/api/admin/pool/realign', async (req, res) => {
  const baseTarget = parseInt(req.body.baseTarget, 10);
  const extraBoost = parseInt(req.body.extraBoost,  10);

  if (!Number.isFinite(baseTarget) || baseTarget < 0) {
    return res.status(400).json({ success: false, error: 'baseTarget must be a non-negative integer' });
  }
  if (!Number.isFinite(extraBoost) || extraBoost < 0) {
    return res.status(400).json({ success: false, error: 'extraBoost must be a non-negative integer' });
  }

  console.log(`[Admin API] pool/realign: baseTarget=${baseTarget}, extraBoost=${extraBoost}`);

  try {
    const result = await ScalingService.getInstance().realignPool(baseTarget, extraBoost);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[Admin API] pool/realign failed:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Realign failed' });
  }
});

// ── Admin: edit instance ─────────────────────────────────────────────────
app.put('/api/admin/instances/:uuid', async (req, res) => {
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (!inst) return res.status(404).json({ error: 'Not found' });

  if (req.body.assignedTo !== undefined) {
    inst.assignedTo = req.body.assignedTo;
  }

  await db.saveInstance(req.params.uuid, inst);
  res.json({ success: true, inst });
});

// ── Auth ─────────────────────────────────────────────────────────────────
// Fail closed (security fix 2026-09-30): empty ADMIN_PASSWORD_HASH refuses every admin login; bcrypt hashes are verified with
// bcrypt.compare; a plaintext value is compared in constant time. LOCAL_MODE may use LOCAL_ADMIN_PASSWORD from the untracked .env.
const adminAuthConfig = () => ({
  ADMIN_USERNAME: config.ADMIN_USERNAME,
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH ?? config.ADMIN_PASSWORD_HASH,
  LOCAL_MODE: process.env.LOCAL_MODE === '1',
  LOCAL_ADMIN_PASSWORD: process.env.LOCAL_ADMIN_PASSWORD,
});
if (adminAuthMode(adminAuthConfig()) === 'disabled') {
  console.warn('[Auth] ADMIN_PASSWORD_HASH is not set: admin login is DISABLED (every attempt returns 401).');
}

// Security review: brute-force guard — failed logins per address (default 10 per 15 min), then 429.
const loginFailures = new RateLimiter(envInt('ADMIN_LOGIN_MAX_FAILURES_15MIN', 10), 15 * 60_000);
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const ip = clientIp(req);
  if (loginFailures.count(ip) >= loginFailures.max) return res.status(429).json({ success: false, error: 'Too many attempts, try later' });
  if (await verifyAdminLogin(username, password, adminAuthConfig())) {
    // new session id on login (no session fixation)
    await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    (req.session as any).isAdmin = true;

    // Run async sync & replenishment check immediately on successful admin login
    performAwsSyncAndBufferAudit()
      .then((count) => console.log(`[Auth Login] Sync & buffer audit completed. Discovered: ${count}`))
      .catch((err) => console.error('[Auth Login] Sync & buffer audit failed:', err.message));

    res.json({ success: true });
  } else {
    loginFailures.take(ip);
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});



// ── Public: get instance status ──────────────────────────────────────────
app.get('/api/instances/:uuid/status', async (req, res) => {
  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (!inst) return res.status(404).json({ error: 'Not found' });

  let targetHost: string | null = null;
  let finalStatus: string = inst.status;

  if (inst.status === 'pending' || inst.status === 'running' || inst.status === 'stopping') {
    try {
      const status = await ec2Service.getInstanceStatus(inst.instanceId);

      if (inst.status === 'stopping') {
        if (status.state === 'stopped' || status.state === 'terminated') {
          console.log(`[Status] Instance ${inst.uuid} is now fully stopped.`);
          inst.status = 'stopped';
          await db.saveInstance(inst.uuid, inst);
          finalStatus = 'stopped';
        } else {
          finalStatus = 'stopping';
        }
      }
      else if (status.state === 'running') {
        if (inst.status !== 'running') {
          inst.status = 'running';
          TimeTrackerService.getInstance().startRealTimer(req.params.uuid);
          await db.saveInstance(inst.uuid, inst);
        }

        // Use real AWS IP
        if (status.ip) {
          targetHost = `http://${status.ip}:8000`;

          // Verify the web server is actually alive
          const isReady = await new Promise((resolve) => {
            const reqUrl = targetHost as string;
            const pingReq = http.get(reqUrl, { timeout: 2000 }, () => {
              resolve(true);
            });
            pingReq.on('error', () => resolve(false));
            pingReq.on('timeout', () => { pingReq.destroy(); resolve(false); });
          });

          finalStatus = isReady ? 'running' : 'booting_server';
        }
      } else if (status.state === 'stopped') {
        inst.status = 'stopped';
        finalStatus = 'stopped';
        TimeTrackerService.getInstance().stopRealTimer(req.params.uuid);
        await db.saveInstance(inst.uuid, inst);
      }
    } catch (e: any) {
      console.error('AWS Status Check failed', e.message);
    }
  }

  res.json({
    success: true,
    status: finalStatus,
    ip: targetHost,
    pinggyUrl: inst.pinggyUrl || null,
    lastError: (inst as any).lastError || null
  });
});

// ── Public: On-Demand Dynamic EC2 instance spawn and connect ────────────
app.post('/api/instances/connect-available', async (req, res) => {
  const db = DatabaseService.getInstance();
  let hostToken = req.body.hostToken || crypto.randomUUID();

  // 1. Try to claim an existing stopped instance from the buffer pool
  const attemptedBufferIds: string[] = [];

  while (true) {
    let claimedInstanceId: string | null = null;
    try {
      claimedInstanceId = await ScalingService.getInstance().claimBufferInstance(attemptedBufferIds);
    } catch (e: any) {
      console.warn(`[API] claimBufferInstance failed: ${e.message}`);
    }

    if (!claimedInstanceId) {
      if (attemptedBufferIds.length > 0) {
        console.warn(`[API] [Buffer-Claim] All ${attemptedBufferIds.length} candidate Ready Buffer(s) failed StartInstances: [${attemptedBufferIds.join(', ')}]. Exhausted all available buffers.`);
      }
      break;
    }

    attemptedBufferIds.push(claimedInstanceId);
    console.log(`[API] [Buffer-Claim] Selected buffer instance ${claimedInstanceId} (attempt #${attemptedBufferIds.length})`);

    const inst = db.getInstance(claimedInstanceId);
    if (!inst) {
      console.warn(`[API] [Buffer-Claim] Claimed instance ${claimedInstanceId} not found in DB.`);
      continue;
    }

    inst.status = 'pending';
    inst.assignedTo = `OnDemand-${claimedInstanceId.substring(2, 8)}`;
    inst.activeSessions.set(hostToken, {
      hostToken: hostToken,
      lastSeenAt: Date.now(),
      displayStarted: false
    });
    await db.saveInstance(claimedInstanceId, inst);

    try {
      console.log(`[API] [Buffer-Claim] Waking up buffer instance ${claimedInstanceId}...`);
      await ec2Service.startInstance(claimedInstanceId);
      await ScalingService.getInstance().confirmBufferClaim(claimedInstanceId);
      inst.status = 'pending';
      await db.saveInstance(claimedInstanceId, inst);
      return res.json({ success: true, uuid: claimedInstanceId, status: 'pending', hostToken });
    } catch (err: any) {
      console.error(`[API] [Buffer-Claim] Failed to wake up claimed buffer instance ${claimedInstanceId}:`, err.message);
      await ScalingService.getInstance().rollbackBufferClaim(claimedInstanceId, hostToken, err);
      console.log(`[API] [Buffer-Claim] Rollback complete for ${claimedInstanceId}. Checking if another Ready Buffer is available...`);
    }
  }

  if (attemptedBufferIds.length > 0) {
    return res.status(503).json({ 
      success: false, 
      error: 'Сервер временно недоступен. Пожалуйста, попробуйте снова через несколько секунд.' 
    });
  }

  // 2. Fallback: Spawn a fresh On-Demand instance dynamically
  const uuid = crypto.randomUUID();

  try {
    console.log('[On-Demand] Resolving LinuxClientAMI...');
    const amiId = await ec2Service.getAmiIdByName('LinuxClientAMI');

    // Discover valid config from any existing discovered instances in the database
    const instances = db.getInstances();
    const existingInst = Object.values(instances).find(inst => inst.ec2Config?.subnetId && inst.ec2Config?.securityGroupId);
    
    let subnetId = config.AWS_SUBNET_ID;
    let securityGroupId = config.AWS_SECURITY_GROUP_ID;

    if (existingInst && existingInst.ec2Config) {
      subnetId = existingInst.ec2Config.subnetId;
      securityGroupId = existingInst.ec2Config.securityGroupId;
      console.log(`[On-Demand] Dynamically cloning configuration from existing instance ${existingInst.instanceId}: Subnet=${subnetId}, SecurityGroup=${securityGroupId}`);
    }

    console.log(`[On-Demand] Spawning EC2 instance with AMI ${amiId}...`);
    const { instanceId, instanceType: launchedType } = await ec2Service.createInstance(config.DEFAULT_INSTANCE_TYPE, amiId, subnetId, securityGroupId);
    console.log(`[On-Demand] EC2 instance created: ${instanceId}`);

    const newInst = {
      uuid: instanceId,
      instanceId,
      displayLimitHours: 0,
      realLimitHours: 0,
      displayTimeUsedSeconds: 0,
      realTimeUsedSeconds: 0,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      assignedTo: `OnDemand-${instanceId.substring(2, 8)}`,
      ec2Config: {
        instanceType: launchedType,
        region: config.AWS_REGION || 'eu-central-1',
        amiId,
        securityGroupId,
        subnetId,
      },
      activeSessions: new Map(),
    };

    newInst.activeSessions.set(hostToken, {
      hostToken: hostToken,
      lastSeenAt: Date.now(),
      displayStarted: false
    });

    await db.saveInstance(instanceId, newInst);
    res.json({ success: true, uuid: instanceId, status: 'pending', hostToken });

  } catch (err: any) {
    const errMsg = err.message || 'Failed to spawn on-demand instance';
    console.error('[On-Demand] Failed to connect-available:', errMsg);
    res.status(500).json({ 
      success: false, 
      error: 'Сервер временно недоступен. Пожалуйста, попробуйте снова через несколько секунд.' 
    });
  }
});



// ── EC2 Self-Report: tunnel URL registration ─────────────────────────────
// Called by the EC2 instance startup script once its Pinggy tunnel is live.
// Security: protected by a shared secret (TUNNEL_REPORT_SECRET in .env).
app.post('/api/instances/:uuid/report-tunnel', async (req, res) => {
  const { secret, pinggyUrl } = req.body;

  // Simple shared-secret guard so only trusted EC2 scripts can call this.
  const expectedSecret = process.env.TUNNEL_REPORT_SECRET || '';
  if (!expectedSecret || !safeEqual(String(secret ?? ''), expectedSecret)) { // constant-time (security review)
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!pinggyUrl || typeof pinggyUrl !== 'string') {
    return res.status(400).json({ error: 'pinggyUrl is required' });
  }

  // Normalize: strip trailing slash
  const normalizedUrl = pinggyUrl.replace(/\/+$/, '');

  const db = DatabaseService.getInstance();
  const inst = db.getInstance(req.params.uuid);
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  inst.pinggyUrl = normalizedUrl;
  await db.saveInstance(req.params.uuid, inst);
  console.log(`[Tunnel] Instance ${req.params.uuid} reported Pinggy URL: ${normalizedUrl}`);

  // Note: We no longer broadcast server-ready immediately here to prevent premature redirection.
  // The websocket status poll will check for streamerConnected readiness via the status endpoint.

  res.json({ success: true, pinggyUrl: normalizedUrl });
});

// ── Public Webhook: Notify when UE streamer crashes/disconnects ──────────────
// Called by the signaling server on the EC2 instance when the streamer connection drops.
app.post('/api/instances/:uuid/streamer-disconnected', async (req, res) => {
  const { uuid } = req.params;
  const { secret } = req.body;

  // Verify secret if configured (using TUNNEL_REPORT_SECRET as the default key)
  const expectedSecret = process.env.TUNNEL_REPORT_SECRET || '';
  if (expectedSecret && !safeEqual(String(secret ?? ''), expectedSecret)) { // constant-time (security review); still open when unset — see SECURITY_REVIEW
    console.warn(`[Streamer Disconnect Webhook] Unauthorized request for instance ${uuid}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DatabaseService.getInstance();
  const inst = db.getInstance(uuid);
  if (!inst) {
    console.warn(`[Streamer Disconnect Webhook] Instance ${uuid} not found in DB`);
    return res.status(404).json({ error: 'Instance not found' });
  }

  console.log(`[Streamer Disconnect Webhook] Streamer crashed/disconnected on instance ${uuid} (${inst.assignedTo})`);

  if (wsService) {
    // Force trigger the 60s grace period countdown
    wsService.startGracePeriod(uuid);
    res.json({ success: true, message: 'Grace period initiated.' });
  } else {
    res.status(500).json({ success: false, error: 'WebSocketService not initialized' });
  }
});

// ── Debug: test AWS connectivity ─────────────────────────────────────────
app.get('/api/debug/aws-test', async (req, res) => {
  try {
    const status = await ec2Service.getInstanceStatus('i-027f86f5e9e0720c6');
    res.json({ success: true, result: status });
  } catch (e: any) {
    res.json({ success: false, error: e.message, code: e.name });
  }
});

// ─── USER SAVES ENDPOINTS (LOCAL JSON FILE STORAGE) ───
const SAVES_DIR = path.join(__dirname, 'data/saves');
if (!fs.existsSync(SAVES_DIR)) {
  fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// QA-004 (adjusted for production): the username builds a file path, so it must be path-safe — but any Unicode
// letters/digits are fine (existing Cyrillic logins keep saving). Allowed: letters, marks, digits, space, . _ @ -;
// refused: / \ .. NUL/control chars, more than 64 characters; the resolved file must stay directly inside SAVES_DIR.
const SAFE_USERNAME_RE = /^[\p{L}\p{M}\p{N} ._@-]+$/u;
export function isSafeUsername(u: unknown): u is string {
  if (typeof u !== 'string' || !u) return false;
  if ([...u].length > 64) return false;
  if (u === '.' || u.includes('..')) return false;
  if (/[\/\\\u0000-\u001f\u007f-\u009f]/.test(u)) return false;
  return SAFE_USERNAME_RE.test(u);
}
/** The user's save file, or null when the name is unsafe or would resolve outside SAVES_DIR. */
function savesFileFor(username: unknown): string | null {
  if (!isSafeUsername(username)) return null;
  const root = path.resolve(SAVES_DIR);
  const filePath = path.resolve(root, `${username}.json`);
  return path.dirname(filePath) === root ? filePath : null;
}

// 1. GET saves for a specific user
app.get('/api/saves/:username', (req, res) => {
  const username = req.params.username;
  const filePath = savesFileFor(username);
  if (!filePath) return res.status(400).json({ error: 'Invalid username' });

  if (!fs.existsSync(filePath)) {
    return res.json([]);
  }

  try {
    const fileData = fs.readFileSync(filePath, 'utf-8');
    const saves = JSON.parse(fileData);
    res.json(saves);
  } catch (err) {
    console.error('Error reading save file:', err);
    res.status(500).json({ error: 'Failed to read saves' });
  }
});

// 2. POST save for a user
app.post('/api/saves', (req, res) => {
  const { username, saveId, saveName, date } = req.body;

  if (!username || !saveId || !saveName || !date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const filePath = savesFileFor(username);
  if (!filePath) return res.status(400).json({ error: 'Invalid username' });
  let saves: any[] = [];

  if (fs.existsSync(filePath)) {
    try {
      const fileData = fs.readFileSync(filePath, 'utf-8');
      saves = JSON.parse(fileData);
    } catch (err) {
      console.error('Error reading save file:', err);
    }
  }

  // Preserve the entire request body (including boothStates array) except the username
  const newSave = { ...req.body };
  delete newSave.username;

  const existingIndex = saves.findIndex((s) => s.saveId === saveId);
  if (existingIndex !== -1) {
    saves[existingIndex] = newSave;
  } else {
    saves.push(newSave);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(saves, null, 2), 'utf-8');
    res.json({ success: true, saves });
  } catch (err) {
    console.error('Error writing save file:', err);
    res.status(500).json({ error: 'Failed to write save' });
  }
});

// 3. DELETE save for a user
app.delete('/api/saves/:username/:saveId', (req, res) => {
  const { username, saveId } = req.params;
  const filePath = savesFileFor(username);
  if (!filePath) return res.status(400).json({ error: 'Invalid username' });

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'No saves found for user' });
  }

  try {
    const fileData = fs.readFileSync(filePath, 'utf-8');
    let saves = JSON.parse(fileData);
    
    saves = saves.filter((s: any) => s.saveId !== saveId);
    
    fs.writeFileSync(filePath, JSON.stringify(saves, null, 2), 'utf-8');
    res.json({ success: true, saves });
  } catch (err) {
    console.error('Error writing save file during delete:', err);
    res.status(500).json({ error: 'Failed to delete save' });
  }
});

// ─── AR GLB UPLOAD & HOSTING ───
const AR_MODELS_DIR = path.join(__dirname, '../public/ar/models');
if (!fs.existsSync(AR_MODELS_DIR)) {
  fs.mkdirSync(AR_MODELS_DIR, { recursive: true });
}

// Background cleanup: remove .glb files older than 2 hours every 30 minutes
setInterval(() => {
  try {
    const now = Date.now();
    const maxAgeMs = 2 * 60 * 60 * 1000;
    if (fs.existsSync(AR_MODELS_DIR)) {
      const files = fs.readdirSync(AR_MODELS_DIR);
      for (const file of files) {
        if (file.endsWith('.glb')) {
          const filePath = path.join(AR_MODELS_DIR, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            console.log(`[AR Cleanup] Deleted expired AR model: ${file}`);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('[AR Cleanup] Error cleaning old AR models:', err.message);
  }
}, 30 * 60 * 1000);

// Endpoint accepting raw binary GLB uploads (up to 50MB)
app.post(
  '/api/ar/upload',
  express.raw({ type: ['application/octet-stream', 'model/gltf-binary', '*/*'], limit: '50mb' }),
  (req, res) => {
    try {
      const buffer = req.body as Buffer;
      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res.status(400).json({ success: false, error: 'Empty file payload' });
      }

      const rawFileName = (req.headers['x-file-name'] as string) || (req.query.filename as string) || `export_${Date.now()}.glb`;
      const sanitizedFileName = path.basename(rawFileName).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const finalFileName = sanitizedFileName.endsWith('.glb') ? sanitizedFileName : `${sanitizedFileName}.glb`;

      const targetPath = path.join(AR_MODELS_DIR, finalFileName);
      fs.writeFileSync(targetPath, buffer);

      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
      const proto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
      const publicUrl = `${proto}://${host}/ar/viewer.html?model=${encodeURIComponent(finalFileName)}`;

      console.log(`[AR Upload] Received model '${finalFileName}' (${(buffer.length / 1024 / 1024).toFixed(2)} MB) -> ${publicUrl}`);

      return res.json({
        success: true,
        fileName: finalFileName,
        url: publicUrl,
        sizeBytes: buffer.length,
      });
    } catch (err: any) {
      console.error('[AR Upload] Upload processing failed:', err.message);
      return res.status(500).json({ success: false, error: err.message || 'Failed to save AR model' });
    }
  }
);

// ─── AI CONSULTANT (catalog, orchestrator, voice clips, render, dossier) — only with AI_ENABLED=1 ───
// Mounted before the SPA fallback. The Socket.io /ai namespace is attached in server.ts. The module is required lazily,
// so with AI off none of its code (catalog, sharp, puppeteer, provider SDKs: about +45 MB RSS) is even loaded.
// /api/ar/upload is NOT part of it: the live handler above (public/ar/viewer.html) serves the UE client.
function loadAiLayer(): typeof import('./ai') {
  // vitest runs the TypeScript sources, where CommonJS require('./ai') cannot resolve index.ts: test/setup.ts preloads
  // the layer into this global. The compiled server (dist/) always takes the plain require.
  return (globalThis as any).__MAXIMALL_AI_LAYER__ ?? require('./ai');
}
export const aiModule: AiModule | null = AI_ENABLED
  ? loadAiLayer().createAiModule({
      savesDir: SAVES_DIR,
      // Security review: a pool session (hostToken from connect-available / display-start) of that instance; used only with AI_REQUIRE_HOST_TOKEN=1.
      verifyHostToken: (instanceUuid, hostToken) => {
        const sessions = DatabaseService.getInstance().getInstance(instanceUuid)?.activeSessions;
        return !!sessions && (sessions.has(hostToken) || [...sessions.values()].some((x: any) => x?.hostToken === hostToken));
      },
    })
  : null;
if (aiModule) app.use(aiModule.router);

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default app;
