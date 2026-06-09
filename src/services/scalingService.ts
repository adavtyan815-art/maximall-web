import { EC2Service } from './ec2Service';
import { DatabaseService } from './databaseService';
import * as http  from 'http';
import * as https from 'https';
import WebSocket from 'ws';

// ── Labels ─────────────────────────────────────────────────────────────────
// These are stored in instance.assignedTo to distinguish pool roles from
// real user sessions (which use a custom name or 'OnDemand-XXXXXX').
export const PREWARM_LABEL = 'Prewarm';
export const BUFFER_LABEL  = 'Buffer';

// ── Configuration ──────────────────────────────────────────────────────────
const BUFFER_SIZE    = 3;           // Number of pre-warmed stopped instances to maintain
const GRACE_PERIOD_MS = 60_000;    // 1-minute wait after client disconnect (handled by WS service)

const POLL_MS         = 15_000;   // Interval between state-machine polls (15 s)
const BOOT_TIMEOUT    = 15 * 60 * 1000;  // 15 min — Phase 1: wait for AWS 'running'
const TUNNEL_TIMEOUT  = 10 * 60 * 1000;  // 10 min — Phase 2: wait for Pinggy tunnel
const SIGNAL_TIMEOUT  = 15 * 60 * 1000;  // 15 min — Phase 3+4: wait for signaling + streamer
const STOP_TIMEOUT    = 10 * 60 * 1000;  // 10 min — Phase 5: wait for 'stopped'

const BOOT_MAX   = Math.ceil(BOOT_TIMEOUT   / POLL_MS);  // 60 polls
const TUNNEL_MAX = Math.ceil(TUNNEL_TIMEOUT / POLL_MS);  // 40 polls
const SIGNAL_MAX = Math.ceil(SIGNAL_TIMEOUT / POLL_MS);  // 60 polls
const STOP_MAX   = Math.ceil(STOP_TIMEOUT   / POLL_MS);  // 40 polls

const RECONCILE_INTERVAL_MS = 60_000;  // How often to check pool deficit (1 min)

// ── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns the correct Node.js transport module for the given URL.
 * Pinggy tunnel URLs are always https://, so we must use the `https` module.
 * Using `http` for an https:// URL will silently error on every request.
 */
function pickTransport(url: string): typeof http | typeof https {
  return url.startsWith('https://') ? https : http;
}

/**
 * Generic GET probe — resolves `true` if the server returns *any* HTTP
 * response (including 4xx/5xx), meaning the process is reachable.
 * Automatically uses https for https:// URLs.
 */
function probeHttp(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const transport = pickTransport(url);
      const req = transport.get(url, {
        timeout: timeoutMs,
        headers: { 'X-Pinggy-No-Screen': 'true' }
      }, () => {
        req.destroy();
        resolve(true);
      });
      req.on('error', (err) => {
        resolve(false);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Probes the signaling server via WebSocket and returns:
 *   'connected'   — UE5 streamer is reported connected
 *   'alive'       — server responded but streamer not yet connected
 *   'unreachable' — connection failed (wrong protocol, timeout, etc.)
 */
function checkStreamerStatus(baseUrl: string): Promise<'connected' | 'alive' | 'unreachable'> {
  return new Promise(resolve => {
    // Map HTTP/HTTPS URL to WS/WSS URL
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    
    let resolved = false;
    const cleanupAndResolve = (status: 'connected' | 'alive' | 'unreachable') => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {}
      resolve(status);
    };

    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Pinggy-No-Screen': 'true'
      },
      handshakeTimeout: 5000
    });

    const timer = setTimeout(() => {
      cleanupAndResolve('unreachable');
    }, 6000);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'listStreamers' }));
      } catch {
        cleanupAndResolve('unreachable');
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'streamerList') {
          if (Array.isArray(msg.ids) && msg.ids.length > 0) {
            cleanupAndResolve('connected');
          } else {
            cleanupAndResolve('alive');
          }
        }
      } catch {
        // Non-JSON body or unexpected format, but server is reachable
        cleanupAndResolve('alive');
      }
    });

    ws.on('error', () => resolve('unreachable'));
    ws.on('close', () => resolve('unreachable'));
  });
}


// ── ScalingService ─────────────────────────────────────────────────────────
export class ScalingService {
  private static instance: ScalingService;
  private ec2Service: EC2Service;
  private db: DatabaseService;

  /** Set of instanceIds currently running through the pre-warm lifecycle. */
  private activePrewarms: Set<string> = new Set();

