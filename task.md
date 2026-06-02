```markdown
# Project: Multi-Instance 3D Streaming Platform with WebSocket Communication

## Project Overview

Build a production-ready platform that allows users to access isolated 3D applications running on AWS EC2 instances via Epic Games Pixel Streaming. Each instance has its own UUID, time quotas, and tracks usage. Admin panel manages all instances. Real-time communication between player (on EC2) and backend uses WebSockets (Socket.io).

## Technology Stack

- **Backend**: Node.js + TypeScript + Express + Socket.io
- **Frontend**: HTML/CSS/TypeScript (no framework required)
- **Database**: JSON files (instances.json, usage logs) - can migrate to MongoDB later
- **Cloud**: AWS SDK v3 (EC2)
- **Real-time**: Socket.io (server + client)
- **Authentication**: Simple session-based admin auth (express-session + bcrypt)

## Project Structure

```
project-root/
├── src/
│   ├── server.ts                    # Main entry point
│   ├── app.ts                       # Express app setup
│   ├── config/
│   │   ├── index.ts                 # Configuration loader
│   │   └── database.ts              # JSON file operations
│   ├── types/
│   │   ├── instance.types.ts        # TypeScript interfaces
│   │   ├── session.types.ts
│   │   └── api.types.ts
│   ├── services/
│   │   ├── instanceService.ts       # Instance CRUD operations
│   │   ├── ec2Service.ts            # AWS EC2 operations
│   │   ├── timeTrackerService.ts    # Time quota management
│   │   └── websocketService.ts      # Socket.io handlers
│   ├── controllers/
│   │   ├── instanceController.ts    # API routes handlers
│   │   ├── adminController.ts       # Admin routes
│   │   └── websocketController.ts   # WebSocket event handlers
│   ├── middleware/
│   │   ├── auth.ts                  # Admin auth middleware
│   │   ├── validation.ts            # Request validation
│   │   └── errorHandler.ts          # Global error handler
│   ├── routes/
│   │   ├── instanceRoutes.ts        # Public instance API
│   │   ├── adminRoutes.ts           # Admin API
│   │   └── webRoutes.ts             # HTML page routes
│   ├── utils/
│   │   ├── logger.ts                # Logging utility
│   │   ├── uuid.ts                  # UUID generation
│   │   └── constants.ts             # App constants
│   └── data/
│       ├── instances.json           # Main instance registry
│       └── usage-history/           # Per-instance usage logs
├── public/
│   ├── css/
│   │   ├── main.css                 # Global styles
│   │   └── admin.css                # Admin panel styles
│   ├── js/
│   │   ├── client.ts                # Compiled JS
│   │   ├── instance-page.ts         # Instance landing page logic
│   │   ├── admin.ts                 # Admin panel logic
│   │   └── socket.io-client.js      # Socket.io client (from CDN)
│   ├── index.html                   # Main landing (redirects or shows instances)
│   ├── instance.html                # Instance-specific landing page
│   └── admin.html                   # Admin dashboard
├── webserver-aws/                   # Pixel Streaming files (copy as-is)
│   ├── player.html
│   └── player.js                    # WILL BE MODIFIED to use WebSockets
├── scripts/
│   ├── deploy.sh                    # Deployment script
│   └── seed-instances.ts            # Seed initial instances
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Data Structures (TypeScript Interfaces)

