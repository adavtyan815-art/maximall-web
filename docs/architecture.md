# System Architecture

This document describes the high-level architecture of the Maximall pixel streaming management platform. The system operates across separate architectural components and network boundaries to deliver hot-standby GPU instances on AWS EC2, maintaining instant connection times (<2 seconds) for incoming users.

---

## 1. High-Level Component Layout

The platform consists of two completely independent software repositories running on separate runtime environments:

1. **`maximall-web` (Orchestrator Backend)**: A single-process Node.js TypeScript application. It manages database registries, schedules pool audit loops, tracks active timer states, communicates with AWS, and handles browser-to-backend WebSocket control sessions.
2. **`maximall-pixel-config` (Streamer Environment)**: Running on individual Windows/Linux GPU instances spawned from a custom AMI. It contains the Unreal Engine 3D app and Epic Games' Signaling Server, listening directly on local port 8000.

```mermaid
graph TD
    subgraph Client Space
        Client[Client Browser / Web Page]
    end

    subgraph Backend Server (maximall-web)
        App[Express HTTP / Socket.IO Server]
        Proxy[Node.js HTTP/WS Proxy]
        DB[DatabaseService - In-Memory Map]
        Scaling[ScalingService - Prewarm Loop]
        TimeTracker[TimeTrackerService - Timers & Grace]
        EC2[EC2Service - AWS SDK Integration]
        
        App <--> DB
        Proxy <--> DB
        Scaling -->|Polls Live IP/Status| EC2
        Scaling -->|Saves state| DB
        TimeTracker -->|Grace countdowns| Scaling
    end

    subgraph Standalone EC2 Instance (maximall-pixel-config)
        Signalling[Signalling Web Server]
        UE[Unreal Engine 5 Streamer]
        
        UE <-->|WebSockets| Signalling
    end

    subgraph Cloud Infrastructure
        AWS[AWS EC2 API]
    end

    %% Communications
    Client <-->|HTTP / Socket.IO Control| App
    Client <-->|Proxied HTTP & WSS| Proxy
    Proxy <-->|Local HTTP & WS| Signalling
    Client <-->|WebRTC Video / Audio UDP| UE
    EC2 <-->|AWS SDK v3| AWS
    AWS <-->|Create / Start / Stop / Terminate| StandaloneInstance[EC2 GPU Instance]
    Signalling -->|POST /api/instances/:uuid/streamer-disconnected| App
```

---

## 2. Communication Across Network Boundaries

Because the backend orchestrator and the stream-rendering nodes are separate components, they communicate across network boundaries using specific protocols:

### A. HTTP & WebSocket Control Sessions (Client <--> Orchestrator)
- **Status Audits**: The client browser queries `/api/instances/:uuid/status` during the loading stage.
- **WebSocket Handshake**: The browser connects to `websocketService.ts` via Socket.IO.
- **Inactivity Heartbeats**: The browser emits periodic `user-activity` (user interacting) or `heartbeat` (connection verification) events to reset the backend's idle timeout timers.

### B. Public IP Registry (Instance <--> Orchestrator)
- When an EC2 instance boots, its dynamic public IP is retrieved by the orchestrator via the AWS EC2 API and saved in the Database.
- This mapping allows the orchestrator to route and proxy the client's HTTP assets and WebSocket signaling connection directly to that specific instance.

### C. Streamer Verification & Handshake (Orchestrator <--> Signaling Server)
- During the pre-warm lifecycle, the orchestrator's `ScalingService` opens a WebSocket connection directly to the instance's public IP (`ws://<publicIp>:80/`) and queries `{"type": "listStreamers"}`.
- It verifies that Epic Games' `DefaultStreamer` ID is active, ensuring the Unreal Engine rendering process is fully initialized before shutting down the instance into the stopped pool.

### D. Disconnection Notification Webhook (Signalling Server --> Orchestrator)
- If the Unreal Engine app on the instance crashes or is forcefully closed, the signaling server's `streamerRegistry` detects the removal of the streamer.
- It immediately sends a POST request to the backend's `/api/instances/:uuid/streamer-disconnected` webhook endpoint.
- Upon receiving this webhook, the orchestrator triggers the 60-second grace period (or terminates the instance immediately), avoiding resource leaks and unnecessary AWS costs.

---

## 3. Core Service Modules (`maximall-web`)

- **Express Server & WebSocket Service (`app.ts` / `websocketService.ts`)**: Handles routing, client control rooms, and websocket event tracking (including inactivity countdowns).
- **Scaling Service (`scalingService.ts`)**: Runs a perpetual 60-second reconciliation loop auditing the buffer pool and manages the 5-phase prewarm state machine (BOOT → TUNNEL → SIGNAL → STREAMER → STOP). The target buffer size is admin-controlled (default `0` — passive on startup). Also exposes `realignPool(baseTarget, extraBoost)` for on-demand bidirectional pool alignment triggered by the admin Dashboard button.
- **EC2 Service (`ec2Service.ts`)**: Wraps all AWS SDK client interactions (`RunInstances`, `TerminateInstances`, `StartInstances`, `StopInstances`, `DescribeImages`).
- **Time Tracker Service (`timeTrackerService.ts`)**: Manages the 60-second grace period countdown when websocket sessions disconnect, stopping the instance if reconnect fails. Also tracks instance running times and enforces the 60-second minimum billing charge rule.
- **Database Service (`databaseService.ts`)**: An in-memory Map store registry tracking live instance metadata. Also maintains a global archived time accumulator (`totalArchivedSeconds`) to preserve historical run times of terminated instances.
- **Settings Service (`settingsService.ts`)**: Pure in-memory key/value store for runtime configuration. Persists `minBufferTarget` and `lastExtraBoost` (set by the admin via `POST /api/admin/pool/realign`) so the auto-loop always reads the correct floor and any browser login restores the active pool configuration from `GET /api/settings`.

For full implementation details, configurations, and billing logic rules, refer to [Server Cost Tracking & Billing Architecture](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/docs/billing.md).

