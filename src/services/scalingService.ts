import { EC2Service } from './ec2Service';
import { DatabaseService } from './databaseService';
import { TimeTrackerService } from './timeTrackerService';
import { SettingsService } from './settingsService';
import * as http  from 'http';
import * as https from 'https';
import WebSocket from 'ws';

// ── Labels ─────────────────────────────────────────────────────────────────
// These are stored in instance.assignedTo to distinguish pool roles from
// real user sessions (which use a custom name or 'OnDemand-XXXXXX').
export const PREWARM_LABEL = 'Prewarm';
export const BUFFER_LABEL  = 'Buffer';

// ── Configuration ──────────────────────────────────────────────────────────
// BUFFER_SIZE is no longer a hardcoded constant. It is read dynamically from
// SettingsService (settings.minBufferTarget) on every reconcile loop tick.
// Default fallback = 3 (matching the old hardcoded value).
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

  /** Map of instanceId → AbortController to cancel surplus prewarms. */
  private activePrewarmAbortControllers: Map<string, AbortController> = new Map();

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

  /** Sequential operation queue to serialize pool reconciliation and realignment. */
  private poolOperationChain: Promise<any> = Promise.resolve();

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

  /** Serializes async pool operations to eliminate concurrency races. */
  private async withPoolLock<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      console.log(`[Scaling] [Lock] Acquired pool lock for ${opName}`);
      try {
        return await fn();
      } finally {
        console.log(`[Scaling] [Lock] Released pool lock for ${opName}`);
      }
    };

    const nextPromise = this.poolOperationChain.then(run, run);
    this.poolOperationChain = nextPromise.catch(() => {});
    return nextPromise;
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
    return this.withPoolLock('reconcilePool', async () => {
      // ── Step 1: Read target settings from Dashboard ───────────────────────
      const settings = SettingsService.getInstance().getSettings();
      const baseTarget = settings.minBufferTarget ?? 0;
      const extraBoost = settings.lastExtraBoost ?? 0;

      // ── Step 2: AWS Sync — discover manually-created stopped LinuxClient ──
      try {
        const discoveryTag = process.env.EC2_DISCOVERY_TAG ?? 'LinuxClient';
        const discovered = await this.ec2Service.discoverInstancesByTag('Name', discoveryTag);
        const currentInstances = this.db.getInstances();

        for (const inst of discovered) {
          const existing = currentInstances[inst.uuid];
          if (!existing && inst.status === 'stopped') {
            inst.assignedTo = BUFFER_LABEL;
            await this.db.saveInstance(inst.uuid, inst);
            console.log(
              `[Scaling] AWS Sync: Absorbed untracked stopped instance ${inst.instanceId} into buffer pool.`
            );
          }
        }

        // Ghost purge: remove Buffer DB records whose instance no longer exists in AWS
        const discoveredIds = new Set(discovered.map(d => d.uuid));
        const dbInstances = this.db.getInstances();
        for (const [uuid, inst] of Object.entries(dbInstances)) {
          if (inst.assignedTo === BUFFER_LABEL && !discoveredIds.has(uuid) && !uuid.startsWith('i-mock')) {
            console.log(
              `[Scaling] Reconcile ghost purge: Buffer instance ${inst.instanceId} not found in AWS — removing stale DB record.`
            );
            await this.db.deleteInstance(uuid);
          }
        }
      } catch (syncErr: any) {
        console.warn(`[Scaling] Reconcile AWS sync error (non-fatal): ${syncErr.message}`);
      }

      // ── Step 3: Count current pool state ──────────────────────────────────
      const instances = this.db.getInstances();

      // Ready stopped buffers
      const bufferReady = Object.values(instances).filter(
        i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped'
      );

      // Healthy instances currently being recycled (status='stopping', assignedTo='Buffer')
      const recycling = Object.values(instances).filter(
        i => i.assignedTo === BUFFER_LABEL && i.status === 'stopping'
      );

      // Active user sessions
      const activeSessions = Object.values(instances).filter(
        i => i.assignedTo && i.assignedTo.startsWith('OnDemand-') && i.status === 'running'
      );

      // Re-adopt orphaned pre-warms from a previous server restart
      const reconciledPrewarms = Object.values(instances).filter(
        i => i.assignedTo === PREWARM_LABEL
      );

      for (const inst of reconciledPrewarms) {
        if (!this.activePrewarms.has(inst.instanceId)) {
          if (inst.managedByBackend !== true) {
            console.warn(
              `[Scaling] Skipping orphan re-adoption for ${inst.instanceId}: managedByBackend flag not set.`
            );
            continue;
          }
          console.log(`[Scaling] Reconciling orphaned prewarm instance: ${inst.instanceId}`);
          this.activePrewarms.add(inst.instanceId);
          const abortController = new AbortController();
          this.activePrewarmAbortControllers.set(inst.instanceId, abortController);
          this.waitForWarmupAndStop(inst.instanceId, abortController.signal).catch(err => {
            console.error(`[Scaling] Reconciled prewarm ${inst.instanceId} lifecycle error:`, err.message);
          }).finally(() => {
            this.activePrewarmAbortControllers.delete(inst.instanceId);
          });
        }
      }

      const prewarmCount = this.activePrewarms.size + this.launchingCount;
      const effectiveBuffer = bufferReady.length + recycling.length + prewarmCount;
      
      // Deficit: only triggers if protected Base reserve is penetrated
      const deficit = Math.max(0, baseTarget - effectiveBuffer);

      // Max allowed buffer capacity for the current active user count:
      // When users are active, they have consumed from Extra first; pool target is bounded below by Base.
      const maxAllowedBuffer = Math.max(baseTarget, baseTarget + extraBoost - activeSessions.length);

      // Surplus: buffer capacity exceeding the maximum allowed capacity for the current active sessions
      const surplus = Math.max(0, effectiveBuffer - maxAllowedBuffer);

      console.log(
        `[Scaling] Pool Audit: Ready=${bufferReady.length}, Recycling=${recycling.length}, Prewarming=${prewarmCount}, Active=${activeSessions.length} | ` +
        `Base=${baseTarget}, Extra=${extraBoost}, MaxAllowed=${maxAllowedBuffer} | EffectiveBuffer=${effectiveBuffer}, Deficit=${deficit}, Surplus=${surplus}`
      );

      // ── Step 4: Handle Deficit (Protected Base reserve penetrated) ─────────
      if (deficit > 0) {
        console.log(`[Scaling] Base reserve penetrated! Launching ${deficit} prewarm instance(s) to restore Base=${baseTarget}...`);
        const launches = Array.from({ length: deficit }, () => this.launchPrewarmInstance());
        await Promise.allSettled(launches);
        return;
      }

      // ── Step 5: Handle Surplus Prewarms (Active users left while replacement prewarm ran) ──
      if (surplus > 0 && this.activePrewarms.size > 0) {
        const toCancel = Math.min(surplus, this.activePrewarms.size);
        console.log(`[Scaling] Surplus prewarm detected: EffectiveBuffer (${effectiveBuffer}) > MaxAllowed (${maxAllowedBuffer}). Cancelling ${toCancel} surplus prewarm(s)...`);
        await this.cancelSurplusPrewarms(toCancel);
        return;
      }

      console.log(
        `[Scaling] Pool in balance (EffectiveBuffer=${effectiveBuffer}, Base=${baseTarget}, MaxAllowed=${maxAllowedBuffer}). No scaling action needed.`
      );
    });
  }

  /**
   * Safely cancels and terminates in-progress prewarm instances that have become surplus
   * because active user sessions ended and their instances recycled back to Buffer.
   */
  private async cancelSurplusPrewarms(surplusCount: number): Promise<number> {
    if (surplusCount <= 0 || this.activePrewarms.size === 0) return 0;
    const prewarmIds = Array.from(this.activePrewarms);
    const toCancel = prewarmIds.slice(0, surplusCount);
    console.log(`[Scaling] Identified ${toCancel.length} surplus prewarm instance(s) to cancel: ${toCancel.join(', ')}`);

    for (const instId of toCancel) {
      const controller = this.activePrewarmAbortControllers.get(instId);
      if (controller) {
        controller.abort();
        this.activePrewarmAbortControllers.delete(instId);
      }
      this.activePrewarms.delete(instId);
      this.prewarmPhases.delete(instId);
      await this.terminateAndRemove(instId);
      console.log(`[Scaling] Prewarm ${instId} successfully cancelled and terminated as surplus.`);
    }
    return toCancel.length;
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
        managedByBackend: true,
        ec2Config: {
          instanceType: 'g4dn.2xlarge',
          region: donor?.ec2Config?.region || 'eu-central-1',
          amiId,
          securityGroupId: securityGroupId || '',
          subnetId: subnetId || '',
        },
        activeSessions: new Map(),
      });

      const prewarmId = instanceId;
      this.activePrewarms.add(prewarmId);
      this.prewarmPhases.set(prewarmId, 1);  // Start at Phase 1: Boot
      const abortController = new AbortController();
      this.activePrewarmAbortControllers.set(prewarmId, abortController);

      // Run the lifecycle asynchronously — do NOT await here so reconcilePool returns
      this.waitForWarmupAndStop(prewarmId, abortController.signal).catch(err => {
        console.error(`[Scaling] Prewarm ${prewarmId} lifecycle error:`, err.message);
      }).finally(() => {
        this.activePrewarmAbortControllers.delete(prewarmId);
      });

    } catch (err: any) {
      console.error('[Scaling] Failed to launch prewarm instance:', err.message);
      if (instanceId) {
        this.activePrewarms.delete(instanceId);
        this.activePrewarmAbortControllers.delete(instanceId);
        this.prewarmPhases.delete(instanceId);
        TimeTrackerService.getInstance().stopRealTimer(instanceId);
        // Best-effort cleanup on AWS
        try { await this.ec2Service.terminateInstance(instanceId); } catch {}
        await this.db.deleteInstance(instanceId);
      }
    } finally {
      this.launchingCount--;
    }
  }

  // ── 5-Phase Pre-warm Lifecycle ────────────────────────────────────────────
  private async waitForWarmupAndStop(instanceId: string, abortSignal?: AbortSignal): Promise<void> {
    const tag = `[Scaling] Prewarm ${instanceId}`;

    const fatal = async (reason: string): Promise<void> => {
      console.error(`${tag} FATAL triggered! Reason: "${reason}". Call stack:\n`, new Error().stack);
      this.prewarmPhases.delete(instanceId);
      this.activePrewarms.delete(instanceId);
      this.activePrewarmAbortControllers.delete(instanceId);
      await this.terminateAndRemove(instanceId);
    };

    if (abortSignal?.aborted) {
      console.log(`${tag} Prewarm aborted before start. Exiting lifecycle.`);
      return;
    }

    // ── Phase 1: Boot — wait for AWS state = 'running' ────────────────────
    this.prewarmPhases.set(instanceId, 1);
    console.log(`${tag} Phase 1 BOOT: Waiting for ${instanceId} to reach 'running'...`);
    let booted = false;
    let publicIp: string | null = null;

    for (let i = 0; i < BOOT_MAX; i++) {
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 1 BOOT. Exiting lifecycle.`);
        return;
      }
      await sleep(POLL_MS);
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 1 BOOT. Exiting lifecycle.`);
        return;
      }
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`${tag} Phase 1 BOOT [${i + 1}/${BOOT_MAX}]: ${instanceId} → ${awsStatus.state}`);

        if (awsStatus.state === 'running') {
          publicIp = awsStatus.ip;
          const privateIp = awsStatus.privateIp;
          booted = true;
          console.log(`${tag} Phase 1 BOOT: ✓ ${instanceId} is running (public: ${publicIp}, private: ${privateIp})`);
          const inst = this.db.getInstance(instanceId);
          if (inst) {
            inst.status = 'running';
            inst.publicIp = publicIp || undefined;
            inst.privateIp = privateIp || undefined;
            await this.db.saveInstance(instanceId, inst);
            TimeTrackerService.getInstance().startRealTimer(instanceId);
          }
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
      if (abortSignal?.aborted) return;
      await fatal('Timed out waiting for instance to reach running state');
      return;
    }

    // ── Phase 2: Tunnel — Bypassed (Direct connection proxying) ─────────────
    this.prewarmPhases.set(instanceId, 2);
    console.log(`${tag} Phase 2 TUNNEL: Bypassed. Using direct IP for proxying.`);

    // ── Phase 3 & 4: Signal + Streamer — wait for UE5 streamer connection ──
    this.prewarmPhases.set(instanceId, 3);
    console.log(`${tag} Phase 3 SIGNAL: Waiting for signaling server & UE5 streamer...`);
    let signalingConfirmed = false;
    let serverAliveEver    = false;

    for (let i = 0; i < SIGNAL_MAX; i++) {
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 3 SIGNAL. Exiting lifecycle.`);
        return;
      }
      await sleep(POLL_MS);
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 3 SIGNAL. Exiting lifecycle.`);
        return;
      }

      const inst = this.db.getInstance(instanceId);
      if (!inst) {
        if (abortSignal?.aborted) {
          console.log(`${tag} Prewarm record removed via cancellation during signal wait. Exiting lifecycle.`);
          return;
        }
        await fatal('Instance disappeared from DB during signal wait');
        return;
      }
      const targetIp = inst.privateIp || inst.publicIp;
      const instanceUrl = `http://${targetIp}:8000`;

      const streamerStatus = await checkStreamerStatus(instanceUrl);
      console.log(
        `${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: ` +
        `Probing ${instanceUrl}/api/status → ${streamerStatus}`
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
        serverAliveEver = true;
        console.log(`${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: Server alive, streamer not yet connected. Waiting...`);
      } else {
        console.log(`${tag} Phase 3 SIGNAL [${i + 1}/${SIGNAL_MAX}]: Server unreachable via direct IP. Will retry...`);
      }
    }

    if (abortSignal?.aborted) {
      console.log(`${tag} Prewarm aborted after Phase 3. Exiting lifecycle.`);
      return;
    }

    if (!signalingConfirmed) {
      if (!serverAliveEver) {
        await fatal('Signaling server never responded — instance networking broken');
        return;
      }
      console.warn(
        `${tag} Phase 3 SIGNAL: Streamer did not confirm within timeout, but server was alive. Proceeding to stop.`
      );
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
      if (abortSignal?.aborted) return;
      await fatal(`Failed to issue stop command: ${err.message}`);
      return;
    }

    let stopped = false;
    for (let i = 0; i < STOP_MAX; i++) {
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 5 STOP. Exiting lifecycle.`);
        return;
      }
      await sleep(POLL_MS);
      if (abortSignal?.aborted) {
        console.log(`${tag} Prewarm aborted during Phase 5 STOP. Exiting lifecycle.`);
        return;
      }
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
          this.activePrewarmAbortControllers.delete(instanceId);
          return;
        }
      } catch (err: any) {
        console.warn(`${tag} Phase 5 STOP poll error: ${err.message}`);
      }
    }

    if (!stopped) {
      if (abortSignal?.aborted) return;
      await fatal('Timed out waiting for instance to stop');
      return;
    }

    // ── Success: move to Buffer pool ─────────────────────────────────────
    const finalInst = this.db.getInstance(instanceId);
    if (finalInst) {
      finalInst.status = 'stopped';
      finalInst.assignedTo = BUFFER_LABEL;
      finalInst.streamerConnected = false;
      await this.db.saveInstance(instanceId, finalInst);
      TimeTrackerService.getInstance().stopRealTimer(instanceId);
    }
    this.activePrewarms.delete(instanceId);
    this.activePrewarmAbortControllers.delete(instanceId);
    this.prewarmPhases.delete(instanceId);
    console.log(`${tag} ✅ Successfully moved to buffer pool. assignedTo=Buffer, status=stopped.`);
  }

  // ── Claim a buffer instance for a real user ───────────────────────────────
  /**
   * Reserves a stopped Buffer instance for a user.
   * Does NOT trigger pool reconciliation until confirmed via confirmBufferClaim.
   * This prevents premature replacement prewarm launches if AWS startInstance fails.
   */
  async claimBufferInstance(excludedIds: string[] = []): Promise<string | null> {
    const instances = this.db.getInstances();
    const excludeSet = new Set(excludedIds);
    const bufferInst = Object.values(instances).find(
      i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped' && !excludeSet.has(i.instanceId)
    );
    if (!bufferInst) return null;

    const remainingReady = Object.values(instances).filter(
      i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped' && i.instanceId !== bufferInst.instanceId
    ).length;

    const settings = SettingsService.getInstance().getSettings();
    const baseTarget = settings.minBufferTarget ?? 0;
    const extraBoost = settings.lastExtraBoost ?? 0;
    const isBasePenetrated = remainingReady < baseTarget;

    // Immediately rename so no other claim races for the same one
    bufferInst.assignedTo = 'Claimed';
    await this.db.saveInstance(bufferInst.instanceId, bufferInst);

    console.log(
      `[Scaling] Buffer instance ${bufferInst.instanceId} reserved for user. ` +
      `Remaining stopped: ${remainingReady} | Base target: ${baseTarget}, Extra target: ${extraBoost}. ` +
      `Claim Type: ${isBasePenetrated ? 'PROTECTED BASE RESERVE CONSUMED (Replacement prewarm needed)' : 'EXPENDABLE EXTRA CAPACITY CONSUMED (No prewarm needed)'}.`
    );
    return bufferInst.instanceId;
  }

  /**
   * Confirms that a claimed buffer instance was successfully started on AWS.
   * Triggers pool reconciliation to launch a replacement prewarm instance if Base is penetrated.
   */
  async confirmBufferClaim(instanceId: string): Promise<void> {
    console.log(`[Scaling] Buffer claim confirmed for ${instanceId}. Triggering pool reconciliation check...`);
    setTimeout(() => this.reconcilePool(), 0);
  }

  /**
   * Rolls back a buffer claim when AWS startInstance fails or returns an ambiguous result.
   */
  async rollbackBufferClaim(instanceId: string, hostToken?: string, error?: any): Promise<void> {
    console.warn(`[Scaling] Rolling back buffer claim for ${instanceId}. Reason: ${error?.message || 'unknown'}`);
    const instance = this.db.getInstance(instanceId);
    if (!instance) return;

    if (hostToken) {
      instance.activeSessions.delete(hostToken);
    }

    let realState = 'unknown';
    let publicIp: string | null = null;
    let privateIp: string | null = null;
    try {
      const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
      realState = awsStatus.state;
      publicIp = awsStatus.ip;
      privateIp = awsStatus.privateIp;
    } catch (queryErr: any) {
      const queryMsg = (queryErr?.message || '').toLowerCase();
      if (queryMsg.includes('notfound') || queryMsg.includes('does not exist') || queryMsg.includes('invalidinstanceid')) {
        realState = 'not-found';
      }
    }

    console.log(`[Scaling] Rollback inspection for ${instanceId}: AWS realState='${realState}' (error was: ${error?.message})`);

    if (realState === 'stopped') {
      instance.status = 'stopped';
      instance.assignedTo = BUFFER_LABEL;
      await this.db.saveInstance(instanceId, instance);
      console.log(`[Scaling] Buffer instance ${instanceId} confirmed stopped on AWS — returned to buffer pool.`);
    } else if (realState === 'pending' || realState === 'running') {
      console.warn(`[Scaling] Ambiguous start: ${instanceId} is actually '${realState}' on AWS. Issuing stop command...`);
      instance.status = 'stopping';
      instance.assignedTo = BUFFER_LABEL;
      instance.publicIp = publicIp || instance.publicIp;
      instance.privateIp = privateIp || instance.privateIp;
      await this.db.saveInstance(instanceId, instance);

      try {
        await this.ec2Service.stopInstance(instanceId);
      } catch (stopErr: any) {
        console.error(`[Scaling] Failed to issue stop for ambiguous instance ${instanceId}:`, stopErr.message);
      }
      setTimeout(() => this.reconcilePool(), 0);
    } else if (realState === 'terminated' || realState === 'shutting-down' || realState === 'not-found') {
      console.error(`[Scaling] Claimed instance ${instanceId} is '${realState}' on AWS. Terminating & purging DB record.`);
      await this.terminateAndRemove(instanceId);
      setTimeout(() => this.reconcilePool(), 0);
    } else {
      console.warn(`[Scaling] AWS status unreachable for ${instanceId}. Marking status='stopping' to prevent unsafe claim.`);
      instance.status = 'stopping';
      instance.assignedTo = BUFFER_LABEL;
      await this.db.saveInstance(instanceId, instance);
      setTimeout(() => this.reconcilePool(), 0);
    }
  }

  // ── Recycle healthy completed instance back to Buffer pool ───────────────
  /**
   * Gracefully stops a healthy user instance upon session exit and returns it to Buffer.
   * Preserves the warm EBS volume and persistent Vulkan/PSO shader caches.
   */
  async recycleInstanceToBuffer(instanceId: string): Promise<void> {
    const inst = this.db.getInstance(instanceId);
    if (!inst) {
      console.warn(`[Scaling] [Recycle] ${instanceId} not found in DB.`);
      return;
    }

    console.log(`[Scaling] [Recycle] Initiating recycling for healthy instance ${instanceId}...`);
    TimeTrackerService.getInstance().stopRealTimer(instanceId);
    TimeTrackerService.getInstance().stopDisplayTimer(instanceId);

    // Clean session ownership immediately
    inst.activeSessions.clear();
    inst.assignedTo = BUFFER_LABEL;
    inst.status = 'stopping';
    inst.streamerConnected = false;
    await this.db.saveInstance(instanceId, inst);

    // Trigger reconciliation so pool accounts for this instance as recycling (R_stopping)
    setTimeout(() => this.reconcilePool(), 0);

    // Issue EC2 stop command
    try {
      console.log(`[Scaling] [Recycle] Sending StopInstances for ${instanceId}...`);
      await this.ec2Service.stopInstance(instanceId);
    } catch (err: any) {
      console.error(`[Scaling] [Recycle] Failed to issue stop for ${instanceId}:`, err.message);
      // Fallback: terminate if stop failed to prevent stuck instance
      await this.terminateAndRemove(instanceId);
      setTimeout(() => this.reconcilePool(), 0);
      return;
    }

    // Monitor asynchronously until stopped
    this.waitForRecycleStop(instanceId).catch(err => {
      console.error(`[Scaling] [Recycle] Error waiting for ${instanceId} to stop:`, err.message);
    });
  }

  private async waitForRecycleStop(instanceId: string): Promise<void> {
    const tag = `[Scaling] [Recycle] ${instanceId}`;
    let stopped = false;

    for (let i = 0; i < STOP_MAX; i++) {
      await sleep(POLL_MS);
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`${tag} STOP poll [${i + 1}/${STOP_MAX}]: ${instanceId} → ${awsStatus.state}`);

        if (awsStatus.state === 'stopped') {
          stopped = true;
          break;
        }
        if (awsStatus.state === 'terminated' || awsStatus.state === 'shutting-down') {
          console.error(`${tag} Instance terminated unexpectedly while stopping.`);
          await this.db.deleteInstance(instanceId);
          setTimeout(() => this.reconcilePool(), 0);
          return;
        }
      } catch (err: any) {
        console.warn(`${tag} STOP poll error: ${err.message}`);
      }
    }

    if (!stopped) {
      console.error(`${tag} Timed out waiting for instance to reach 'stopped'. Terminating.`);
      await this.terminateAndRemove(instanceId);
      setTimeout(() => this.reconcilePool(), 0);
      return;
    }

    // Check pool capacity against combined target
    const settings = SettingsService.getInstance().getSettings();
    const baseTarget = settings.minBufferTarget ?? 0;
    const extraBoost = settings.lastExtraBoost ?? 0;
    const maxDesiredPool = baseTarget + extraBoost;

    const allInstances = this.db.getInstances();
    const currentStoppedBufferCount = Object.values(allInstances).filter(
      i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped' && i.instanceId !== instanceId
    ).length;

    const finalInst = this.db.getInstance(instanceId);
    if (!finalInst) return;

    if (maxDesiredPool > 0 && currentStoppedBufferCount >= maxDesiredPool) {
      console.log(
        `${tag} Pool is full (${currentStoppedBufferCount} ready >= max target ${maxDesiredPool}). ` +
        `Terminating surplus recycled instance.`
      );
      await this.terminateAndRemove(instanceId);
    } else {
      finalInst.status = 'stopped';
      finalInst.assignedTo = BUFFER_LABEL;
      finalInst.streamerConnected = false;
      await this.db.saveInstance(instanceId, finalInst);
      console.log(
        `${tag} ✅ Recycled instance confirmed stopped on AWS — returned to buffer pool. ` +
        `Total ready buffer: ${currentStoppedBufferCount + 1}.`
      );
    }

    // Trigger reconciliation to re-evaluate prewarm demand and cancel any redundant prewarm
    setTimeout(() => this.reconcilePool(), 0);
  }

  // ── Terminate and permanently remove an instance ──────────────────────────
  async terminateAndRemove(instanceId: string): Promise<void> {
    const inst = this.db.getInstance(instanceId);
    console.log(`[Scaling] terminateAndRemove called for instance ${instanceId}. Call stack:\n`, new Error().stack);
    TimeTrackerService.getInstance().stopRealTimer(instanceId);
    TimeTrackerService.getInstance().stopDisplayTimer(instanceId);
    this.activePrewarms.delete(instanceId);
    this.activePrewarmAbortControllers.delete(instanceId);
    this.prewarmPhases.delete(instanceId);

    if (!inst) {
      console.warn(`[Scaling] terminateAndRemove: ${instanceId} not found in DB. Attempting AWS termination anyway.`);
      try { await this.ec2Service.terminateInstance(instanceId); } catch {}
      return;
    }

    console.log(`[Scaling] Terminating ${instanceId} (uuid=${instanceId})...`);
    inst.status = 'stopping';
    await this.db.saveInstance(instanceId, inst);

    try {
      await this.ec2Service.terminateInstance(instanceId);
      await this.db.deleteInstance(instanceId);
      console.log(`[Scaling] ✓ Terminated and removed ${instanceId}.`);
    } catch (err: any) {
      console.error(`[Scaling] Failed to terminate ${instanceId}:`, err.message);
      await this.db.deleteInstance(instanceId);
    }
  }

  // ── Re-align pool on-demand (admin "Apply & Re-align" button) ────────────
  async realignPool(baseTarget: number, extraBoost: number): Promise<{
    launched:        number;
    terminated:      number;
    skippedPrewarms: number;
    combinedTarget:  number;
  }> {
    return this.withPoolLock('realignPool', async () => {
      await SettingsService.getInstance().save({ minBufferTarget: baseTarget, lastExtraBoost: extraBoost });
      console.log(`[Scaling] realignPool: baseTarget=${baseTarget}, extraBoost=${extraBoost} saved to settings.`);

      const instances = this.db.getInstances();
      const bufferInstances = Object.values(instances).filter(
        i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped'
      );
      const recyclingInstances = Object.values(instances).filter(
        i => i.assignedTo === BUFFER_LABEL && i.status === 'stopping'
      );
      const activeSessions = Object.values(instances).filter(
        i => i.assignedTo && i.assignedTo.startsWith('OnDemand-') && i.status === 'running'
      );
      const bufferCount  = bufferInstances.length;
      const prewarmCount = this.activePrewarms.size + this.launchingCount;
      const currentTotal = bufferCount + recyclingInstances.length + prewarmCount;
      const combinedTarget = Math.max(baseTarget, baseTarget + extraBoost - activeSessions.length);
      const delta          = combinedTarget - currentTotal;

      console.log(
        `[Scaling] realignPool: combinedTarget=${combinedTarget} (Base=${baseTarget}, Extra=${extraBoost}, Active=${activeSessions.length}), ` +
        `bufferCount=${bufferCount}, recyclingCount=${recyclingInstances.length}, prewarmCount=${prewarmCount}, delta=${delta}`
      );

      let launched        = 0;
      let terminated      = 0;
      let skippedPrewarms = 0;

      if (delta > 0) {
        const launches = Array.from({ length: delta }, () => this.launchPrewarmInstance());
        await Promise.allSettled(launches);
        launched = delta;
        console.log(`[Scaling] realignPool: launched ${launched} prewarm instance(s).`);
      } else if (delta < 0) {
        const surplus = Math.abs(delta);
        // First cancel any active prewarms
        const cancelledPrewarms = await this.cancelSurplusPrewarms(surplus);
        const remainingSurplus = surplus - cancelledPrewarms;

        // Then terminate stopped buffers if still surplus
        const canTerminate = Math.min(remainingSurplus, bufferCount);
        skippedPrewarms = remainingSurplus - canTerminate;

        const toTerminate = bufferInstances
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, canTerminate);

        await Promise.allSettled(toTerminate.map(i => this.terminateAndRemove(i.instanceId)));
        terminated = canTerminate;
        console.log(`[Scaling] realignPool: cancelled ${cancelledPrewarms} prewarms, terminated ${terminated} Buffer instance(s).`);
      }

      return { launched, terminated, skippedPrewarms, combinedTarget };
    });
  }

  // ── Abort a prewarm instance (admin action) ───────────────────────────────
  async abortPrewarm(instanceId: string): Promise<void> {
    console.log(`[Scaling] Admin aborted prewarm: ${instanceId}`);
    const controller = this.activePrewarmAbortControllers.get(instanceId);
    if (controller) {
      controller.abort();
      this.activePrewarmAbortControllers.delete(instanceId);
    }
    this.activePrewarms.delete(instanceId);
    this.prewarmPhases.delete(instanceId);
    await this.terminateAndRemove(instanceId);
    setTimeout(() => this.reconcilePool(), 0);
  }
}

