import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { DatabaseService } from './databaseService';
import { TimeTrackerService } from './timeTrackerService';
import { EC2Service } from './ec2Service';
import { DisplayStartData, HeartbeatData } from '../types/websocket.types';
import { randomUUID } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import WebSocket from 'ws';
import { ScalingService, PREWARM_LABEL, BUFFER_LABEL } from './scalingService';
import { config } from '../config';
import { SettingsService } from './settingsService';
import { InstanceWithSessions, Session } from '../types/instance.types';


export class WebSocketService {
  private io: SocketServer;
  private db: DatabaseService;
  private timeTracker: TimeTrackerService;
  private ec2Service: EC2Service;

  // socketId → { instanceUuid, hostToken } — for fast disconnect lookups
  private socketToSession: Map<string, { instanceUuid: string; hostToken: string }> = new Map();

  // socketId → interval — heartbeat watchdog timers
  private heartbeatMonitors: Map<string, NodeJS.Timeout> = new Map();

  // instanceUuid → timeout — 15s flicker resilience delay timers
  private flickerTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(server: HttpServer) {
    this.io = new SocketServer(server, {
      cors: {
        origin: true,           // Allow any origin (EC2 IP will differ per instance)
        credentials: true,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
      },
      pingTimeout: 30000,
      pingInterval: 25000,
    });
    this.db = DatabaseService.getInstance();
    this.timeTracker = TimeTrackerService.getInstance();
    this.ec2Service = new EC2Service();

    this.startSessionCleanupLoop();
    this.setupHandlers();
  }

  // ── Helper: Cancel any pending 15s flicker delay for an instance ────────────
  private cancelFlickerTimer(instanceUuid: string): void {
    const timer = this.flickerTimers.get(instanceUuid);
    if (timer) {
      clearTimeout(timer);
      this.flickerTimers.delete(instanceUuid);
      console.log(`[WS] Cancelled flicker recovery timer for ${instanceUuid}`);
    }
  }

  // ── Helper: Check whether an instance has ANY active connected socket ──────
  private hasActiveSockets(instance: InstanceWithSessions): boolean {
    return Array.from(instance.activeSessions.values()).some(s => {
      if (Array.isArray(s.socketIds) && s.socketIds.length > 0) {
        return s.socketIds.some(id => this.io.sockets.sockets.get(id)?.connected === true);
      }
      if (s.socketId) {
        return this.io.sockets.sockets.get(s.socketId)?.connected === true;
      }
      return false;
    });
  }

  // ── Helper: Check whether a session currently has an active streaming player ──
  private isSessionCurrentlyStreaming(session: Session, excludeSocketId?: string): boolean {
    if (!session.displayStarted) return false;
    if (Array.isArray(session.socketIds)) {
      const activeSockets = session.socketIds.filter(id => id !== excludeSocketId);
      if (activeSockets.length > 0) {
        return activeSockets.some(id => this.io.sockets.sockets.get(id)?.connected === true);
      }
    } else if (session.socketId && session.socketId !== excludeSocketId) {
      return this.io.sockets.sockets.get(session.socketId)?.connected === true;
    }
    return false;
  }

  // ── Session garbage collector ──────────────────────────────────────────────
  // Handles "user closed page before redirect" — the /connect API creates a
  // session but NO socket ever arrives (so no socket 'disconnect' fires).
  // We detect this and start the grace period to prevent orphaned servers.
  private startSessionCleanupLoop(): void {
    const NO_SOCKET_STALE_MS = 60 * 1000;       // 60 s: session created but socket never joined
    const GHOST_STALE_THRESHOLD = 5 * 60 * 1000;  // 5 min: classic ghost cleanup

    setInterval(async () => {
      const instances = this.db.getInstances();
      const now = Date.now();
      let totalPurged = 0;

      for (const [uuid, instance] of Object.entries(instances)) {
        // ── CRITICAL GUARD: Never touch pool-managed instances ──────────────
        // Prewarm instances are running with NO active sessions by design.
        // Buffer instances are stopped with NO active sessions by design.
        // The watchdog must NEVER start a grace period on either.
        if (instance.assignedTo === PREWARM_LABEL || instance.assignedTo === BUFFER_LABEL) {
          continue;
        }

        // Only care about active (non-stopped) instances
        if (instance.status === 'stopped' || instance.status === 'stopping') continue;

        let instanceChanged = false;

        // Step 1: Purge ancient ghost sessions (no socket, not seen recently)
        for (const [token, session] of instance.activeSessions.entries()) {
          const hasSockets = (Array.isArray(session.socketIds) && session.socketIds.length > 0) || !!session.socketId;
          if (!hasSockets && (now - session.lastSeenAt > GHOST_STALE_THRESHOLD)) {
            instance.activeSessions.delete(token);
            instanceChanged = true;
            totalPurged++;
          }
        }

        // Step 2: Detect "closed before redirect" — sessions that were created
        //         recently but have no socket and have been abandoned.
        const hasAnySocket = this.hasActiveSockets(instance);
        const hasAnyActiveDisplay = Array.from(instance.activeSessions.values()).some(s => s.displayStarted);

        if (!hasAnySocket && !hasAnyActiveDisplay) {
          const allSessionsAbandoned =
            instance.activeSessions.size === 0 ||
            Array.from(instance.activeSessions.values()).every(s => {
              const hasSockets = (Array.isArray(s.socketIds) && s.socketIds.length > 0) || !!s.socketId;
              return !hasSockets && (now - s.lastSeenAt > NO_SOCKET_STALE_MS);
            });

          if (allSessionsAbandoned && !this.timeTracker.hasGracePeriod(uuid)) {
            console.log(`[WS] Watchdog: Instance ${uuid} (${instance.assignedTo}) is ${instance.status} with no active sockets. Starting grace period.`);
            this.startGracePeriod(uuid);
          }
        }

        if (instanceChanged) {
          await this.db.saveInstance(uuid, instance);
        }
      }

      if (totalPurged > 0) {
        console.log(`[WS] GC: Purged ${totalPurged} stale ghost sessions.`);
      }
    }, 30000); // Check every 30 seconds
  }