```typescript
// types/instance.types.ts

export interface Instance {
  uuid: string;                       // Public-facing unique identifier
  instanceId: string;                 // AWS EC2 instance ID
  displayLimitHours: number;          // User quota in hours
  realLimitHours: number;             // Internal reserve quota
  displayTimeUsedSeconds: number;     // Accumulated user time
  realTimeUsedSeconds: number;        // Accumulated reserve time
  status: 'stopped' | 'running' | 'pending' | 'stopping' | 'terminated';
  createdAt: string;                  // ISO timestamp
  lastActiveAt: string;               // ISO timestamp
  assignedTo: string | null;          // Optional client name
  ec2Config: {
    instanceType: string;             // e.g., 'g4dn.2xlarge'
    region: string;                   // e.g., 'us-east-2'
    amiId: string;                    // AMI with Pixel Streaming configured
    securityGroupId: string;
    subnetId: string;
  };
}

export interface Session {
  socketId: string;                   // Socket.io connection ID
  hostToken: string;                  // Random token for this session
  lastSeenAt: number;                 // Unix timestamp (ms)
  displayStarted: boolean;            // Whether display timer is active
  ipAddress: string;                  // Client IP for logging
}

export interface InstanceWithSessions extends Instance {
  activeSessions: Map<string, Session>; // socketId → Session
}

export interface InstanceRegistry {
  instances: Record<string, InstanceWithSessions>;
  lastBackup: string;                 // ISO timestamp
  version: number;                    // Schema version
}

// types/api.types.ts

export interface CreateInstanceRequest {
  displayLimitHours: number;
  realLimitHours: number;
  assignedTo?: string;
  instanceType?: string;              // Default from .env
}

export interface UpdateQuotaRequest {
  displayLimitHours?: number;
  realLimitHours?: number;
}

export interface ConnectResponse {
  success: boolean;
  status: 'pending' | 'running' | 'stopped' | 'quota_exceeded';
  ip?: string;
  instanceUuid: string;
  message?: string;
  timeLeft?: {
    display: string;
    real: string;
  };
}

// types/websocket.types.ts

export interface WebSocketMessage {
  type: 'display-start' | 'heartbeat' | 'disconnect' | 'time-expired' | 'instance-stopping';
  instanceUuid: string;
  hostToken?: string;
  timestamp?: number;
  data?: any;
}

export interface HeartbeatData {
  instanceUuid: string;
  hostToken: string;
  timestamp: number;
}

export interface DisplayStartData {
  instanceUuid: string;
  hostToken: string;
  timestamp: number;
}
```

## Core Services Implementation

### 1. Database Service (JSON File Operations)

```typescript
// services/databaseService.ts

import fs from 'fs/promises';
import path from 'path';
import { InstanceRegistry, Instance, InstanceWithSessions } from '../types/instance.types';

const DATA_DIR = path.join(process.cwd(), 'src/data');
const INSTANCES_FILE = path.join(DATA_DIR, 'instances.json');

export class DatabaseService {
  private static instance: DatabaseService;
  private cache: InstanceRegistry | null = null;
  private saveTimeout: NodeJS.Timeout | null = null;

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  async init(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const data = await fs.readFile(INSTANCES_FILE, 'utf-8');
      this.cache = JSON.parse(data);
    } catch {
      this.cache = { instances: {}, lastBackup: new Date().toISOString(), version: 1 };
      await this.persist();
    }
  }

  async persist(): Promise<void> {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    return new Promise((resolve) => {
      this.saveTimeout = setTimeout(async () => {
        await fs.writeFile(INSTANCES_FILE, JSON.stringify(this.cache, null, 2));
        resolve();
      }, 100); // Debounce saves
    });
  }

  getInstances(): Record<string, InstanceWithSessions> {
    return this.cache?.instances || {};
  }

  getInstance(uuid: string): InstanceWithSessions | null {
    return this.cache?.instances[uuid] || null;
  }

  async saveInstance(uuid: string, instance: InstanceWithSessions): Promise<void> {
    if (!this.cache) return;
    this.cache.instances[uuid] = instance;
    await this.persist();
  }

  async deleteInstance(uuid: string): Promise<boolean> {
    if (!this.cache?.instances[uuid]) return false;
    delete this.cache.instances[uuid];
    await this.persist();
    return true;
  }
}
```

### 2. EC2 Service (AWS SDK v3)

