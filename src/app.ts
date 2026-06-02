import express from 'express';
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

// Setup static files
app.use(express.static(path.join(__dirname, '../public')));

const ec2Service = new EC2Service();

// ── Admin: list all instances ──────────────────────────────────────────────
app.get('/api/admin/instances', (req, res) => {
  const db = DatabaseService.getInstance();
  const instances = db.getInstances();
  const graceList = TimeTrackerService.getInstance().getInstancesInGrace();
  
  const enriched: Record<string, any> = {};
  for (const [uuid, inst] of Object.entries(instances)) {
    enriched[uuid] = {
      ...inst,
      inGracePeriod: graceList.includes(uuid)
    };
  }
  res.json(enriched);
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
  res.json({ success: true });
});

// ── Admin: delete instance ───────────────────────────────────────────────
app.delete('/api/admin/instances/:uuid', async (req, res) => {
  const db = DatabaseService.getInstance();
  await db.deleteInstance(req.params.uuid);
  res.json({ success: true });
});

// ── Admin: sync instances with AWS ───────────────────────────────────────
app.post('/api/admin/instances/sync', async (req, res) => {
  try {
    const db = DatabaseService.getInstance();
    const discovered = await ec2Service.discoverInstancesByTag('Name', process.env.EC2_DISCOVERY_TAG ?? 'LinuxClient');
    const currentInstances = db.getInstances();
    const discoveredUuids = new Set<string>();

    for (const inst of discovered) {
      discoveredUuids.add(inst.uuid);
      const existing = currentInstances[inst.uuid];
      if (existing) {
        inst.activeSessions = existing.activeSessions;
        inst.realTimeUsedSeconds = existing.realTimeUsedSeconds;
        inst.displayTimeUsedSeconds = existing.displayTimeUsedSeconds;
        if (existing.pinggyUrl && !inst.pinggyUrl) {
          inst.pinggyUrl = existing.pinggyUrl;
        }
      }
      await db.saveInstance(inst.uuid, inst);
    }

    // Delete any instance from memory that wasn't found in AWS (excluding mocks)
    for (const uuid of Object.keys(currentInstances)) {
      if (!discoveredUuids.has(uuid) && !uuid.startsWith('i-mock')) {
        await db.deleteInstance(uuid);
      }
    }

    res.json({ success: true, count: discovered.length });
  } catch (err: any) {
    console.error('[Admin API] Instance sync failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Sync failed' });
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

import http from 'http';

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
  const uuid = crypto.randomUUID();
  let hostToken = req.body.hostToken || crypto.randomUUID();

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
      uuid,
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

    await db.saveInstance(uuid, newInst);
    res.json({ success: true, uuid, status: 'pending', hostToken });

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
