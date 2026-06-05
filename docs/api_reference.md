# API & WebSocket Reference

This document maps all REST API endpoints and Socket.IO WebSocket events exposed by the `maximall-web` backend service.

---

## 1. HTTP REST Endpoints

### A. Admin Dashboard & Actions

#### `GET /api/admin/dashboard`
- **Description**: Returns a categorized summary of all active instances, ready buffer instances, and prewarm stages, alongside global statistics. Automatically queries AWS live state for any instance stuck in `pending` or `stopping` states to self-heal the database.
- **Response Shape**:
  ```json
  {
    "activeSessions": [
      {
        "uuid": "i-017a8...",
        "instanceId": "i-017a8...",
        "status": "running",
        "assignedTo": "OnDemand-017a8f",
        "pinggyUrl": "https://yojuq-3-127-235-136.run.pinggy-free.link",
        "createdAt": "2026-06-04T11:14:26.000Z",
        "inGracePeriod": false,
        "realTimeUsedSeconds": 240
      }
    ],
    "bufferReady": [],
    "prewarm": [],
    "stats": {
      "activeSessions": 1,
      "bufferReady": 0,
      "prewarm": 0,
      "gracePeriod": 0,
      "totalTimeSeconds": 240
    }
  }
  ```

#### `POST /api/admin/instances/sync`
- **Description**: Triggers a manual audit. Discovers LinuxClient instances in AWS, updates the in-memory database, and forces a prewarm pool replenishment audit.
- **Response Shape**: `{ "success": true, "count": 3 }`

#### `POST /api/admin/instances/:uuid/start`
- **Description**: Sends an AWS `StartInstancesCommand` for the instance. Sets status to `pending`.
- **Response Shape**: `{ "success": true, "status": "pending" }`

#### `POST /api/admin/instances/:uuid/stop`
- **Description**: Sends an AWS `StopInstancesCommand` for the instance. Sets status to `stopping`.
- **Response Shape**: `{ "success": true, "status": "stopping" }`

#### `DELETE /api/admin/instances/:uuid`
- **Description**: Terminates the instance on AWS (`TerminateInstancesCommand`) and removes it from the database.
- **Response Shape**: `{ "success": true }`

#### `POST /api/admin/instances/:uuid/abort-prewarm`
- **Description**: Stops and terminates an active prewarm instance, canceling its lifecycle.
- **Response Shape**: `{ "success": true }`

#### `POST /api/admin/login`
- **Description**: Authenticates the administrator session. On success, asynchronously triggers `performAwsSyncAndBufferAudit` in the background to automatically synchronize with AWS and replenish the buffer pool if needed.
- **Response Shape**: `{ "success": true }`

---

### B. Client & Node Integrations

#### `POST /api/instances/connect-available`
- **Description**: Invoked when a client clicks "ВОЙТИ В 3D КОМНАТУ". Evaluates whether a stopped buffer instance is available:
  - If a buffer instance exists, it claims it, wakes it up via AWS `StartInstancesCommand`, and triggers a pool replenishment prewarm task in the background.
  - If the buffer is empty, it falls back to dynamically spawning a fresh on-demand instance.
- **Response Shape**: `{ "success": true, "uuid": "i-017a8...", "status": "pending", "hostToken": "auth_token_string" }`

#### `POST /api/instances/report-tunnel`
- **Description**: Request sent by the Pinggy/Wilbur tunneling script running inside the EC2 instance boot process. Updates the instance's live configuration (`pinggyUrl`).
- **Body Shape**: `{ "instanceId": "i-xxxxx", "pinggyUrl": "http://xxxx.pinggy.link" }`
- **Response Shape**: `{ "success": true }`

#### `GET /api/instances/:uuid/status`
- **Description**: Used by the loading webpage to check the readiness of an instance during boot.
- **Response Shape**: `{ "status": "running", "pinggyUrl": "http://xxx.pinggy.link" }`

#### `POST /api/instances/:uuid/streamer-disconnected`
- **Description**: Webhook endpoint invoked by the external `maximall-pixel-config` Signaling Server when the Unreal Engine streamer closes, crashes, or is removed.
- **Headers**: Requires a matching `Content-Type: application/json` header and a valid shared secret configuration.
- **Body Shape**:
  ```json
  {
    "streamerId": "DefaultStreamer",
    "secret": "your_shared_secret"
  }
  ```
- **Response Shape**: `{ "success": true, "message": "Disconnection registered" }` or `{ "error": "Unauthorized" }`

---

## 2. WebSocket Protocols (Socket.IO)

The WebSocket Service manages client routing state using dynamic room groups and events.

### A. Client Signals (Inbound)

- **`request-instance`** (`{ instanceUuid, hostToken }`)
  - Validates instance state and security token. Connects the socket to the instance room `instance:{uuid}` and starts the AWS Status polling routine.
- **`join-instance`** (`{ instanceUuid, hostToken }`)
  - Associates the socket session to the instance for device communication.
- **`display-start`** (`{ token }`)
  - Dispatched by the frontend streamer script when the WebRTC/Pixel Streaming video feed successfully initializes. Sets session timer running.
- **`heartbeat`** (`{ token }`)
  - Sent periodically to verify the viewer's presence. Resets connection watchdog timers.
- **`user-activity`** (`{ instanceUuid, hostToken, deviceId }`)
  - Sent by the browser client when it registers user interactions (mouse move, key press, touch action) to keep the session active and reset backend inactivity timers.

### B. Server Messages (Outbound)

- **`instance-status`** (`{ status: 'booting_server' | 'running' | 'stopped' }`)
  - Broadcasts boot progression updates to the client waiting-screen.
- **`server-ready`** (`{ pinggyUrl }`)
  - Signals to the frontend that the instance is ready to stream. Redirects the client to the instance's Pinggy URL.
- **`idle-warning`** (`{ remainingMs }`)
  - Transmitted to the browser client when the idle timeout threshold is hit, prompting the client to display the glassmorphic countdown modal.
- **`idle-timeout`**
  - Transmitted to the browser client when the 30-second warning countdown expires, prompting the frontend to redirect back to `index.html`.
- **`instance-stopping`**
  - Broadcasts to all sockets in the instance room that the host EC2 instance is shutting down.
- **`force-logout`**
  - Emitted to log out active admin panel sessions.