```typescript
// services/ec2Service.ts

import { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { config } from '../config';

export class EC2Service {
  private client: EC2Client;

  constructor() {
    this.client = new EC2Client({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  async startInstance(instanceId: string): Promise<{ success: boolean; state: string }> {
    const command = new StartInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true, state: 'pending' };
  }

  async stopInstance(instanceId: string): Promise<{ success: boolean; state: string }> {
    const command = new StopInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true, state: 'stopping' };
  }

  async terminateInstance(instanceId: string): Promise<{ success: boolean }> {
    const command = new TerminateInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true };
  }

  async getInstanceStatus(instanceId: string): Promise<{ state: string; ip: string | null }> {
    const command = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
    const response = await this.client.send(command);
    const instance = response.Reservations?.[0]?.Instances?.[0];
    return {
      state: instance?.State?.Name || 'unknown',
      ip: instance?.PublicIpAddress || null,
    };
  }

  async createInstance(instanceType: string, amiId: string): Promise<{ instanceId: string }> {
    const command = new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: instanceType,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [config.AWS_SECURITY_GROUP_ID],
      SubnetId: config.AWS_SUBNET_ID,
    });
    const response = await this.client.send(command);
    const instanceId = response.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error('Failed to create instance');
    return { instanceId };
  }
}
```

### 3. WebSocket Service