  // ── Socket event handlers ──────────────────────────────────────────────────
  private setupHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log(`[WS] Client connected: ${socket.id}`);

      socket.on('join-instance', (instanceUuid: string) => {
        socket.join(`instance:${instanceUuid}`);
        console.log(`[WS] Socket ${socket.id} joined instance room ${instanceUuid}`);
      });

      socket.on('display-start', async (data: DisplayStartData) => {
        await this.handleDisplayStart(socket, data);
      });

      socket.on('request-instance', async (data: { hostToken?: string; deviceId?: string }) => {
        await this.handleRequestInstance(socket, data.hostToken, data.deviceId);
      });

      socket.on('resume-instance', async (data: { instanceUuid: string; hostToken: string; deviceId?: string }) => {
        await this.handleResumeInstance(socket, data.instanceUuid, data.hostToken, data.deviceId);
      });

      socket.on('heartbeat', async (data: HeartbeatData) => {
        await this.handleHeartbeat(socket, data);
      });

      // Explicit disconnect sent by the player page (tab close, navigation away)
      socket.on('player-disconnect', async (data: { instanceUuid: string; hostToken: string }) => {
        await this.handlePlayerDisconnect(socket, data.instanceUuid, data.hostToken);
      });

      // Explicit cancellation sent by the launcher loading page (user clicks "Вернуться назад")
      socket.on('cancel-request', async (data?: { instanceUuid?: string; hostToken?: string }) => {
        const mapping = this.socketToSession.get(socket.id);
        const uuid = data?.instanceUuid || mapping?.instanceUuid;
        const token = data?.hostToken || mapping?.hostToken;
        if (uuid && token) {
          console.log(`[WS] User explicitly cancelled loading request for instance ${uuid}`);
          await this.handlePlayerDisconnect(socket, uuid, token);
        }
      });

      socket.on('disconnect', async () => {
        await this.handleSocketDisconnect(socket);
      });

