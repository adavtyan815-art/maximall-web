import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import app, { setWsService } from './app';
import { config } from './config';
import { DatabaseService } from './services/databaseService';
import { SettingsService } from './services/settingsService';
import { WebSocketService } from './services/websocketService';
import { EC2Service } from './services/ec2Service';
import { ScalingService } from './services/scalingService';

const PORT = config.PORT;

// Tag used to auto-discover EC2 instances in AWS
const DISCOVERY_TAG_NAME  = 'Name';
const DISCOVERY_TAG_VALUE = process.env.EC2_DISCOVERY_TAG ?? 'LinuxClient';

async function bootstrap() {
  try {
    // 1. Initialize Database (pure in-memory, no MongoDB)
    const db = DatabaseService.getInstance();
    await db.init();
    console.log('[Server] In-memory database initialized');

    // 2. Initialize Settings (pure in-memory, no MongoDB)
    const settings = SettingsService.getInstance();
    await settings.init();
    console.log('[Server] In-memory settings initialized');

    // 3. Auto-discover EC2 instances by tag and seed the in-memory store
    console.log(`[Server] Discovering EC2 instances tagged ${DISCOVERY_TAG_NAME}=${DISCOVERY_TAG_VALUE} ...`);
    try {
      const ec2Service = new EC2Service();
      const discovered = await ec2Service.discoverInstancesByTag(DISCOVERY_TAG_NAME, DISCOVERY_TAG_VALUE);

      if (discovered.length === 0) {
        console.warn(`[Server] No EC2 instances found with tag ${DISCOVERY_TAG_NAME}=${DISCOVERY_TAG_VALUE}. ` +
          'The instance pool will be empty until you add them manually or fix the tag.');
      } else {
        for (const inst of discovered) {
          const existing = db.getInstance(inst.uuid);
          if (existing) {
            inst.assignedTo = existing.assignedTo;
            inst.activeSessions = existing.activeSessions;
            inst.realTimeUsedSeconds = existing.realTimeUsedSeconds;
            inst.displayTimeUsedSeconds = existing.displayTimeUsedSeconds;
            if (existing.pinggyUrl && !inst.pinggyUrl) {
              inst.pinggyUrl = existing.pinggyUrl;
            }
          }
          await db.saveInstance(inst.uuid, inst);
          console.log(`[Server]   ✓ Loaded ${inst.instanceId} (${inst.assignedTo}) — status: ${inst.status}`);
        }
        console.log(`[Server] ${discovered.length} instance(s) loaded into pool.`);
      }

    } catch (err: any) {
      // Discovery failure is non-fatal — server still starts, pool will just be empty
      console.error('[Server] EC2 discovery failed (check AWS credentials/region):', err.message);
    }

    // 4. Create HTTP Server
    const server = http.createServer(app);

    // Dynamic WebSocket Reverse Proxy for Pixel Streaming signaling
    const psProxyWss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = request.url || '';
      const match = url.match(/^\/instance\/([^\/]+)\/ws/);
      if (match) {
        const uuid = match[1];
        const db = DatabaseService.getInstance();
        const inst = db.getInstance(uuid);

        if (inst && inst.publicIp) {
          psProxyWss.handleUpgrade(request, socket, head, (clientWs) => {
            const targetUrl = `ws://${inst.publicIp}:8000/`;
            console.log(`[WS-Proxy] Routing signaling for ${uuid} directly to ${targetUrl}`);
            
            const targetWs = new WebSocket(targetUrl);

            // Pipe data back and forth
            clientWs.on('message', (data, isBinary) => {
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(data, { binary: isBinary });
              }
            });

            targetWs.on('message', (data, isBinary) => {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data, { binary: isBinary });
              }
            });

            clientWs.on('close', () => {
              targetWs.close();
            });

            targetWs.on('close', () => {
              clientWs.close();
            });

            clientWs.on('error', (err) => {
              console.error(`[WS-Proxy] Client socket error for ${uuid}:`, err.message);
              targetWs.close();
            });

            targetWs.on('error', (err) => {
              console.error(`[WS-Proxy] Target socket error for ${uuid} (${targetUrl}):`, err.message);
              clientWs.close();
            });
          });
        } else {
          console.warn(`[WS-Proxy] Upgrade requested for ${uuid} but instance or IP not found in DB`);
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
        }
      }
      // Let other upgrade handlers (like Socket.io) process the upgrade if it's not our prefix
    });

    // 5. Initialize WebSockets and inject into app so REST routes can broadcast
    const wsService = new WebSocketService(server);
    setWsService(wsService);
    console.log('[Server] WebSocket service initialized');

    // 6. Start Pre-warm Buffer Pool Loop
    ScalingService.getInstance().startPrewarmLoop();
    console.log('[Server] Pre-warm scaling loop started');

    // 7. Start Server
    server.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
    });

  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

bootstrap();