```typescript
// services/websocketService.ts

import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { DatabaseService } from './databaseService';
import { TimeTrackerService } from './timeTrackerService';
import { EC2Service } from './ec2Service';
import { WebSocketMessage, HeartbeatData, DisplayStartData } from '../types/websocket.types';
import { randomUUID } from 'crypto';

export class WebSocketService {
  private io: SocketServer;
  private db: DatabaseService;
  private timeTracker: TimeTrackerService;
  private ec2Service: EC2Service;
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(server: HttpServer) {
    this.io = new SocketServer(server, {
      cors: {
        origin: '*', // Configure appropriately for production
        methods: ['GET', 'POST'],
      },
      pingTimeout: 30000,  // 30 seconds
      pingInterval: 25000, // 25 seconds
    });
    this.db = DatabaseService.getInstance();
    this.timeTracker = TimeTrackerService.getInstance();
    this.ec2Service = new EC2Service();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log(`[WebSocket] Client connected: ${socket.id}`);

      // Join instance room
      socket.on('join-instance', (instanceUuid: string) => {
        socket.join(`instance:${instanceUuid}`);
        console.log(`[WebSocket] Socket ${socket.id} joined instance ${instanceUuid}`);
      });

      // Handle display start
      socket.on('display-start', async (data: DisplayStartData) => {
        await this.handleDisplayStart(socket, data);
      });

      // Handle heartbeat
      socket.on('heartbeat', async (data: HeartbeatData) => {
        await this.handleHeartbeat(socket, data);
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        await this.handleDisconnect(socket);
      });
    });
  }

  private async handleDisplayStart(socket: Socket, data: DisplayStartData): Promise<void> {
    const instance = this.db.getInstance(data.instanceUuid);
    if (!instance) {
      socket.emit('error', { message: 'Instance not found' });
      return;
    }

    // Check quotas
    const displayUsed = instance.displayTimeUsedSeconds;
    const displayMax = instance.displayLimitHours * 3600;
    const realUsed = instance.realTimeUsedSeconds;
    const realMax = instance.realLimitHours * 3600;

    if (displayUsed >= displayMax || realUsed >= realMax) {
      socket.emit('quota-exceeded', { message: 'Time limit exceeded' });
      await this.stopInstanceAndNotify(instance.uuid);
      return;
    }

    // Create or update session
    const hostToken = data.hostToken || randomUUID();
    const session = {
      socketId: socket.id,
      hostToken,
      lastSeenAt: Date.now(),
      displayStarted: true,
      ipAddress: socket.handshake.address,
    };

    instance.activeSessions.set(socket.id, session);
    
    // Start display timer if not already running
    if (!instance.displayTimeUsedSeconds || instance.displayTimeUsedSeconds === 0) {
      // Track start time in memory
      this.timeTracker.startDisplayTimer(data.instanceUuid);
    }

    await this.db.saveInstance(data.instanceUuid, instance);
    socket.emit('display-started', { success: true });
    
    // Start heartbeat monitoring
    this.startHeartbeatMonitor(socket.id, data.instanceUuid, hostToken);
  }

  private async handleHeartbeat(socket: Socket, data: HeartbeatData): Promise<void> {
    const instance = this.db.getInstance(data.instanceUuid);
    if (!instance) return;

    const session = instance.activeSessions.get(socket.id);
    if (session && session.hostToken === data.hostToken) {
      session.lastSeenAt = Date.now();
      await this.db.saveInstance(data.instanceUuid, instance);
      socket.emit('heartbeat-ack', { timestamp: Date.now() });
    }
  }

  private async handleDisconnect(socket: Socket): Promise<void> {
    // Find which instance this socket belongs to
    for (const [uuid, instance] of Object.entries(this.db.getInstances())) {
      if (instance.activeSessions.has(socket.id)) {
        const session = instance.activeSessions.get(socket.id);
        instance.activeSessions.delete(socket.id);
        
        // Stop heartbeat monitor
        this.stopHeartbeatMonitor(socket.id);
        
        // If no more active sessions, start grace period
        if (instance.activeSessions.size === 0 && session?.displayStarted) {
          this.timeTracker.startGracePeriod(uuid, async () => {
            await this.stopInstanceAndNotify(uuid);
          });
        }
        
        await this.db.saveInstance(uuid, instance);
        break;
      }
    }
  }

  private startHeartbeatMonitor(socketId: string, instanceUuid: string, hostToken: string): void {
    const interval = setInterval(async () => {
      const instance = this.db.getInstance(instanceUuid);
      const session = instance?.activeSessions.get(socketId);
      
      if (!session || session.hostToken !== hostToken) {
        this.stopHeartbeatMonitor(socketId);
        return;
      }
      
      const now = Date.now();
      if (now - session.lastSeenAt > 35000) { // 35 seconds timeout
        // Session expired
        instance.activeSessions.delete(socketId);
        await this.db.saveInstance(instanceUuid, instance);
        this.stopHeartbeatMonitor(socketId);
        
        if (instance.activeSessions.size === 0) {
          this.timeTracker.startGracePeriod(instanceUuid, async () => {
            await this.stopInstanceAndNotify(instanceUuid);
          });
        }
      }
    }, 10000);
    
    this.heartbeatIntervals.set(socketId, interval);
  }

  private stopHeartbeatMonitor(socketId: string): void {
    const interval = this.heartbeatIntervals.get(socketId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(socketId);
    }
  }

  private async stopInstanceAndNotify(instanceUuid: string): Promise<void> {
    const instance = this.db.getInstance(instanceUuid);
    if (!instance || instance.status !== 'running') return;
    
    // Stop EC2 instance
    await this.ec2Service.stopInstance(instance.instanceId);
    instance.status = 'stopping';
    await this.db.saveInstance(instanceUuid, instance);
    
    // Notify all connected clients in this instance room
    this.io.to(`instance:${instanceUuid}`).emit('instance-stopping', {
      message: 'Instance is stopping due to inactivity or quota exhaustion',
      timestamp: Date.now(),
    });
  }

  // Broadcast to all clients in an instance
  broadcastToInstance(instanceUuid: string, event: string, data: any): void {
    this.io.to(`instance:${instanceUuid}`).emit(event, data);
  }
}
```

### 4. Time Tracker Service

