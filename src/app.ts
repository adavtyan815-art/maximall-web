import express from 'express';
import http from 'http';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { config } from './config';
import type { WebSocketService } from './services/websocketService';

// WebSocket service is injected after server creation (see server.ts)
let wsService: WebSocketService | null = null;
export function setWsService(ws: WebSocketService) { wsService = ws; }

// Import services (pure in-memory — no MongoDB)
import { DatabaseService } from './services/databaseService';
import { SettingsService } from './services/settingsService';

const app = express();

const NGROK_ORIGIN = 'https://hooly-superblessed-shan.ngrok-free.dev';

// Middleware
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

import crypto from 'crypto';
import { EC2Service } from './services/ec2Service';
import { TimeTrackerService } from './services/timeTrackerService';
import { ScalingService } from './services/scalingService';

// Authentication Middleware
app.use((req, res, next) => {
  if (req.path === '/admin.html' || req.path.startsWith('/api/admin') || req.path.startsWith('/api/debug')) {
    if (req.path === '/api/admin/login' || req.path === '/api/admin/logout') {
      return next();
    }
    if (!(req.session as any).isAdmin) {
      if (req.path === '/admin.html') {
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

  const ip = inst.publicIp;
  if (!ip) {
    return res.status(503).send('Instance public IP is not yet available. Please reload in a moment.');
  }

  const targetPath = (req.params as any)[0];
  const query = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query as any).toString() : '';

  // Copy and normalize incoming headers
  const headers = { ...req.headers };
  headers.host = ip; // Set target host

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
      instanceType: req.body.instanceType || 'g4dn.2xlarge',
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
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === config.ADMIN_USERNAME && password === config.ADMIN_PASSWORD_HASH) {
    (req.session as any).isAdmin = true;

    // Run async sync & replenishment check immediately on successful admin login
    performAwsSyncAndBufferAudit()
      .then((count) => console.log(`[Auth Login] Sync & buffer audit completed. Discovered: ${count}`))
      .catch((err) => console.error('[Auth Login] Sync & buffer audit failed:', err.message));

    res.json({ success: true });
  } else {
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
  let claimedInstanceId: string | null = null;
  try {
    claimedInstanceId = await ScalingService.getInstance().claimBufferInstance();
  } catch (e: any) {
    console.warn(`[API] claimBufferInstance failed: ${e.message}`);
  }

  if (claimedInstanceId) {
    console.log(`[API] Claimed buffer instance ${claimedInstanceId} for user`);
    const inst = db.getInstance(claimedInstanceId);
    if (inst) {
      inst.status = 'pending';
      inst.assignedTo = `OnDemand-${claimedInstanceId.substring(2, 8)}`;
      inst.activeSessions.set(hostToken, {
        hostToken: hostToken,
        lastSeenAt: Date.now(),
        displayStarted: false
      });
      await db.saveInstance(claimedInstanceId, inst);

      try {
        console.log(`[API] Waking up buffer instance ${claimedInstanceId}...`);
        await ec2Service.startInstance(claimedInstanceId);
        return res.json({ success: true, uuid: claimedInstanceId, status: 'pending', hostToken });
      } catch (err: any) {
        console.error(`[API] Failed to wake up claimed buffer instance ${claimedInstanceId}:`, err.message);
        // Rollback on failure
        inst.status = 'stopped';
        inst.assignedTo = 'Buffer';
        inst.activeSessions.delete(hostToken);
        await db.saveInstance(claimedInstanceId, inst);
        return res.status(500).json({ success: false, error: `Failed to wake up server: ${err.message}` });
      }
    }
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
    const { instanceId } = await ec2Service.createInstance('g4dn.2xlarge', amiId, subnetId, securityGroupId);
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
        instanceType: 'g4dn.2xlarge',
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
    res.status(500).json({ success: false, error: errMsg });
  }
});



// ── EC2 Self-Report: tunnel URL registration ─────────────────────────────
// Called by the EC2 instance startup script once its Pinggy tunnel is live.
// Security: protected by a shared secret (TUNNEL_REPORT_SECRET in .env).
app.post('/api/instances/:uuid/report-tunnel', async (req, res) => {
  const { secret, pinggyUrl } = req.body;

  // Simple shared-secret guard so only trusted EC2 scripts can call this.
  const expectedSecret = process.env.TUNNEL_REPORT_SECRET || '';
  if (!expectedSecret || secret !== expectedSecret) {
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
  if (expectedSecret && secret !== expectedSecret) {
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

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

export default app;