      // ── Auto-Resume / Reconnect Check ──
      socket.on('check-active-session', async (data: { deviceId: string; hostToken?: string }) => {
        const instances = this.db.getInstances();
        for (const [uuid, inst] of Object.entries(instances)) {
          if (inst.status === 'stopped' || inst.status === 'stopping' || inst.status === 'terminated') continue;
          const sessions = Array.from(inst.activeSessions.values());
          const match = sessions.find(s => s.deviceId === data.deviceId);
          if (match) {
            // Check if this is the exact same tab reconnecting
            const isSameTab = data.hostToken && data.hostToken === match.hostToken;
            if (!isSameTab && this.isSessionCurrentlyStreaming(match, socket.id)) {
              console.log(`[WS] Second tab blocked from auto-resume: device ${data.deviceId.substring(0, 8)} already has an active streaming player on ${uuid}`);
              socket.emit('session-in-use', {
                uuid,
                message: '3D-комната уже открыта в другой вкладке.'
              });
              return;
            }

            console.log(`[WS] Active session found for device ${data.deviceId.substring(0, 8)} on ${uuid} (isSameTab=${!!isSameTab})`);
            socket.emit('session-found', {
              uuid,
              hostToken: match.hostToken,
              status: inst.status
            });
            return;
          }
        }
        socket.emit('session-not-found');
      });
    });
  }

  // ── Handle request-instance ────────────────────────────────────────────────
  private async handleRequestInstance(socket: Socket, clientToken?: string, deviceId?: string): Promise<void> {
    const instances = this.db.getInstances();

    // 1. RECOGNIZE USER BY DEVICE ID (Recovery / Multi-Tab Recognition)
    if (deviceId) {
      for (const [uuid, inst] of Object.entries(instances)) {
        if (inst.status === 'stopped' || inst.status === 'stopping' || inst.status === 'terminated') continue;

        const sessions = Array.from(inst.activeSessions.values());
        const matchedSession = sessions.find(s => s.deviceId === deviceId);

        if (matchedSession) {
          const isSameTab = clientToken && clientToken === matchedSession.hostToken;
          if (!isSameTab && this.isSessionCurrentlyStreaming(matchedSession, socket.id)) {
            console.log(`[WS] Second-tab blocked because an active player already exists: device ${deviceId.substring(0, 8)} on ${uuid}`);
            socket.emit('session-in-use', {
              uuid,
              message: '3D-комната уже открыта в другой вкладке.'
            });
            return;
          }

          console.log(`[WS] Recon/Rescue: Device ${deviceId.substring(0, 8)}... recognized for instance ${uuid} (isSameTab=${!!isSameTab})`);
          if (this.timeTracker.hasGracePeriod(uuid)) {
            this.timeTracker.cancelGracePeriod(uuid);
          }
          this.cancelFlickerTimer(uuid);

          const finalHostToken = matchedSession.hostToken || (clientToken || randomUUID());

          // Track this new socket in the session without destroying other active sockets
          if (!Array.isArray(matchedSession.socketIds)) matchedSession.socketIds = [];
          if (!matchedSession.socketIds.includes(socket.id)) {
            matchedSession.socketIds.push(socket.id);
          }
          matchedSession.socketId = socket.id;
          matchedSession.lastSeenAt = Date.now();
          await this.db.saveInstance(uuid, inst);

          socket.join(`instance:${uuid}`);
          this.socketToSession.set(socket.id, { instanceUuid: uuid, hostToken: finalHostToken });
          socket.emit('instance-assigned', { uuid, hostToken: finalHostToken, rescued: true });
          this.startAwsStatusPoll(socket, uuid, finalHostToken);
          return;
        }
      }
    }

    // 2. Try to claim an existing stopped instance from the buffer pool
    const hostToken = clientToken || randomUUID();
    const attemptedBufferIds: string[] = [];

    while (true) {
      let claimedInstanceId: string | null = null;
      try {
        claimedInstanceId = await ScalingService.getInstance().claimBufferInstance(attemptedBufferIds);
      } catch (e: any) {
        console.warn(`[WS] claimBufferInstance failed: ${e.message}`);
      }

      if (!claimedInstanceId) {
        if (attemptedBufferIds.length > 0) {
          console.warn(`[WS] [Buffer-Claim] All ${attemptedBufferIds.length} candidate Ready Buffer(s) failed StartInstances: [${attemptedBufferIds.join(', ')}]. Exhausted all available buffers.`);
        }
        break;
      }

      attemptedBufferIds.push(claimedInstanceId);
      console.log(`[WS] [Buffer-Claim] Selected buffer instance ${claimedInstanceId} (attempt #${attemptedBufferIds.length})`);

      const instance = this.db.getInstance(claimedInstanceId);
      if (!instance) {
        console.warn(`[WS] [Buffer-Claim] Claimed instance ${claimedInstanceId} not found in DB.`);
        continue;
      }

      instance.status = 'pending';
      instance.assignedTo = `OnDemand-${claimedInstanceId.substring(2, 8)}`;
      instance.activeSessions.set(hostToken, {
        hostToken,
        lastSeenAt: Date.now(),
        displayStarted: false,
        socketId: socket.id,
        socketIds: [socket.id],
        ipAddress: socket.handshake.address,
        deviceId: deviceId,
      });
      await this.db.saveInstance(claimedInstanceId, instance);

      try {
        console.log(`[WS] [Buffer-Claim] Waking up buffer instance ${claimedInstanceId}...`);
        await this.ec2Service.startInstance(claimedInstanceId);

        // Confirm buffer claim now that AWS startInstance succeeded
        await ScalingService.getInstance().confirmBufferClaim(claimedInstanceId);

        // Immediately re-write status='pending' after startInstance confirms.
        // The dashboard polls every few seconds; without this second save the
        // DB can briefly show 'stopped' (from the buffer state) if the poll
        // hits between the claim write and the first AWS status-poll update.
        instance.status = 'pending';
        await this.db.saveInstance(claimedInstanceId, instance);
        console.log(`[WS] [Buffer-Claim] Buffer instance ${claimedInstanceId} start confirmed — status set to pending.`);

        // Join the room for status updates
        socket.join(`instance:${claimedInstanceId}`);

        this.socketToSession.set(socket.id, { instanceUuid: claimedInstanceId, hostToken });
        socket.emit('instance-assigned', { uuid: claimedInstanceId, hostToken, rescued: false });

        // Start status polling
        this.startAwsStatusPoll(socket, claimedInstanceId, hostToken);
        return;
      } catch (err: any) {
        console.error(`[WS] [Buffer-Claim] Failed to wake up claimed buffer instance ${claimedInstanceId}:`, err.message);
        this.socketToSession.delete(socket.id);
        await ScalingService.getInstance().rollbackBufferClaim(claimedInstanceId, hostToken, err);
        console.log(`[WS] [Buffer-Claim] Rollback complete for ${claimedInstanceId}. Checking if another Ready Buffer is available...`);
      }
    }

    if (attemptedBufferIds.length > 0) {
      // All candidate ready buffers in the pool failed to start (e.g. AWS capacity shortage in their AZ).
      // Return user-friendly error message without exposing raw English AWS error.
      socket.emit('instance-error', { 
        message: 'Сервер временно недоступен. Пожалуйста, попробуйте снова через несколько секунд.' 
      });
      return;
    }

    // 3. Fallback: Spawn a fresh On-Demand instance dynamically
    const targetUuid = randomUUID();

    try {
      console.log('[WS On-Demand] Resolving LinuxClientAMI...');
      const amiId = await this.ec2Service.getAmiIdByName('LinuxClientAMI');

      // Discover network config from any existing active instances
      const existingInst = Object.values(instances).find(inst => inst.ec2Config?.subnetId && inst.ec2Config?.securityGroupId);
      let subnetId = config.AWS_SUBNET_ID;
      let securityGroupId = config.AWS_SECURITY_GROUP_ID;

      if (existingInst && existingInst.ec2Config) {
        subnetId = existingInst.ec2Config.subnetId;
        securityGroupId = existingInst.ec2Config.securityGroupId;
        console.log(`[WS On-Demand] Dynamically cloning configuration from existing instance ${existingInst.instanceId}: Subnet=${subnetId}, SecurityGroup=${securityGroupId}`);
      }

      console.log(`[WS On-Demand] Spawning EC2 instance with AMI ${amiId}...`);
      const { instanceId } = await this.ec2Service.createInstance('g4dn.2xlarge', amiId, subnetId, securityGroupId);
      console.log(`[WS On-Demand] EC2 instance created: ${instanceId}`);

      const targetInstance = {
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

      targetInstance.activeSessions.set(hostToken, {
        hostToken,
        lastSeenAt: Date.now(),
        displayStarted: false,
        socketId: socket.id,
        socketIds: [socket.id],
        ipAddress: socket.handshake.address,
        deviceId: deviceId,
      });

      await this.db.saveInstance(instanceId, targetInstance);

      // Join the room for status updates
      socket.join(`instance:${instanceId}`);

      this.socketToSession.set(socket.id, { instanceUuid: instanceId, hostToken });
      socket.emit('instance-assigned', { uuid: instanceId, hostToken, rescued: false });

      // Start status polling
      this.startAwsStatusPoll(socket, instanceId, hostToken);

    } catch (err: any) {
      const errMsg = err.message || 'AWS Spawn Failed';
      console.error('[WS On-Demand] Spawn failed:', errMsg);
      socket.emit('instance-error', { 
        message: 'Сервер временно недоступен. Пожалуйста, попробуйте снова через несколько секунд.' 
      });
    }

  }

  // ── Handle resume-instance ──────────────────────────────────────────────────
  private async handleResumeInstance(socket: Socket, uuid: string, hostToken: string, deviceId?: string): Promise<void> {
    const instance = this.db.getInstance(uuid);
    if (!instance || instance.status === 'stopped' || instance.status === 'stopping' || instance.status === 'terminated') {
      socket.emit('instance-error', { 
        message: 'Сессия завершена или сервер остановлен. Пожалуйста, войдите снова.' 
      });
      return;
    }

    // Device Enforcement: Verify seeker matches occupant
    const existingSession = instance.activeSessions.get(hostToken);
    if (existingSession && deviceId && existingSession.deviceId && existingSession.deviceId !== deviceId) {
      console.warn(`[WS] Hijack attempt blocked: Device ${deviceId.substring(0, 8)}... tried to resume instance ${uuid} belonging to ${existingSession.deviceId?.substring(0, 8)}...`);
      socket.emit('instance-error', { 
        message: 'Этот сервер зарезервирован для другого устройства.' 
      });
      return;
    }

    const isSameTab = existingSession && existingSession.hostToken === hostToken;
    if (!isSameTab && existingSession && this.isSessionCurrentlyStreaming(existingSession, socket.id)) {
      console.log(`[WS] Second-tab blocked in resume-instance because an active player already exists: device ${deviceId?.substring(0, 8)} on ${uuid}`);
      socket.emit('session-in-use', {
        uuid,
        message: '3D-комната уже открыта в другой вкладке.'
      });
      return;
    }

    // Cancel flicker recovery and grace period immediately on user reconnection
    this.cancelFlickerTimer(uuid);
    if (this.timeTracker.hasGracePeriod(uuid)) {
      console.log(`[WS] FORCE CANCEL grace period for ${uuid} due to explicit resume-instance`);
      this.timeTracker.cancelGracePeriod(uuid);
    }

    // Track this socket in the session
    if (existingSession) {
      if (!Array.isArray(existingSession.socketIds)) existingSession.socketIds = [];
      if (!existingSession.socketIds.includes(socket.id)) {
        existingSession.socketIds.push(socket.id);
      }
      existingSession.socketId = socket.id;
      existingSession.lastSeenAt = Date.now();
      await this.db.saveInstance(uuid, instance);
    }

    // Join the room for status updates
    socket.join(`instance:${uuid}`);

    this.socketToSession.set(socket.id, { instanceUuid: uuid, hostToken });

    if (instance.status === 'pending' || instance.status === 'running') {
      this.timeTracker.cancelGracePeriod(uuid); // Double-down for safety
      this.startAwsStatusPoll(socket, uuid, hostToken);
    } else {
      socket.emit('instance-status', { status: instance.status, lastError: (instance as any).lastError });
    }
  }

  // ── AWS Status Polling for Redirect ───────────────────────────────────────
  private startAwsStatusPoll(socket: Socket, uuid: string, hostToken: string) {
    let checkCount = 0;
    let bootWaitCount = 0;
    let streamerWaitCount = 0;
    let consecutiveErrorCount = 0;
    let isStabilizing = false;
    let isServerReadyEmitted = false;
    let isChecking = false;

    const pollStartTime = Date.now();
    const tokenTag = hostToken.substring(0, 8);
    const MAX_POLL_DURATION_MS = 4 * 60 * 1000;    // 4 minutes hard wall-clock ceiling
    const MAX_BOOT_WAIT_POLLS = 60;                // 60 * 3s = 180s (3 min) waiting for AWS to reach running & assign IP
    const MAX_STREAMER_WAIT_POLLS = 60;            // 60 * 3s = 180s (3 min) waiting for UE5 streamer once running
    const MAX_CONSECUTIVE_ERRORS = 10;             // 10 consecutive poll/network/AWS failures (30s)

    console.log(`[WS Poll] [${uuid}] [token:${tokenTag}] Status poll started (t=0s)`);

    const handlePollTimeout = async (reason: string) => {
      clearInterval(pollInterval);
      isStabilizing = false;
      isServerReadyEmitted = true; // prevent any late emissions
      const elapsed = ((Date.now() - pollStartTime) / 1000).toFixed(1);
      console.warn(`[WS Poll] [${uuid}] [token:${tokenTag}] [+${elapsed}s] TIMEOUT/FAILURE: ${reason}`);

      const currentInst = this.db.getInstance(uuid);
      if (currentInst) {
        currentInst.status = 'stopped';
        currentInst.activeSessions.delete(hostToken);
        (currentInst as any).lastError = reason;
        await this.db.saveInstance(uuid, currentInst);
      }

      this.timeTracker.stopRealTimer(uuid);
      this.socketToSession.delete(socket.id);

      socket.emit('instance-status', {
        status: 'stopped',
        lastError: reason
      });

      // Terminate unresponsive instance on AWS to prevent resource leakage
      if (currentInst) {
        ScalingService.getInstance().terminateAndRemove(uuid).catch(err => {
          console.error(`[WS] Failed to terminate timed-out instance ${uuid}:`, err.message);
        });
      }
    };

    const pollInterval = setInterval(async () => {
      // Guard against overlapping poll ticks, active stabilization delays, or redundant post-ready executions
      if (isServerReadyEmitted || isStabilizing || isChecking) {
        return;
      }

      const mapping = this.socketToSession.get(socket.id);
      if (!mapping || mapping.instanceUuid !== uuid || !socket.connected) {
        clearInterval(pollInterval);
        return;
      }

      const instance = this.db.getInstance(uuid);
      if (!instance) {
        clearInterval(pollInterval);
        return;
      }

      // Hard wall-clock timeout guard (guarantees bounded execution in every failure mode)
      if (Date.now() - pollStartTime > MAX_POLL_DURATION_MS) {
        await handlePollTimeout('Время ожидания запуска сервера истекло. Пожалуйста, попробуйте снова.');
        return;
      }

      isChecking = true;
      try {
        const checkStreamerConnected = async (targetUrl: string): Promise<boolean> => {
          return new Promise<boolean>((resolve) => {
            const wsUrl = targetUrl.startsWith('ws') ? targetUrl : targetUrl.replace(/^http/, 'ws');
            let resolved = false;
            const cleanupAndResolve = (val: boolean) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              try { ws.terminate(); } catch {}
              resolve(val);
            };

            const ws = new WebSocket(wsUrl, {
              headers: { 'X-Pinggy-No-Screen': 'true' },
              handshakeTimeout: 3000
            });

            const timer = setTimeout(() => {
              cleanupAndResolve(false);
            }, 4000);

            ws.on('open', () => {
              try {
                ws.send(JSON.stringify({ type: 'listStreamers' }));
              } catch {
                cleanupAndResolve(false);
              }
            });

            ws.on('message', (data) => {
              try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'streamerList') {
                  if (Array.isArray(msg.ids) && msg.ids.length > 0) {
                    cleanupAndResolve(true);
                  } else {
                    cleanupAndResolve(false);
                  }
                }
              } catch {
                cleanupAndResolve(false);
              }
            });

            ws.on('error', () => cleanupAndResolve(false));
            ws.on('close', () => cleanupAndResolve(false));
          });
        };

        const tryStabilizeAndRedirect = async (ip: string): Promise<boolean> => {
          const directWsUrl = `ws://${ip}:8000`;
          const isStreamerReady = await checkStreamerConnected(directWsUrl);
          if (isStreamerReady) {
            if (isServerReadyEmitted) return true;
            isStabilizing = true;
            const elapsed = ((Date.now() - pollStartTime) / 1000).toFixed(1);
            console.log(`[WS Poll] [${uuid}] [token:${tokenTag}] [+${elapsed}s] Streamer detected at ws://${ip}:8000. Waiting 6s for stabilization...`);
            await new Promise(resolve => setTimeout(resolve, 6000));

            // Re-verify session mapping and socket connection after stabilization delay
            const currentMapping = this.socketToSession.get(socket.id);
            if (!currentMapping || currentMapping.instanceUuid !== uuid || !socket.connected) {
              clearInterval(pollInterval);
              isStabilizing = false;
              return false;
            }

            const isStillReady = await checkStreamerConnected(directWsUrl);
            if (isStillReady) {
              if (!isServerReadyEmitted) {
                isServerReadyEmitted = true;
                const readyElapsed = ((Date.now() - pollStartTime) / 1000).toFixed(1);
                console.log(`[WS Poll] [${uuid}] [token:${tokenTag}] [+${readyElapsed}s] Streamer stabilized at ${ip}. Emitting server-ready.`);
                clearInterval(pollInterval);
                socket.emit('server-ready', { pinggyUrl: `/instance/${uuid}` });
              }
              return true;
            } else {
              console.warn(`[WS Poll] [${uuid}] [token:${tokenTag}] Streamer dropped during stabilization at ${ip}. Resuming polling.`);
              isStabilizing = false;
              return false;
            }
          }
          return false;
        };

        // 1. If privateIp or publicIp is already known and the instance is running, verify if the streamer is connected
        const knownIp = instance.privateIp || instance.publicIp;
        if (knownIp && instance.status === 'running') {
          const ready = await tryStabilizeAndRedirect(knownIp);
          if (ready) return;

          streamerWaitCount++;
          if (streamerWaitCount >= MAX_STREAMER_WAIT_POLLS) {
            await handlePollTimeout('3D-приложение не ответило вовремя. Пожалуйста, попробуйте снова.');
            return;
          }

          if (checkCount % 2 === 0) {
            socket.emit('instance-status', { status: 'booting_server' });
          }
          checkCount++;
          consecutiveErrorCount = 0; // Successful poll cycle
          return;
        }

        const awsStatus = await this.ec2Service.getInstanceStatus(instance.instanceId);

        if (awsStatus.state === 'running') {
          if (instance.status !== 'running') {
            instance.status = 'running';
            instance.publicIp = awsStatus.ip || undefined;
            instance.privateIp = awsStatus.privateIp || undefined;
            this.timeTracker.startRealTimer(uuid);
            await this.db.saveInstance(uuid, instance);
          }

          // Check again if privateIp or publicIp was updated in the database
          const fresh = this.db.getInstance(uuid);
          const currentIp = fresh?.privateIp || fresh?.publicIp || awsStatus.privateIp || awsStatus.ip;

          if (currentIp) {
            if (!fresh?.privateIp && awsStatus.privateIp) {
              instance.privateIp = awsStatus.privateIp;
              await this.db.saveInstance(uuid, instance);
            }
            if (!fresh?.publicIp && awsStatus.ip) {
              instance.publicIp = awsStatus.ip;
              await this.db.saveInstance(uuid, instance);
            }

            const ready = await tryStabilizeAndRedirect(currentIp);
            if (ready) return;

            streamerWaitCount++;
            if (streamerWaitCount >= MAX_STREAMER_WAIT_POLLS) {
              await handlePollTimeout('3D-приложение не ответило вовремя. Пожалуйста, попробуйте снова.');
              return;
            }

            if (checkCount % 2 === 0) {
              socket.emit('instance-status', { status: 'booting_server' });
            }
            checkCount++;
            consecutiveErrorCount = 0; // Successful poll cycle
            return;
          } else {
            bootWaitCount++;
            if (bootWaitCount >= MAX_BOOT_WAIT_POLLS) {
              await handlePollTimeout('Не удалось получить сетевой адрес сервера. Пожалуйста, попробуйте снова.');
              return;
            }
            if (checkCount % 2 === 0) socket.emit('instance-status', { status: 'pending' });
          }
        } else if (awsStatus.state === 'stopped' || awsStatus.state === 'shutting-down' || awsStatus.state === 'terminated') {
          clearInterval(pollInterval);
          instance.status = 'stopped';
          this.timeTracker.stopRealTimer(uuid);
          await this.db.saveInstance(uuid, instance);
          socket.emit('instance-status', { status: 'stopped', lastError: 'Сервер неожиданно остановился. Пожалуйста, войдите снова.' });
          return;
        } else {
          bootWaitCount++;
          if (bootWaitCount >= MAX_BOOT_WAIT_POLLS) {
            await handlePollTimeout('Сервер загружается дольше обычного. Пожалуйста, попробуйте снова.');
            return;
          }
          if (checkCount % 2 === 0) socket.emit('instance-status', { status: 'pending' });
        }

        consecutiveErrorCount = 0; // Successful poll cycle
      } catch (e: any) {
        consecutiveErrorCount++;
        console.error(`[WS] AWS poll error for ${uuid} (${consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS}):`, e.message);
        if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
          await handlePollTimeout('Сервер временно недоступен. Пожалуйста, попробуйте снова через несколько секунд.');
          return;
        }
      } finally {
        isChecking = false;
      }
      checkCount++;
    }, 3000);
  }


  // ── AWS Stop Polling ──────────────────────────────────────────────────────
  public startAwsStopPoll(uuid: string): void {
    let checkCount = 0;
    const pollInterval = setInterval(async () => {
      const instance = this.db.getInstance(uuid);
      if (!instance || instance.status !== 'stopping') {
        clearInterval(pollInterval);
        return;
      }
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instance.instanceId);
        if (awsStatus.state === 'stopped' || awsStatus.state === 'terminated') {
          instance.status = 'stopped';
          this.timeTracker.stopRealTimer(uuid);
          await this.db.saveInstance(uuid, instance);
          clearInterval(pollInterval);
          this.io.to(`instance:${uuid}`).emit('instance-status', { status: 'stopped' });
        }
      } catch (e: any) {
        console.error('[WS] AWS stop poll error:', e.message);
      }
      checkCount++;
      if (checkCount > 120) { // 10 minutes timeout
        clearInterval(pollInterval);
      }
    }, 5000);
  }

  // ── Handle display-start ───────────────────────────────────────────────────
  private async handleDisplayStart(socket: Socket, data: DisplayStartData): Promise<void> {
    console.log(`[WS] New WebRTC/display-start for socket ${socket.id} on ${data.instanceUuid} (device: ${data.deviceId?.substring(0, 8) || 'unknown'}, token: ${data.hostToken?.substring(0, 8)}...)`);

    const instance = this.db.getInstance(data.instanceUuid);
    if (!instance || instance.status === 'stopped' || instance.status === 'stopping' || instance.status === 'terminated') {
      console.error(`[WS] Display start failed: Instance ${data.instanceUuid} not found or inactive (${instance?.status})`);
      socket.emit('error', { message: 'Session expired or instance inactive' });
      return;
    }

    let hostToken = data.hostToken;
    if (!hostToken) {
      hostToken = randomUUID();
      console.log(`[WS] No hostToken from socket ${socket.id}. Generated: ${hostToken.substring(0, 8)}...`);
    }

    // AGGRESSIVE CANCEL: Stop any pending flicker or grace shutdown as soon as we see activity
    this.cancelFlickerTimer(data.instanceUuid);
    this.timeTracker.cancelGracePeriod(data.instanceUuid);

    // SESSION KEYED BY hostToken (stable across refreshes)
    const existingSession = instance.activeSessions.get(hostToken);

    if (existingSession) {
      // RECONNECT / MULTI-TAB — verify device binding
      if (data.deviceId && existingSession.deviceId && existingSession.deviceId !== data.deviceId) {
        console.warn(`[WS] Hijack attempt blocked during display-start! Token match but Device mismatch.`);
        socket.emit('error', { message: 'Session locked to another device' });
        return;
      }

      console.log(`[WS] Connecting display session for token ${hostToken.substring(0, 8)}... (Socket: ${socket.id})`);

      if (!Array.isArray(existingSession.socketIds)) existingSession.socketIds = [];
      if (!existingSession.socketIds.includes(socket.id)) {
        existingSession.socketIds.push(socket.id);
      }

      existingSession.socketId = socket.id;
      existingSession.lastSeenAt = Date.now();
      existingSession.displayStarted = true;
    } else {
      // NEW SESSION
      console.log(`[WS] New display session for token ${hostToken.substring(0, 8)}...`);
      instance.activeSessions.set(hostToken, {
        socketId: socket.id,
        socketIds: [socket.id],
        hostToken,
        lastSeenAt: Date.now(),
        displayStarted: true,
        ipAddress: socket.handshake.address,
        deviceId: data.deviceId,
      });
    }

    // Map socket → session for fast disconnect lookup
    this.socketToSession.set(socket.id, { instanceUuid: data.instanceUuid, hostToken });

    // Start real-time tracker (idempotent)
    this.timeTracker.startDisplayTimer(data.instanceUuid);

    await this.db.saveInstance(data.instanceUuid, instance);

    // Confirm to client
    const settings = SettingsService.getInstance().getSettings();
    const idleTimeoutMinutes = (typeof settings.idleTimeoutMinutes === 'number' && settings.idleTimeoutMinutes > 0)
      ? settings.idleTimeoutMinutes
      : 5;
    socket.emit('display-started', { success: true, hostToken, idleTimeoutMinutes });

    // Start heartbeat watchdog for this socket
    this.startHeartbeatMonitor(socket.id, data.instanceUuid, hostToken);

    console.log(`[WS] Display started. Instance ${data.instanceUuid} active sessions: ${instance.activeSessions.size}`);
  }

  // ── Handle heartbeat ───────────────────────────────────────────────────────
  private async handleHeartbeat(socket: Socket, data: any): Promise<void> {
    let mapping = this.socketToSession.get(socket.id);

    // Self-heal mapping if missing (e.g. after sleep/wake or watchdog timeout where socketToSession was pruned)
    if (!mapping && data && data.instanceUuid && data.hostToken) {
      const inst = this.db.getInstance(data.instanceUuid);
      if (inst && inst.status !== 'stopped' && inst.status !== 'stopping' && inst.status !== 'terminated') {
        const sess = inst.activeSessions.get(data.hostToken);
        if (sess) {
          console.log(`[WS] Self-healing socketToSession mapping for socket ${socket.id} (instance ${data.instanceUuid}, token ${data.hostToken.substring(0, 8)}...)`);
          this.socketToSession.set(socket.id, { instanceUuid: data.instanceUuid, hostToken: data.hostToken });
          if (!Array.isArray(sess.socketIds)) sess.socketIds = [];
          if (!sess.socketIds.includes(socket.id)) sess.socketIds.push(socket.id);
          sess.socketId = socket.id;
          sess.lastSeenAt = Date.now();
          sess.displayStarted = true;
          await this.db.saveInstance(data.instanceUuid, inst);
          mapping = { instanceUuid: data.instanceUuid, hostToken: data.hostToken };
        }
      }
    }

    if (mapping) {
      const instance = this.db.getInstance(mapping.instanceUuid);
      if (!instance || instance.status === 'stopped' || instance.status === 'stopping' || instance.status === 'terminated') {
        this.clearHeartbeatMonitor(socket.id);
        this.socketToSession.delete(socket.id);
        return;
      }

      // Refresh activity timestamp
      const session = instance.activeSessions.get(mapping.hostToken);
      if (session) {
        session.lastSeenAt = Date.now();
        if (session.deviceId) {
          console.log(`[WS] Heartbeat received from Device ${session.deviceId.substring(0, 8)}... (Socket: ${socket.id}) - Session Protected.`);
        }
      }

      // If instance is in grace period (e.g. from network flicker), CANCEL it immediately
      if (this.timeTracker.hasGracePeriod(mapping.instanceUuid)) {
        console.log(`[WS] Heartbeat received for ${mapping.instanceUuid}. Cancelling active grace period.`);
        this.cancelFlickerTimer(mapping.instanceUuid);
        this.timeTracker.cancelGracePeriod(mapping.instanceUuid);
      }

      // Re-arm heartbeat monitor if it was cleared
      if (!this.heartbeatMonitors.has(socket.id)) {
        this.startHeartbeatMonitor(socket.id, mapping.instanceUuid, mapping.hostToken);
      }

      await this.db.saveInstance(mapping.instanceUuid, instance);
      socket.emit('heartbeat-ack', { timestamp: Date.now() });
    }
  }

  // ── Handle player-disconnect (explicit: tab close / nav away) ─────────────
  private async handlePlayerDisconnect(socket: Socket, instanceUuid: string, hostToken: string): Promise<void> {
    this.socketToSession.delete(socket.id);
    this.clearHeartbeatMonitor(socket.id);

    const instance = this.db.getInstance(instanceUuid);
    if (!instance) return;

    const session = instance.activeSessions.get(hostToken);
    if (!session) return;

    console.log(`[WS] Explicit player-disconnect for socket ${socket.id} (token ${hostToken.substring(0, 8)}...)`);

    // Remove this specific socket from session
    if (Array.isArray(session.socketIds)) {
      session.socketIds = session.socketIds.filter(id => id !== socket.id);
    }
    if (session.socketId === socket.id) {
      session.socketId = session.socketIds && session.socketIds.length > 0 ? session.socketIds[session.socketIds.length - 1] : undefined;
    }

    const sessionHasSockets = (Array.isArray(session.socketIds) && session.socketIds.length > 0) || !!session.socketId;
    if (!sessionHasSockets) {
      session.displayStarted = false;
    }
    await this.db.saveInstance(instanceUuid, instance);

    // Check if ANY active socket remains on ANY session for this instance
    const hasAnySocket = this.hasActiveSockets(instance);

    if (!hasAnySocket) {
      console.log(`[WS] No active sockets on ${instanceUuid}. Stopping display timer & scheduling grace period...`);
      this.cancelFlickerTimer(instanceUuid);
      this.timeTracker.stopDisplayTimer(instanceUuid);
      this.startGracePeriod(instanceUuid);
    } else {
      console.log(`[WS] Player disconnected on socket ${socket.id}, but instance ${instanceUuid} still has active sockets.`);
    }
  }

  // ── Handle socket disconnect (network drop / browser close) ───────────────
  private async handleSocketDisconnect(socket: Socket): Promise<void> {
    const mapping = this.socketToSession.get(socket.id);
    if (!mapping) return;

    const { instanceUuid, hostToken } = mapping;
    this.socketToSession.delete(socket.id);
    this.clearHeartbeatMonitor(socket.id);

    const instance = this.db.getInstance(instanceUuid);
    if (!instance) return;

    const session = instance.activeSessions.get(hostToken);
    if (session) {
      if (Array.isArray(session.socketIds)) {
        session.socketIds = session.socketIds.filter(id => id !== socket.id);
      }
      if (session.socketId === socket.id) {
        session.socketId = session.socketIds && session.socketIds.length > 0 ? session.socketIds[session.socketIds.length - 1] : undefined;
      }
      const sessionHasSockets = (Array.isArray(session.socketIds) && session.socketIds.length > 0) || !!session.socketId;
      if (!sessionHasSockets) {
        session.displayStarted = false;
      }
      await this.db.saveInstance(instanceUuid, instance);
    }

    // Check if there are other active sockets right now
    const hasRemainingSocket = this.hasActiveSockets(instance);

    if (hasRemainingSocket) {
      console.log(`[WS] Socket ${socket.id} disconnected, but instance ${instanceUuid} still has remaining active sockets.`);
      return; // Do not stop display timer or start grace period while other tabs are active!
    }

    this.timeTracker.stopDisplayTimer(instanceUuid);

    // ── Flicker Resilience Delay (15 seconds) ───────────────────────────────
    // If this is a network flicker, we give the user 15s to reconnect 
    // before we even bother STARTING the 60s grace period.
    const deviceLabel = session?.deviceId ? `${session.deviceId.substring(0, 8)}...` : 'Unknown device';
    console.log(`[WS] ${deviceLabel} (socket ${socket.id}) disconnected. No remaining sockets. Waiting 15s for flicker recovery.`);

    this.cancelFlickerTimer(instanceUuid);
    const timer = setTimeout(async () => {
      this.flickerTimers.delete(instanceUuid);
      const currentInst = this.db.getInstance(instanceUuid);
      if (!currentInst) return;

      const hasAnySocket = this.hasActiveSockets(currentInst);
      if (!hasAnySocket) {
        console.log(`[WS] No reconnection within 15s for ${instanceUuid}. Starting 60s Grace Period.`);
        this.startGracePeriod(instanceUuid);
      } else {
        console.log(`[WS] Flicker Recovery: ${deviceLabel} reconnected within 15s.`);
      }
    }, 15000);
    this.flickerTimers.set(instanceUuid, timer);
  }

  // ── Grace period ──────────────────────────────────────────────────────────
  public startGracePeriod(instanceUuid: string): void {
    const instance = this.db.getInstance(instanceUuid);

    // ── GUARD: Never start grace period on pool-managed instances ──────────
    // Prewarm/Buffer instances have no sessions by design. Running a grace
    // period on them would terminate them 60 s after the watchdog first sees
    // them, causing the infinite prewarm loop.
    if (instance && (instance.assignedTo === PREWARM_LABEL || instance.assignedTo === BUFFER_LABEL)) {
      console.warn(
        `[WS] GRACE PERIOD BLOCKED for ${instanceUuid} — ` +
        `assignedTo='${instance.assignedTo}'. Pool instances must NOT be grace-terminated.`
      );
      return;
    }

    console.log(`[WS] Grace period started for instance ${instanceUuid} (assignedTo=${instance?.assignedTo ?? 'unknown'})`);

    this.io.to(`instance:${instanceUuid}`).emit('grace-period-started', {
      durationMs: 60000,
      message: 'No active viewers. Server will stop in 60 seconds if no one reconnects.',
    });

    this.timeTracker.startGracePeriod(instanceUuid, async () => {
      const instance = this.db.getInstance(instanceUuid);
      if (!instance) return;

      // Double-check guard at expiry time too — assignedTo may have changed
      if (instance.assignedTo === PREWARM_LABEL || instance.assignedTo === BUFFER_LABEL) {
        console.warn(
          `[WS TERMINATE BLOCKED] Grace period expired for ${instanceUuid} but ` +
          `assignedTo='${instance.assignedTo}' — skipping termination.`
        );
        return;
      }

      const hasActiveSockets = this.hasActiveSockets(instance);
      const hasDisplayStarted = Array.from(instance.activeSessions.values()).some(s => s.displayStarted);

      if (!hasActiveSockets && !hasDisplayStarted) {
        console.log(`[WS] Grace period expired for ${instanceUuid} (assignedTo=${instance.assignedTo}). No active viewers.`);
        instance.activeSessions.clear();
        await this.db.saveInstance(instanceUuid, instance);
        
        // Notify clients that the instance is stopping
        this.io.to(`instance:${instanceUuid}`).emit('instance-stopping', {
          message: 'The server is shutting down.',
          timestamp: Date.now(),
        });
        this.timeTracker.stopDisplayTimer(instanceUuid);
        
        const isHealthy = instance.status === 'running';
        if (isHealthy) {
          console.log(`[WS] Instance ${instanceUuid} is healthy — recycling back to buffer pool.`);
          await ScalingService.getInstance().recycleInstanceToBuffer(instanceUuid);
        } else {
          console.warn(`[WS] Instance ${instanceUuid} is not running (status=${instance.status}) — terminating.`);
          await ScalingService.getInstance().terminateAndRemove(instanceUuid);
        }
      } else {
        console.log(`[WS] Grace period expired but active viewers found for ${instanceUuid} (hasSockets=${hasActiveSockets}, displayStarted=${hasDisplayStarted}) — not stopping.`);
      }
    });
  }

  // ── Heartbeat watchdog ────────────────────────────────────────────────────
  private startHeartbeatMonitor(socketId: string, instanceUuid: string, hostToken: string): void {
    this.clearHeartbeatMonitor(socketId);

    const TIMEOUT_MS = 45000; // 45 s - approx 4.5 missed heartbeats (10s intervals)
    const interval = setInterval(async () => {
      const instance = this.db.getInstance(instanceUuid);
      if (!instance) { this.clearHeartbeatMonitor(socketId); return; }

      const session = instance.activeSessions.get(hostToken);
      const isSocketInSession = session && ((Array.isArray(session.socketIds) && session.socketIds.includes(socketId)) || session.socketId === socketId);
      if (!isSocketInSession) {
        this.clearHeartbeatMonitor(socketId);
        return;
      }

      // If we see an active socket being monitored, ensure no grace period is running
      if (this.timeTracker.hasGracePeriod(instanceUuid)) {
        console.log(`[WS] Active socket ${socketId} detected for ${instanceUuid}. Killing accidental grace period.`);
        this.timeTracker.cancelGracePeriod(instanceUuid);
      }

      if (Date.now() - session.lastSeenAt > TIMEOUT_MS) {
        console.log(`[WS] Heartbeat timeout (45s) for socket ${socketId} on device ${session.deviceId?.substring(0, 8)}...`);
        this.clearHeartbeatMonitor(socketId);
        this.socketToSession.delete(socketId);

        if (Array.isArray(session.socketIds)) {
          session.socketIds = session.socketIds.filter(id => id !== socketId);
        }
        if (session.socketId === socketId) {
          session.socketId = session.socketIds && session.socketIds.length > 0 ? session.socketIds[session.socketIds.length - 1] : undefined;
        }

        const sessionHasSockets = (Array.isArray(session.socketIds) && session.socketIds.length > 0) || !!session.socketId;
        if (!sessionHasSockets) {
          session.displayStarted = false;
        }
        await this.db.saveInstance(instanceUuid, instance);

        const hasActive = this.hasActiveSockets(instance);
        if (!hasActive) {
          this.cancelFlickerTimer(instanceUuid);
          this.timeTracker.stopDisplayTimer(instanceUuid);
          this.startGracePeriod(instanceUuid);
        }
      }
    }, 10000);

    this.heartbeatMonitors.set(socketId, interval);
  }

  private clearHeartbeatMonitor(socketId: string): void {
    const interval = this.heartbeatMonitors.get(socketId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatMonitors.delete(socketId);
    }
  }

  // ── Stop instance + notify all room sockets ───────────────────────────────
  private async stopInstanceAndNotify(instanceUuid: string): Promise<void> {
    const instance = this.db.getInstance(instanceUuid);
    if (!instance) return;
    if (instance.status === 'stopped' || instance.status === 'stopping') return;

    // NUCLEAR OPTION GUARD: If a socket literally just connected, abort stop.
    const hasAnySocket = this.hasActiveSockets(instance);
    if (hasAnySocket) {
      console.warn(`[WS] STOP ABORTED for ${instanceUuid}: active socket detected at last millisecond.`);
      return;
    }

    try {
      await this.ec2Service.stopInstance(instance.instanceId);
      instance.status = 'stopping';
      await this.db.saveInstance(instanceUuid, instance);
      console.log(`[WS] Instance ${instance.instanceId} stop command sent`);
      this.startAwsStopPoll(instanceUuid);
    } catch (e: any) {
      console.error(`[WS] Failed to stop instance: ${e.message}`);
    }

    this.io.to(`instance:${instanceUuid}`).emit('instance-stopping', {
      message: 'The server is shutting down.',
      timestamp: Date.now(),
    });

    this.timeTracker.stopDisplayTimer(instanceUuid);
  }

  broadcastToInstance(instanceUuid: string, event: string, data: any): void {
    this.io.to(`instance:${instanceUuid}`).emit(event, data);
  }
}