```typescript
// services/timeTrackerService.ts

import { DatabaseService } from './databaseService';
import { EventEmitter } from 'events';

export class TimeTrackerService extends EventEmitter {
  private static instance: TimeTrackerService;
  private db: DatabaseService;
  private displayTimers: Map<string, NodeJS.Timeout> = new Map();
  private realTimers: Map<string, NodeJS.Timeout> = new Map();
  private gracePeriodTimers: Map<string, NodeJS.Timeout> = new Map();
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  static getInstance(): TimeTrackerService {
    if (!TimeTrackerService.instance) {
      TimeTrackerService.instance = new TimeTrackerService();
    }
    return TimeTrackerService.instance;
  }

  private constructor() {
    super();
    this.db = DatabaseService.getInstance();
    this.startGlobalInterval();
  }

  private startGlobalInterval(): void {
    // Every second, update time for all active instances
    setInterval(async () => {
      const instances = this.db.getInstances();
      let changed = false;
      
      for (const [uuid, instance] of Object.entries(instances)) {
        let updated = false;
        
        // Update display time if any active session with displayStarted
        const hasActiveDisplay = Array.from(instance.activeSessions.values()).some(s => s.displayStarted);
        if (hasActiveDisplay && this.displayTimers.has(uuid)) {
          instance.displayTimeUsedSeconds += 1;
          updated = true;
          
          // Check if display quota exceeded
          const displayMax = instance.displayLimitHours * 3600;
          if (instance.displayTimeUsedSeconds >= displayMax) {
            this.emit('display-quota-exceeded', uuid);
          }
        }
        
        // Update real time if instance is running
        if (instance.status === 'running' && this.realTimers.has(uuid)) {
          instance.realTimeUsedSeconds += 1;
          updated = true;
          
          const realMax = instance.realLimitHours * 3600;
          if (instance.realTimeUsedSeconds >= realMax) {
            this.emit('real-quota-exceeded', uuid);
          }
        }
        
        if (updated) {
          await this.db.saveInstance(uuid, instance);
          changed = true;
        }
      }
    }, 1000);
  }

  startDisplayTimer(instanceUuid: string): void {
    if (!this.displayTimers.has(instanceUuid)) {
      this.displayTimers.set(instanceUuid, setTimeout(() => {}, 0));
    }
  }

  stopDisplayTimer(instanceUuid: string): void {
    const timer = this.displayTimers.get(instanceUuid);
    if (timer) {
      clearTimeout(timer);
      this.displayTimers.delete(instanceUuid);
    }
  }

  startRealTimer(instanceUuid: string): void {
    if (!this.realTimers.has(instanceUuid)) {
      this.realTimers.set(instanceUuid, setTimeout(() => {}, 0));
    }
  }

  stopRealTimer(instanceUuid: string): void {
    const timer = this.realTimers.get(instanceUuid);
    if (timer) {
      clearTimeout(timer);
      this.realTimers.delete(instanceUuid);
    }
  }

  startGracePeriod(instanceUuid: string, onTimeout: () => Promise<void>): void {
    // Clear existing grace period
    const existing = this.gracePeriodTimers.get(instanceUuid);
    if (existing) clearTimeout(existing);
    
    // Start new 60-second grace period
    const timer = setTimeout(async () => {
      await onTimeout();
      this.gracePeriodTimers.delete(instanceUuid);
    }, 60000);
    
    this.gracePeriodTimers.set(instanceUuid, timer);
  }

  cancelGracePeriod(instanceUuid: string): void {
    const timer = this.gracePeriodTimers.get(instanceUuid);
    if (timer) {
      clearTimeout(timer);
      this.gracePeriodTimers.delete(instanceUuid);
    }
  }
}
```

## API Endpoints

### Public Routes (No Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/instance/:uuid` | Serve instance landing page |
| GET | `/api/instances/:uuid/status` | Get instance status and quota |
| POST | `/api/instances/:uuid/connect` | Connect to instance (returns status + IP) |
| GET | `/api/instances/:uuid/balance` | Get remaining time |
| POST | `/api/instances/:uuid/ping` | Ping check (HTTP fallback) |

### Admin Routes (Auth Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Login with username/password |
| POST | `/api/admin/logout` | Logout |
| GET | `/api/admin/instances` | List all instances |
| POST | `/api/admin/instances` | Create new instance |
| GET | `/api/admin/instances/:uuid` | Get instance details |
| PUT | `/api/admin/instances/:uuid` | Update instance (quotas, assignedTo) |
| DELETE | `/api/admin/instances/:uuid` | Delete/terminate instance |
| POST | `/api/admin/instances/:uuid/start` | Start instance |
| POST | `/api/admin/instances/:uuid/stop` | Stop instance |
| POST | `/api/admin/instances/:uuid/terminate` | Terminate instance (permanent) |