  /** Count of instances currently undergoing async launch execution. */
  private launchingCount: number = 0;

  /**
   * Maps instanceId → current phase (1–5) for prewarm instances.
   * Phase 1: Booting (waiting for AWS 'running')
   * Phase 2: Tunnel (waiting for Pinggy URL)
   * Phase 3: Signal (waiting for signaling server alive)
   * Phase 4: Streamer (waiting for UE5 streamer connected)
   * Phase 5: Stopping (graceful stop → buffer)
   */
  private prewarmPhases: Map<string, number> = new Map();

  /** Count of instances currently in grace period (set by WebSocketService). */
  private gracePeriodCount: number = 0;

  private constructor() {
    this.ec2Service = new EC2Service();
    this.db = DatabaseService.getInstance();
  }

  static getInstance(): ScalingService {
    if (!ScalingService.instance) {
      ScalingService.instance = new ScalingService();
    }
    return ScalingService.instance;
  }

  /** Returns current phase (1–5) for each actively pre-warming instance. */
  getPrewarmPhases(): Map<string, number> {
    return new Map(this.prewarmPhases);
  }

  /** Returns the number of active prewarm instances. */
  getActivePrewarmCount(): number {
    return this.activePrewarms.size;
  }

  /** Called by WebSocketService to keep grace period count in sync. */
  setGracePeriodCount(count: number): void {
    this.gracePeriodCount = count;
  }

  /** Returns current grace period count. */
  getGracePeriodCount(): number {
    return this.gracePeriodCount;
  }

  // ── Public: start the perpetual reconciliation loop ──────────────────────
  startPrewarmLoop(): void {
    console.log('[Scaling] Pre-warm loop started.');
    this.reconcilePool();  // Fire immediately on startup

    setInterval(() => {
      this.reconcilePool();
    }, RECONCILE_INTERVAL_MS);
  }

  async forceReconcile(): Promise<void> {
    console.log('[Scaling] Force-triggered pool reconciliation audit...');
    await this.reconcilePool();
  }

  // ── Pool Reconciliation ───────────────────────────────────────────────────
  private async reconcilePool(): Promise<void> {
    const instances = this.db.getInstances();

    // Count stopped instances already in the buffer (assignedTo = 'Buffer')
    const bufferCount = Object.values(instances).filter(
      i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped'
    ).length;

    // Count instances that are Prewarm-labeled but we lost track of (server restart)
    const reconciledPrewarms = Object.values(instances).filter(
      i => i.assignedTo === PREWARM_LABEL
    );

    // Re-adopt orphaned pre-warms from a previous server lifetime
    for (const inst of reconciledPrewarms) {
      if (!this.activePrewarms.has(inst.instanceId)) {
        console.log(`[Scaling] Reconciling orphaned prewarm instance: ${inst.instanceId}`);
        this.activePrewarms.add(inst.instanceId);
        // Resume the lifecycle without blocking the reconcile loop
        this.waitForWarmupAndStop(inst.instanceId).catch(err => {
          console.error(`[Scaling] Reconciled prewarm ${inst.instanceId} lifecycle error:`, err.message);
        });
      }
    }

    // Count instances actively going through the pre-warm lifecycle in memory (after adoption) plus currently launching ones
    const prewarmCount = this.activePrewarms.size + this.launchingCount;

    const deficit = BUFFER_SIZE - bufferCount - prewarmCount;

    console.log(
      `[Scaling] Pool check: ${bufferCount} buffer-ready, ${prewarmCount} pre-warming, ` +
      `${reconciledPrewarms.length - prewarmCount} pending → deficit=${deficit}`
    );

    if (deficit <= 0) return;

    // Launch one instance per deficit unit, concurrently
    const launches = Array.from({ length: deficit }, () => this.launchPrewarmInstance());
    await Promise.allSettled(launches);
  }

