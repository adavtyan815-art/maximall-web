# System Architecture

This document describes the high-level architecture of the Maximall pixel streaming management platform. The system operates across separate architectural components and network boundaries to deliver hot-standby GPU instances on AWS EC2, maintaining instant connection times (<2 seconds) for incoming users with resilient multi-buffer fallback, private-IP routing, and automated recycling.

---

## 1. High-Level Component Layout

The platform consists of two main environments:

1. **`maximall-web` (Orchestrator Backend)**: A single-process Node.js TypeScript application. It manages database registries, schedules pool audit loops, tracks active timer states, communicates with AWS, and handles browser-to-backend WebSocket control sessions and reverse proxies.
2. **`maximall-pixel-config` (GPU Streamer Environment)**: Running on individual Linux GPU instances (`g4dn.2xlarge` with NVIDIA Tesla T4) spawned from custom AMI `LinuxClientAMI` (`ami-0f5cd2491b874e083`). It contains the Unreal Engine 3D application and Epic Games' Signalling Web Server (Wilbur), listening on port 8000 (HTTP & WebSocket) and 8888 (internal streamer).

```mermaid
graph TD
    subgraph Client Space
        Client[Client Browser / Web Page]
    end

    subgraph Backend Server (maximall-web - i-077a8a8febf8aa7fa)
        App[Express HTTP / Socket.IO Server]
        Proxy[Node.js HTTP & WS Reverse Proxy]
        DB[DatabaseService - In-Memory Map]
        Scaling[ScalingService - Base/Extra State Machine]
        TimeTracker[TimeTrackerService - Timers, Heartbeat & Grace]
        EC2[EC2Service - Multi-AZ AWS SDK v3]
        
        App <--> DB
        Proxy <--> DB
        Scaling -->|Polls Private IP / Status| EC2
        Scaling -->|Saves state| DB
        TimeTracker -->|Grace countdowns| Scaling
    end

    subgraph AWS VPC (vpc-0f621ae5f57c2a743)
        subgraph Subnet eu-central-1b
            GPU1[GPU Instance 1 - 172.31.47.x]
        end
        subgraph Subnet eu-central-1c
            GPU2[GPU Instance 2 - 172.31.4.x]
        end
        subgraph Subnet eu-central-1a
            GPU3[GPU Instance 3 - 172.31.x.x]
        end
    end

    %% Communications
    Client <-->|HTTPS / WSS Control| App
    Client <-->|Proxied HTTP & WSS /instance/:uuid/*| Proxy
    Proxy <-->|Intra-VPC Private IP:8000| GPU1
    Proxy <-->|Intra-VPC Private IP:8000| GPU2
    Client <-->|Direct WebRTC UDP 49152-65535| GPU1
    Client <-->|Direct WebRTC UDP 49152-65535| GPU2
    EC2 <-->|AWS SDK v3: Multi-AZ Run/Start/Stop| AWS[AWS EC2 API]
```

---

## 2. Communication & Routing Architecture

### A. Private-IP-First Intra-VPC Communication
Internal communication between the orchestrator backend and GPU instances (readiness polling, prewarm streamer verification, HTTP reverse proxy, and WebSocket signaling proxy) prioritizes `privateIp` (`172.31.x.x`), with `publicIp` preserved as a fallback:
- **Sub-millisecond latency (0.001s)**: Eliminates public internet gateway round-trips.
- **Immediate availability**: Private IP is assigned immediately on network interface attachment.
- **No external attack surface**: Internal signaling and status probes stay inside the VPC security boundary (`sg-0b4473181de272289`).

### B. Client Reverse-Proxying (HTTP & WebSocket)
The user's browser **never** connects directly to the GPU instance's IP address:
- **HTTP Assets**: `/instance/:uuid/player.html` and `/instance/:uuid/player.js` are proxied via `src/app.ts` to `http://${privateIp}:8000/`.
- **WebSocket Signaling**: `wss://domain/instance/:uuid/ws` is proxied via `src/server.ts` to `ws://${privateIp}:8000/` with a 500-message FIFO buffer to prevent message loss during connection handshakes.
- **WebRTC Media**: Audio/Video RTP and DataChannels flow directly between the client browser and the GPU instance via UDP ports `49152-65535` negotiated via STUN/TURN (`stun.l.google.com:19302`).

### C. Multi-AZ Subnet Discovery & Placement
`EC2Service.getAvailableSubnets()` dynamically discovers all public subnets within `vpc-0f621ae5f57c2a743` across all Availability Zones (`eu-central-1a`, `eu-central-1b`, `eu-central-1c`). If an AZ encounters `InsufficientInstanceCapacity` during `RunInstances`, the service automatically falls back to the next available AZ.

---

## 3. Core Service Modules (`maximall-web`)

- **`src/app.ts`**: Express application handling authentication, admin endpoints, `/api/instances/connect-available`, and HTTP asset reverse proxying (`/instance/:uuid/*`).
- **`src/server.ts`**: HTTP/WebSocket server bootstrapping and WebSocket reverse proxying (`/instance/:uuid/ws`).
- **`src/services/websocketService.ts`**: Socket.io control session manager, handling client connections, auto-resume, multi-tab protection (`session-in-use`), status polling, heartbeat tracking, 15s flicker recovery, and 60s grace periods.
- **`src/services/scalingService.ts`**: Base/Extra pool state machine, 60-second reconcile loop, prewarm lifecycle, multi-buffer claim, claim rollback, and safe instance recycling (`recycleInstanceToBuffer`).
- **`src/services/ec2Service.ts`**: AWS SDK v3 wrapper for EC2 operations (`RunInstancesCommand`, `StartInstancesCommand`, `StopInstancesCommand`, `DescribeInstancesCommand`, `DescribeSubnetsCommand`).
- **`src/services/timeTrackerService.ts`**: Display vs Real timer manager, enforcing minimum 60-second billing increments and tracking session durations.
- **`src/services/databaseService.ts`**: In-memory registry with atomic Map operations and disk save checkpoints.
- **`src/services/settingsService.ts`**: Runtime persistence for `minBufferTarget` (Base) and `lastExtraBoost` (Extra).