## WebSocket Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join-instance` | `{ instanceUuid: string }` | Join instance room |
| `display-start` | `{ instanceUuid, hostToken?, timestamp }` | Start display timer |
| `heartbeat` | `{ instanceUuid, hostToken, timestamp }` | Keep session alive |
| `disconnect` | (automatic) | Handle disconnection |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `display-started` | `{ success: boolean }` | Confirmation |
| `heartbeat-ack` | `{ timestamp: number }` | Heartbeat response |
| `quota-exceeded` | `{ message: string }` | Time limit reached |
| `instance-stopping` | `{ message: string, timestamp }` | Instance is stopping |
| `error` | `{ message: string }` | Error message |

## Modified player.js (on EC2)

```javascript
// Add to existing player.js

// Socket.io connection to backend
const backendUrl = new URLSearchParams(window.location.search).get('backendUrl') || 'http://localhost:3000';
const instanceUuid = new URLSearchParams(window.location.search).get('instanceUuid');
const socket = io(backendUrl);

let hostToken = localStorage.getItem('hostToken');
let heartbeatInterval = null;

socket.on('connect', () => {
    console.log('[Socket] Connected to backend');
    
    // Join instance room
    socket.emit('join-instance', instanceUuid);
    
    // Send display start
    socket.emit('display-start', {
        instanceUuid,
        hostToken,
        timestamp: Date.now()
    });
    
    // Start heartbeat (every 10 seconds)
    heartbeatInterval = setInterval(() => {
        socket.emit('heartbeat', {
            instanceUuid,
            hostToken,
            timestamp: Date.now()
        });
    }, 10000);
});

socket.on('display-started', (data) => {
    console.log('[Socket] Display started', data);
    if (data.hostToken) {
        localStorage.setItem('hostToken', data.hostToken);
        hostToken = data.hostToken;
    }
});

socket.on('heartbeat-ack', (data) => {
    // Heartbeat confirmed, do nothing
});

socket.on('quota-exceeded', (data) => {
    console.error('[Socket] Quota exceeded:', data.message);
    alert('Your time limit has been exceeded. The session will end now.');
    // Optionally redirect or show message
});

socket.on('instance-stopping', (data) => {
    console.warn('[Socket] Instance stopping:', data.message);
    alert('The instance is stopping due to inactivity or time limit.');
});

socket.on('disconnect', () => {
    console.log('[Socket] Disconnected from backend');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    socket.disconnect();
});
```

## Environment Variables (.env)

```env
# Server
PORT=3000
NODE_ENV=production

# AWS Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-2
AWS_SECURITY_GROUP_ID=sg-xxxxx
AWS_SUBNET_ID=subnet-xxxxx
AWS_AMI_ID=ami-xxxxx  # AMI with Pixel Streaming configured
DEFAULT_INSTANCE_TYPE=g4dn.2xlarge

# Admin Auth
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=$2b$10$...  # bcrypt hash
SESSION_SECRET=your_random_secret_here

# Session
HEARTBEAT_TIMEOUT_MS=30000
GRACE_PERIOD_MS=60000
SESSION_CLEANUP_INTERVAL_MS=10000
QUOTA_CHECK_INTERVAL_MS=30000
```

## Admin Panel Features

### Login Page
- Simple form with username/password
- Session-based authentication (express-session)

### Dashboard
- **Header**: Welcome message, Logout button, Create Instance button
- **Instances Table**:
  | UUID | Assigned To | Status | Display Time | Real Time | Last Active | Actions |
  |------|-------------|--------|--------------|-----------|-------------|---------|
  | abc... | Client A | 🟢 Running | 1.2h/3h | 4.5h/9h | 2 min ago | [Start] [Stop] [Edit] [Delete] [URL] |
- **Create Instance Modal**:
  - Display Limit (hours)
  - Real Limit (hours)
  - Assigned To (optional)
  - Instance Type (dropdown)