  // ── Launch a single pre-warm EC2 instance ─────────────────────────────────
  private async launchPrewarmInstance(): Promise<void> {
    let instanceId: string | undefined;
    this.launchingCount++;
    try {
      console.log('[Scaling] Resolving AMI for prewarm...');
      const amiId = await this.ec2Service.getAmiIdByName('LinuxClientAMI');

      // Clone network config from any existing known instance
      const allInstances = this.db.getInstances();
      const donor = Object.values(allInstances).find(
        i => i.ec2Config?.subnetId && !i.ec2Config.subnetId.includes('xxxxx') &&
             i.ec2Config?.securityGroupId && !i.ec2Config.securityGroupId.includes('xxxxx')
      );
      const subnetId          = donor?.ec2Config?.subnetId;
      const securityGroupId   = donor?.ec2Config?.securityGroupId;

      console.log(`[Scaling] Launching prewarm EC2 (g4dn.2xlarge, ami=${amiId})...`);
      const result = await this.ec2Service.createInstance(
        'g4dn.2xlarge', amiId, subnetId, securityGroupId
      );
      instanceId = result.instanceId;
      console.log(`[Scaling] Prewarm EC2 launched: ${instanceId}`);

      // Register in DB so the admin dashboard can see it immediately
      await this.db.saveInstance(instanceId, {
        uuid: instanceId,
        instanceId,
        displayLimitHours: 0,
        realLimitHours: 0,
        displayTimeUsedSeconds: 0,
        realTimeUsedSeconds: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        assignedTo: PREWARM_LABEL,
        ec2Config: {
          instanceType: 'g4dn.2xlarge',
          region: donor?.ec2Config?.region || 'eu-central-1',
          amiId,
          securityGroupId: securityGroupId || '',
          subnetId: subnetId || '',
        },
        activeSessions: new Map(),
      });

      this.activePrewarms.add(instanceId);
      this.prewarmPhases.set(instanceId, 1);  // Start at Phase 1: Boot

      // Run the lifecycle asynchronously — do NOT await here so reconcilePool returns
      this.waitForWarmupAndStop(instanceId).catch(err => {
        console.error(`[Scaling] Prewarm ${instanceId} lifecycle error:`, err.message);
      });

    } catch (err: any) {
      console.error('[Scaling] Failed to launch prewarm instance:', err.message);
      if (instanceId) {
        this.activePrewarms.delete(instanceId);
        this.prewarmPhases.delete(instanceId);
        // Best-effort cleanup on AWS
        try { await this.ec2Service.terminateInstance(instanceId); } catch {}
        await this.db.deleteInstance(instanceId);
      }
    } finally {
      this.launchingCount--;
    }
  }

