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


export class WebSocketService {
  private io: SocketServer;
  private db: DatabaseService;
  private timeTracker: TimeTrackerService;
  private ec2Service: EC2Service;

  // socketId → { instanceUuid, hostToken } — for fast disconnect lookups
  private socketToSession: Map<string, { instanceUuid: string; hostToken: string }> = new Map();

  // socketId → interval — heartbeat watchdog timers
  private heartbeatMonitors: Map<string, NodeJS.Timeout> = new Map();

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
          if (!session.socketId && (now - session.lastSeenAt > GHOST_STALE_THRESHOLD)) {
            instance.activeSessions.delete(token);
            instanceChanged = true;
            totalPurged++;
          }
        }

        // Step 2: Detect "closed before redirect" — sessions that were created
        //         recently but have no socket and have been abandoned.
        const hasAnySocket = Array.from(instance.activeSessions.values()).some(s => s.socketId);
        const hasAnyActiveDisplay = Array.from(instance.activeSessions.values()).some(s => s.displayStarted);

        if (!hasAnySocket && !hasAnyActiveDisplay) {
          const allSessionsAbandoned =
            instance.activeSessions.size === 0 ||
            Array.from(instance.activeSessions.values()).every(
              s => !s.socketId && (now - s.lastSeenAt > NO_SOCKET_STALE_MS)
            );

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

      socket.on('disconnect', async () => {
        await this.handleSocketDisconnect(socket);
      });

      // ── New: Auto-Resume Check ──
      socket.on('check-active-session', async (data: { deviceId: string }) => {
        const instances = this.db.getInstances();
        for (const [uuid, inst] of Object.entries(instances)) {
          if (inst.status === 'stopped') continue;
          const sessions = Array.from(inst.activeSessions.values());
          const match = sessions.find(s => s.deviceId === data.deviceId);
          if (match) {
            console.log(`[WS] Active session found for device ${data.deviceId.substring(0, 8)} on ${uuid}`);
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

    // 1. RECOGNIZE USER BY DEVICE ID (Recovery)
    if (deviceId) {
      for (const [uuid, inst] of Object.entries(instances)) {
        if (inst.status === 'stopped') continue;

        const sessions = Array.from(inst.activeSessions.values());
        const isRecognizedOwner = sessions.some(s => s.deviceId === deviceId);

        if (isRecognizedOwner) {
          const inGrace = this.timeTracker.hasGracePeriod(uuid);
          const noActiveSocket = !sessions.some(s => s.socketId);

          if (inGrace || noActiveSocket) {
            console.log(`[WS] Recon/Rescue: Device ${deviceId.substring(0, 8)}... recognized for instance ${uuid}`);
            if (inGrace) this.timeTracker.cancelGracePeriod(uuid);

            const matchedSession = sessions.find(s => s.deviceId === deviceId);
            const finalHostToken = matchedSession ? matchedSession.hostToken : (clientToken || randomUUID());

            // Re-bind this socket as the occupant
            if (matchedSession) {
              matchedSession.socketId = socket.id;
              matchedSession.lastSeenAt = Date.now();
            }

            this.socketToSession.set(socket.id, { instanceUuid: uuid, hostToken: finalHostToken });
            socket.emit('instance-assigned', { uuid, hostToken: finalHostToken, rescued: true });
            this.startAwsStatusPoll(socket, uuid, finalHostToken);
            return;
          }
        }
      }
    }

    // 2. Try to claim an existing stopped instance from the buffer pool
    const hostToken = clientToken || randomUUID();
    let claimedInstanceId: string | null = null;
    try {
      claimedInstanceId = await ScalingService.getInstance().claimBufferInstance();
    } catch (e: any) {
      console.warn(`[WS] claimBufferInstance failed: ${e.message}`);
    }

    if (claimedInstanceId) {
      console.log(`[WS] Claimed buffer instance ${claimedInstanceId} for user`);
      const instance = this.db.getInstance(claimedInstanceId);
      if (instance) {
        instance.status = 'pending';
        instance.assignedTo = `OnDemand-${claimedInstanceId.substring(2, 8)}`;
        instance.activeSessions.set(hostToken, {
          hostToken,
          lastSeenAt: Date.now(),
          displayStarted: false,
          socketId: socket.id,
          ipAddress: socket.handshake.address,
          deviceId: deviceId,
        });
        await this.db.saveInstance(claimedInstanceId, instance);

        try {
          console.log(`[WS] Waking up buffer instance ${claimedInstanceId}...`);
          await this.ec2Service.startInstance(claimedInstanceId);

          // Join the room for status updates
          socket.join(`instance:${claimedInstanceId}`);

          this.socketToSession.set(socket.id, { instanceUuid: claimedInstanceId, hostToken });
          socket.emit('instance-assigned', { uuid: claimedInstanceId, hostToken, rescued: false });

          // Start status polling
          this.startAwsStatusPoll(socket, claimedInstanceId, hostToken);
          return;
        } catch (err: any) {
          console.error(`[WS] Failed to wake up claimed buffer instance ${claimedInstanceId}:`, err.message);
          // Rollback the claim on AWS start failure so it returns to buffer pool
          instance.status = 'stopped';
          instance.assignedTo = BUFFER_LABEL;
          instance.activeSessions.delete(hostToken);
          await this.db.saveInstance(claimedInstanceId, instance);
          socket.emit('instance-error', { message: `Failed to wake up server: ${err.message}` });
          return;
        }
      }
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
      socket.emit('instance-error', { message: errMsg });
    }

  }

  // ── Handle resume-instance ──────────────────────────────────────────────────
  private async handleResumeInstance(socket: Socket, uuid: string, hostToken: string, deviceId?: string): Promise<void> {
    const instance = this.db.getInstance(uuid);
    if (!instance) {
      socket.emit('instance-error', { message: 'Instance not found' });
      return;
    }

    // Device Enforcement: Verify seeker matches occupant
    const existingSession = instance.activeSessions.get(hostToken);
    if (existingSession && deviceId && existingSession.deviceId && existingSession.deviceId !== deviceId) {
      console.warn(`[WS] Hijack attempt blocked: Device ${deviceId.substring(0, 8)}... tried to resume instance ${uuid} belonging to ${existingSession.deviceId?.substring(0, 8)}...`);
      socket.emit('instance-error', { message: 'This server is reserved for another device.' });
      return;
    }

    if (this.timeTracker.hasGracePeriod(uuid)) {
      console.log(`[WS] FORCE CANCEL grace period for ${uuid} due to explicit resume-instance`);
      this.timeTracker.cancelGracePeriod(uuid);
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
    const pollInterval = setInterval(async () => {
      const mapping = this.socketToSession.get(socket.id);
      if (!mapping || mapping.instanceUuid !== uuid) {
        clearInterval(pollInterval);
        return;
      }

      const instance = this.db.getInstance(uuid);
      if (!instance) {
        clearInterval(pollInterval);
        return;
      }

      const checkStreamerConnected = async (pinggyUrl: string): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
          const wsUrl = pinggyUrl.replace(/^http/, 'ws');
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


      // 1. If Pinggy URL is already reported, verify if the streamer is connected
      if (instance.pinggyUrl) {
        const isStreamerReady = await checkStreamerConnected(instance.pinggyUrl);
        if (isStreamerReady) {
          console.log(`[WS] Streamer is connected to signaling server at ${instance.pinggyUrl}. Redirecting client.`);
          clearInterval(pollInterval);
          socket.emit('server-ready', { pinggyUrl: instance.pinggyUrl });
          return;
        } else {
          if (checkCount % 2 === 0) {
            socket.emit('instance-status', { status: 'booting_server' });
          }
          checkCount++;
          return;
        }
      }

      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instance.instanceId);

        if (awsStatus.state === 'running') {
          if (instance.status !== 'running') {
            instance.status = 'running';
            this.timeTracker.startRealTimer(uuid);
            await this.db.saveInstance(uuid, instance);
          }

          // Check again if pinggyUrl was registered in the meantime
          const fresh = this.db.getInstance(uuid);
          if (fresh?.pinggyUrl) {
            const isStreamerReady = await checkStreamerConnected(fresh.pinggyUrl);
            if (isStreamerReady) {
              clearInterval(pollInterval);
              socket.emit('server-ready', { pinggyUrl: fresh.pinggyUrl });
              return;
            } else {
              if (checkCount % 2 === 0) {
                socket.emit('instance-status', { status: 'booting_server' });
              }
              checkCount++;
              return;
            }
          }

          if (awsStatus.ip) {
            const targetHost = `http://${awsStatus.ip}:8000`;
            const isReady = await new Promise((resolve) => {
              const pingReq = http.get(targetHost, { timeout: 2000 }, () => resolve(true));
              pingReq.on('error', () => resolve(false));
              pingReq.on('timeout', () => { pingReq.destroy(); resolve(false); });
            });

            if (isReady) {
              // Re-read instance to pick up pinggyUrl if /report-tunnel already fired
              const fresh2 = this.db.getInstance(uuid);
              const pinggyUrl = fresh2?.pinggyUrl;

              if (pinggyUrl) {
                const isStreamerReady = await checkStreamerConnected(pinggyUrl);
                if (isStreamerReady) {
                  clearInterval(pollInterval);
                  socket.emit('server-ready', { pinggyUrl });
                  return;
                }
              }
              if (checkCount % 2 === 0) {
                socket.emit('instance-status', { status: 'booting_server' });
              }
            } else {
              if (checkCount % 2 === 0) socket.emit('instance-status', { status: 'booting_server' });
            }
          } else {
            if (checkCount % 2 === 0) socket.emit('instance-status', { status: 'pending' });
          }
        } else if (awsStatus.state === 'stopped' || awsStatus.state === 'shutting-down' || awsStatus.state === 'terminated') {
          clearInterval(pollInterval);
          instance.status = 'stopped';
          this.timeTracker.stopRealTimer(uuid);
          await this.db.saveInstance(uuid, instance);
          socket.emit('instance-status', { status: 'stopped', lastError: 'Instance unexpectedly stopped.' });
        } else {
          if (checkCount % 2 === 0) socket.emit('instance-status', { status: 'pending' });
        }
      } catch (e: any) {
        console.error('[WS] AWS poll error:', e.message);
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
    console.log(`[WS] display-start — Socket: ${socket.id}, Instance: ${data.instanceUuid}, Token: ${data.hostToken?.substring(0, 8)}...`);

    const instance = this.db.getInstance(data.instanceUuid);
    if (!instance) {
      console.error(`[WS] Display start failed: Instance ${data.instanceUuid} not found`);
      socket.emit('error', { message: 'Instance not found' });
      return;
    }

    let hostToken = data.hostToken;
    if (!hostToken) {
      hostToken = randomUUID();
      console.log(`[WS] No hostToken from socket ${socket.id}. Generated: ${hostToken.substring(0, 8)}...`);
    }

    // AGGRESSIVE CANCEL: Stop any pending shutdown as soon as we see activity
    this.timeTracker.cancelGracePeriod(data.instanceUuid);

    // SESSION KEYED BY hostToken (stable across refreshes)
    const existingSession = instance.activeSessions.get(hostToken);

    if (existingSession) {
      // RECONNECT — verify device binding
      if (data.deviceId && existingSession.deviceId && existingSession.deviceId !== data.deviceId) {
        console.warn(`[WS] Hijack attempt blocked during display-start! Token match but Device mismatch.`);
        socket.emit('error', { message: 'Session locked to another device' });
        return;
      }

      console.log(`[WS] Reconnecting session for token ${hostToken.substring(0, 8)}...`);
      // this.timeTracker.cancelGracePeriod(data.instanceUuid); // Moved up

      if (existingSession.socketId && existingSession.socketId !== socket.id) {
        this.socketToSession.delete(existingSession.socketId);
        this.clearHeartbeatMonitor(existingSession.socketId);
      }

      existingSession.socketId = socket.id;
      existingSession.lastSeenAt = Date.now();
      existingSession.displayStarted = true;
    } else {
      // NEW SESSION
      console.log(`[WS] New display session for token ${hostToken.substring(0, 8)}...`);
      instance.activeSessions.set(hostToken, {
        socketId: socket.id,
        hostToken,
        lastSeenAt: Date.now(),
        displayStarted: true,
        ipAddress: socket.handshake.address,
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
    const mapping = this.socketToSession.get(socket.id);
    if (!mapping) return;

    const instance = this.db.getInstance(mapping.instanceUuid);
    if (!instance) return;

    const session = instance.activeSessions.get(mapping.hostToken);
    if (session) {
      session.lastSeenAt = Date.now();

      // Mandatory deviceId check and log
      const deviceId = data.deviceId || session.deviceId;
      if (deviceId) {
        console.log(`[WS] Heartbeat received from Device ${deviceId.substring(0, 8)}... - Session Protected.`);
      }

      // Safety: if heartbeating, they are active. Cancel any pending stop.
      if (this.timeTracker.hasGracePeriod(mapping.instanceUuid)) {
        this.timeTracker.cancelGracePeriod(mapping.instanceUuid);
      }

      await this.db.saveInstance(mapping.instanceUuid, instance);
      socket.emit('heartbeat-ack', { timestamp: Date.now() });
    }
  }

  // ── Handle player-disconnect (explicit: tab close / nav away) ─────────────
  private async handlePlayerDisconnect(socket: Socket, instanceUuid: string, hostToken: string): Promise<void> {
    const instance = this.db.getInstance(instanceUuid);
    if (!instance) return;

    const session = instance.activeSessions.get(hostToken);
    if (!session) return;

    console.log(`[WS] Explicit player-disconnect for token ${hostToken.substring(0, 8)}...`);

    // Mark session inactive — keep in Map for reconnect during grace period
    session.socketId = undefined;
    session.displayStarted = false;
    await this.db.saveInstance(instanceUuid, instance);

    this.timeTracker.stopDisplayTimer(instanceUuid);

    // Start grace period — if no sockets are connected across ANY session
    const hasAnySocket = Array.from(instance.activeSessions.values()).some(s => !!s.socketId);
    if (!hasAnySocket) {
      console.log(`[WS] No active sockets on ${instanceUuid}. Scheduling grace period...`);
      this.startGracePeriod(instanceUuid);
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
      // Mark session inactive — keep in Map for reconnect during grace period
      session.socketId = undefined;
      session.displayStarted = false;
      await this.db.saveInstance(instanceUuid, instance);
    }

    this.timeTracker.stopDisplayTimer(instanceUuid);

    // ── Flicker Resilience Delay (15 seconds) ───────────────────────────────
    // If this is a network flicker, we give the user 15s to reconnect 
    // before we even bother STARTING the 60s grace period.
    const deviceLabel = session?.deviceId ? `${session.deviceId.substring(0, 8)}...` : 'Unknown device';
    console.log(`[WS] ${deviceLabel} disconnected. Waiting 15s for flicker recovery.`);

    setTimeout(async () => {
      const currentInst = this.db.getInstance(instanceUuid);
      if (!currentInst) return;

      const hasAnySocket = Array.from(currentInst.activeSessions.values()).some(s => !!s.socketId);
      if (!hasAnySocket) {
        console.log(`[WS] No reconnection within 15s for ${instanceUuid}. Starting 60s Grace Period.`);
        this.startGracePeriod(instanceUuid);
      } else {
        console.log(`[WS] Flicker Recovery: ${deviceLabel} reconnected within 15s.`);
      }
    }, 15000);
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

      const hasActive = Array.from(instance.activeSessions.values()).some(s => s.displayStarted);
      if (!hasActive) {
        console.log(`[WS TERMINATE] Grace period expired for ${instanceUuid} (assignedTo=${instance.assignedTo}). No active viewers. Terminating instance.`);
        instance.activeSessions.clear();
        await this.db.saveInstance(instanceUuid, instance);
        
        // Notify clients that the instance is stopping/terminating
        this.io.to(`instance:${instanceUuid}`).emit('instance-stopping', {
          message: 'The server is shutting down.',
          timestamp: Date.now(),
        });
        this.timeTracker.stopDisplayTimer(instanceUuid);
        
        await ScalingService.getInstance().terminateAndRemove(instanceUuid);
      } else {
        console.log(`[WS] Grace period expired but active viewers found for ${instanceUuid} — not stopping.`);
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
      if (!session || session.socketId !== socketId) {
        this.clearHeartbeatMonitor(socketId);
        return;
      }

      // If we see an active socket being monitored, ensure no grace period is running
      if (this.timeTracker.hasGracePeriod(instanceUuid)) {
        console.log(`[WS] Active socket ${socketId} detected for ${instanceUuid}. Killing accidental grace period.`);
        this.timeTracker.cancelGracePeriod(instanceUuid);
      }

      if (Date.now() - session.lastSeenAt > TIMEOUT_MS) {
        console.log(`[WS] Heartbeat timeout (45s) for device ${session.deviceId?.substring(0, 8)}...`);
        this.clearHeartbeatMonitor(socketId);
        this.socketToSession.delete(socketId);

        session.socketId = undefined;
        session.displayStarted = false;
        await this.db.saveInstance(instanceUuid, instance);

        const hasActive = Array.from(instance.activeSessions.values()).some(s => s.socketId);
        if (!hasActive) {
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
    const hasAnySocket = Array.from(instance.activeSessions.values()).some(s => !!s.socketId);
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