- **Edit Instance Modal**:
  - Edit quotas
  - Edit assigned to
  - View instance ID
- **Instance URL Modal**: Shows `https://domain.com/instance/{uuid}`

## Deployment Steps

### 1. Initial Setup
```bash
# Clone repository
git clone <repo-url>
cd project-root

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your values

# Build TypeScript
npm run build

# Seed initial instances (optional)
npm run seed
```

### 2. Run in Development
```bash
npm run dev
```

### 3. Run in Production
```bash
# Using PM2
npm run build
pm2 start dist/server.js --name pixelstreaming-backend

# Or using systemd (see example below)
```

### 4. Systemd Service (Linux)
```ini
# /etc/systemd/system/pixelstreaming.service
[Unit]
Description=Pixel Streaming Backend
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/project-root
ExecStart=/usr/bin/node dist/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 5. Nginx Reverse Proxy (Optional)
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Security Considerations

1. **Admin Authentication**: Use bcrypt for password hashing, express-session with secure options
2. **UUID Validation**: Always validate UUID format before using as lookup key
3. **Rate Limiting**: Implement on all API endpoints (express-rate-limit)
4. **CORS**: Configure properly for production (only allow your domain)
5. **Socket.io Security**:
   - Validate instanceUuid on connection
   - Implement rate limiting per socket
   - Use socket.io middleware for auth
6. **Input Validation**: Validate all request inputs (express-validator)
7. **HTTPS**: Use HTTPS in production (Let's Encrypt + Nginx)
8. **AWS Credentials**: Use IAM roles on EC2, never commit credentials

## Testing Strategy

### Local Testing with Mock EC2
```typescript
// scripts/mock-ec2.ts
// Simulate EC2 instance states for local development
```

### Test Scenarios
1. **Create instance** → Verify UUID generation and file storage
2. **Connect to instance** → Verify start sequence and status polling
3. **Display time tracking** → Verify time increments correctly
4. **Heartbeat timeout** → Simulate 30s inactivity, verify instance stops after 60s grace
5. **Quota exhaustion** → Set 5-second quota, verify instance stops
6. **Multi-device** → Connect two browsers, verify both see same stream
7. **Admin panel** → Test all CRUD operations
8. **WebSocket reconnection** → Test client reconnects after network drop

### Load Testing (Optional)
```bash
# Using artillery.io
npm install -g artillery
artillery run load-test.yml
```

## Monitoring & Logging

### Logging Strategy
```typescript
// Use winston or pino
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});
```

### Metrics to Track
- Active instances count
- Active WebSocket connections
- Time quota usage per instance
- EC2 start/stop events
- API response times
- Error rates

### Alerts (Configure via monitoring service)
- Instance fails to start (retry > 3 times)
- Quota exhaustion (90% threshold)
- High error rate (>5%)
- WebSocket connection drops

## Migration from Current Single-Instance

```typescript
// scripts/migrate-to-multi-instance.ts
// Reads current .txt files and creates first instance in instances.json
```

## Deliverables

Please provide:
1. Complete TypeScript implementation of all services and routes
2. HTML/CSS/JS for admin panel and instance pages
3. Modified player.js with WebSocket integration
4. package.json with all dependencies
5. tsconfig.json
6. Deployment scripts and documentation
7. README with setup instructions
8. Example .env file
9. Migration script for existing data
10. Socket.io client integration code for instance.html

## Questions to Answer in Documentation

1. How to handle AWS API rate limits when checking many instances?
2. What's the backup strategy for instances.json?
3. How to handle EC2 start failures (retry logic, dead letter queue)?
4. How to handle backend restart without losing active session state?
5. What's the recommended way to update Pixel Streaming AMI?
6. How to handle concurrent writes to instances.json (use file locking or queue)?
```

---

This is the complete prompt. Copy and paste this into Antigravity. It includes everything: architecture, TypeScript implementation, WebSocket integration, admin panel, deployment, and all the details from our discussion.

Let me know if you want me to adjust anything before you send it!