  // ── 5-Phase Pre-warm Lifecycle ────────────────────────────────────────────
  private async waitForWarmupAndStop(instanceId: string): Promise<void> {
    const tag = `[Scaling] Prewarm ${instanceId}`;

    const fatal = async (reason: string): Promise<void> => {
      console.error(`${tag} FATAL triggered! Reason: "${reason}". Call stack:\n`, new Error().stack);
      this.prewarmPhases.delete(instanceId);
      await this.terminateAndRemove(instanceId);
    };

    // ── Phase 1: Boot — wait for AWS state = 'running' ────────────────────
    this.prewarmPhases.set(instanceId, 1);
    console.log(`${tag} Phase 1 BOOT: Waiting for ${instanceId} to reach 'running'...`);
    let booted = false;
    let publicIp: string | null = null;

    for (let i = 0; i < BOOT_MAX; i++) {
      await sleep(POLL_MS);
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`${tag} Phase 1 BOOT [${i + 1}/${BOOT_MAX}]: ${instanceId} → ${awsStatus.state}`);

        if (awsStatus.state === 'running') {
          publicIp = awsStatus.ip;
          booted = true;
          console.log(`${tag} Phase 1 BOOT: ✓ ${instanceId} is running (ip: ${publicIp})`);
          // Update DB status
          const inst = this.db.getInstance(instanceId);
          if (inst) { inst.status = 'running'; await this.db.saveInstance(instanceId, inst); }
          break;
        }

        if (awsStatus.state === 'terminated' || awsStatus.state === 'shutting-down') {
          await fatal('Instance terminated unexpectedly during boot');
          return;
        }
      } catch (err: any) {
        console.warn(`${tag} Phase 1 BOOT poll error: ${err.message}`);
      }
    }

    if (!booted) {
      await fatal('Timed out waiting for instance to reach running state');
      return;
    }

    // ── Phase 2: Tunnel — wait for Pinggy URL ─────────────────────────────
    this.prewarmPhases.set(instanceId, 2);
    console.log(`${tag} Phase 2 TUNNEL: Waiting for tunnel URL from ${instanceId}...`);
    let pinggyUrl: string | undefined;
    let tunnelFound = false;

    for (let i = 0; i < TUNNEL_MAX; i++) {
      await sleep(POLL_MS);

      // Check if EC2 startup script already called /report-tunnel
      const inst = this.db.getInstance(instanceId);
      if (!inst) {
        await fatal('Instance disappeared from DB during tunnel wait');
        return;
      }

      if (inst.pinggyUrl) {
        pinggyUrl = inst.pinggyUrl;
        tunnelFound = true;
        console.log(`${tag} Phase 2 TUNNEL: ✓ Tunnel URL received: ${pinggyUrl}`);
        break;
      }

      // Fallback: probe the public IP on port 80 directly (Pinggy listens on 80)
      if (publicIp) {
        const directAlive = await probeHttp(`http://${publicIp}:80`);
        if (directAlive) {
          // If the direct IP is responding, Pinggy is likely up — wait one more cycle
          // for the /report-tunnel callback. Log but don't break.
          console.log(`${tag} Phase 2 TUNNEL [${i + 1}/${TUNNEL_MAX}]: Direct IP alive, awaiting /report-tunnel callback...`);
        } else {
          console.log(`${tag} Phase 2 TUNNEL [${i + 1}/${TUNNEL_MAX}]: Waiting for tunnel... (no pinggyUrl, direct IP not ready)`);
        }
      } else {
        console.log(`${tag} Phase 2 TUNNEL [${i + 1}/${TUNNEL_MAX}]: Waiting for tunnel...`);
      }
    }

    if (!tunnelFound) {
      await fatal('Timed out waiting for Pinggy tunnel URL');
      return;
    }

    // ── Phase 3 & 4: Signal + Streamer — wait for UE5 streamer connection ──
    this.prewarmPhases.set(instanceId, 3);
    console.log(`${tag} Phase 3 SIGNAL: Waiting for signaling server & UE5 streamer...`);
    let signalingConfirmed = false;
    let serverAliveEver    = false;   // True once we get ANY HTTP response through the tunnel

    for (let i = 0; i < SIGNAL_MAX; i++) {
      await sleep(POLL_MS);

      // Re-read pinggyUrl in case it was updated
      const inst = this.db.getInstance(instanceId);
      if (!inst) {
        await fatal('Instance disappeared from DB during signal wait');
        return;
      }
      const urlToCheck = inst.pinggyUrl ?? pinggyUrl!;

      const streamerStatus = await checkStreamerStatus(urlToCheck);
      console.log(
        `${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: ` +
        `Probing ${urlToCheck}/api/status → ${streamerStatus}`
      );

      if (streamerStatus === 'connected') {
        signalingConfirmed = true;
        this.prewarmPhases.set(instanceId, 4);  // Phase 4: Streamer confirmed
        console.log(`${tag} Phase 4 STREAMER: ✓ Streamer connected — prewarm verified.`);
        inst.streamerConnected = true;
        await this.db.saveInstance(instanceId, inst);
        break;
      }

      if (streamerStatus === 'alive') {
        // Signaling server is reachable — streamer not connected yet, keep waiting
        serverAliveEver = true;
        console.log(`${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: Server alive, streamer not yet connected. Waiting...`);
      } else {
        // 'unreachable' — could be transient HTTPS cert warmup or Pinggy delay
        console.log(`${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: Server unreachable via tunnel. Will retry...`);
      }
    }

    // ── Signal phase result ───────────────────────────────────────────────
    // NON-FATAL path: if we never got any HTTP response at all through the
    // tunnel, the instance is likely broken — terminate it.
    // But if the server was reachable (serverAliveEver=true) and we just
    // didn't see the streamer confirm within the window, we still proceed:
    // the AMI startup script already ran UE5, so the instance IS warmed up.
    if (!signalingConfirmed) {
      if (!serverAliveEver) {
        // Tunnel URL never responded — instance networking is broken
        await fatal('Signaling server never responded through tunnel — instance networking broken');
        return;
      }
      console.warn(
        `${tag} Phase 3 SIGNAL: Streamer did not confirm within timeout, but server was alive. ` +
        `Proceeding to stop — instance is prewarmed (UE5 runs on AMI boot).`
      );
      // Mark phase 4 reached (best-effort)
      this.prewarmPhases.set(instanceId, 4);
    }

    // ── Phase 5: Stop — gracefully stop the instance ──────────────────────
    this.prewarmPhases.set(instanceId, 5);  // Phase 5: Stopping
    console.log(`${tag} Phase 5 STOP: Stopping ${instanceId}...`);
    try {
      await this.ec2Service.stopInstance(instanceId);
      const inst = this.db.getInstance(instanceId);
      if (inst) { inst.status = 'stopping'; await this.db.saveInstance(instanceId, inst); }
    } catch (err: any) {
      await fatal(`Failed to issue stop command: ${err.message}`);
      return;
    }

    // Wait for AWS to confirm stopped
    let stopped = false;
    for (let i = 0; i < STOP_MAX; i++) {
      await sleep(POLL_MS);
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`${tag} Phase 5 STOP [${i + 1}/${STOP_MAX}]: ${instanceId} → ${awsStatus.state}`);

        if (awsStatus.state === 'stopped') {
          stopped = true;
          break;
        }
        if (awsStatus.state === 'terminated') {
          console.error(`${tag} Phase 5 STOP: Instance terminated unexpectedly while stopping.`);
          await this.db.deleteInstance(instanceId);
          this.activePrewarms.delete(instanceId);
          return;
        }
      } catch (err: any) {
        console.warn(`${tag} Phase 5 STOP poll error: ${err.message}`);
      }
    }

    if (!stopped) {
      await fatal('Timed out waiting for instance to stop');
      return;
    }

    // ── Success: move to Buffer pool ─────────────────────────────────────
    const finalInst = this.db.getInstance(instanceId);
    if (finalInst) {
      finalInst.status = 'stopped';
      finalInst.assignedTo = BUFFER_LABEL;
      finalInst.streamerConnected = false;  // Reset for next use
      await this.db.saveInstance(instanceId, finalInst);
    }
    this.activePrewarms.delete(instanceId);
    this.prewarmPhases.delete(instanceId);  // Remove from phase tracking — now in buffer
    console.log(`${tag} ✅ Successfully moved to buffer pool. assignedTo=Buffer, status=stopped.`);
  }

  // ── Claim a buffer instance for a real user ───────────────────────────────
  /**
   * Called by WebSocketService when a new user needs an instance.
   * Returns the instanceId of a claimed buffer instance, or null if none available.
   */
  async claimBufferInstance(): Promise<string | null> {
    const instances = this.db.getInstances();
    const bufferInst = Object.values(instances).find(
      i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped'
    );
    if (!bufferInst) return null;

    // Immediately rename so no other claim races for the same one
    bufferInst.assignedTo = 'LinuxClient';
    await this.db.saveInstance(bufferInst.instanceId, bufferInst);

    console.log(`[Scaling] Buffer instance ${bufferInst.instanceId} claimed for user.`);

    // Trigger pool reconciliation to launch a replacement
    setTimeout(() => this.reconcilePool(), 0);

    return bufferInst.instanceId;
  }

  // ── Terminate and permanently remove an instance ──────────────────────────
  /**
   * Physically destroys the EC2 instance on AWS and removes it from the DB.
   * Used by: admin delete button, fatal pre-warm errors, grace period expiry.
   */
  async terminateAndRemove(instanceId: string): Promise<void> {
    const inst = this.db.getInstance(instanceId);
    console.log(`[Scaling] terminateAndRemove called for instance ${instanceId}. Call stack:\n`, new Error().stack);
    if (!inst) {
      // Not in DB — attempt AWS termination anyway as best effort
      console.warn(`[Scaling] terminateAndRemove: ${instanceId} not found in DB. Attempting AWS termination anyway.`);
      try { await this.ec2Service.terminateInstance(instanceId); } catch {}
      this.activePrewarms.delete(instanceId);
      this.prewarmPhases.delete(instanceId);
      return;
    }

    console.log(`[Scaling] Terminating ${instanceId} (uuid=${instanceId})...`);
    inst.status = 'stopping';
    await this.db.saveInstance(instanceId, inst);

    try {
      await this.ec2Service.terminateInstance(instanceId);
      await this.db.deleteInstance(instanceId);
      this.activePrewarms.delete(instanceId);
      this.prewarmPhases.delete(instanceId);
      console.log(`[Scaling] ✓ Terminated and removed ${instanceId}.`);
    } catch (err: any) {
      console.error(`[Scaling] Failed to terminate ${instanceId}:`, err.message);
      // Remove from DB even if AWS call failed, to prevent stuck entries
      await this.db.deleteInstance(instanceId);
      this.activePrewarms.delete(instanceId);
      this.prewarmPhases.delete(instanceId);
    }
  }

  // ── Abort a prewarm instance (admin action) ───────────────────────────────
  /**
   * Immediately terminates a prewarm instance and triggers reconciliation.
   * Called by the admin "Прервать" button.
   */
  async abortPrewarm(instanceId: string): Promise<void> {
    console.log(`[Scaling] Admin aborted prewarm: ${instanceId}`);
    await this.terminateAndRemove(instanceId);
    // Trigger reconciliation to launch a replacement
    setTimeout(() => this.reconcilePool(), 0);
  }
}
