# PRODUCTION-READINESS FORENSIC AUDIT REPORT

**Project:** `maximall-web` (Orchestrator Backend)  
**Repository State:** `main` branch @ `4fbbc35490c2e3cfed71af2e837c789b44bd9b35`  
**Primary Context Document:** `COMPLETE_SYSTEM_TECHNICAL_AUDIT.md` (Independently verified against source code)  
**Audit Scope:** 35 verification areas, concurrency/race conditions, restart/recovery, security, AWS cost safety, Pixel Streaming lifecycle, documentation cross-check, and external project boundaries.  
**Audit Mode:** READ-ONLY (No code, configurations, or AWS resources modified).

---

## PRODUCTION READINESS VERDICT

```text
========================================================================================
                                 NOT READY FOR PRODUCTION
========================================================================================
```

### Executive Summary of Verdict
While `maximall-web` exhibits a well-conceived architecture for low-latency GPU Pixel Streaming orchestration, the current implementation contains **3 Critical Blockers** and **4 High-Severity Vulnerabilities** that prevent safe production deployment:
1. **Unauthenticated Public GPU Allocation / DoS Exposure**: Anonymous public users or bots can trigger arbitrary GPU instance creation (`g4dn.2xlarge`) without rate limits, quotas, or authentication, leading to uncapped AWS billing exhaustion.
2. **Broken Admin Authentication**: The admin login route performs plaintext comparison against a password hash string (`password === config.ADMIN_PASSWORD_HASH`), preventing legitimate bcrypt logins and leaving default installations vulnerable to credential bypass.
3. **Catastrophic State Loss on Restart**: All instance, session, timer, and billing state is stored purely in Node.js heap memory (`Map`). A process restart or container redeploy causes the session watchdog to treat all running EC2 instances as abandoned and terminate them 60 seconds later, dropping all active streaming users and wiping all billing records.
4. **Unauthenticated Webhook Session Teardown**: If `TUNNEL_REPORT_SECRET` is not configured, the `/streamer-disconnected` webhook skips authentication entirely, allowing any external actor over raw HTTP (Port 80 bypass) to trigger a 60-second shutdown of any user's instance.

---

## DETAILED AUDIT FINDINGS (ORDERED BY SEVERITY)

---

### CRITICAL FINDINGS

#### Finding ID: `SEC-CRIT-01`
- **Severity**: **CRITICAL**
- **Subsystem**: API Gateway / Instance Provisioning / AWS Cost Safety
- **Exact File(s)**: [`src/app.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L527-L627), [`src/services/websocketService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts#L170-L336)
- **Exact Function / Route**: `POST /api/instances/connect-available`, `WebSocketService.handleRequestInstance` (`request-instance` event)
- **What is Wrong**:
  Both the REST endpoint `POST /api/instances/connect-available` and the WebSocket event `request-instance` are completely unauthenticated and lack any rate limiting, IP throttling, CAPTCHA, or maximum active instance limit. When the standby buffer pool is empty, the system automatically calls `ec2Service.createInstance('g4dn.2xlarge', ...)` to launch a new on-demand GPU instance.
- **Evidence**:
  - `src/app.ts:527-627`: No middleware for authentication or rate limiting on `POST /api/instances/connect-available`.
  - `src/services/websocketService.ts:268-308`:
    ```typescript
    // Fallback: Spawn a fresh On-Demand instance dynamically
    const { instanceId } = await this.ec2Service.createInstance('g4dn.2xlarge', amiId, subnetId, securityGroupId);
    ```
- **Reproduction Scenario**:
  A malicious actor or script sends 50 concurrent HTTP POST requests to `/api/instances/connect-available` or emits 50 `request-instance` WebSocket messages.
- **Real-World Consequence**:
  The orchestrator issues 50 `RunInstancesCommand` calls to AWS EC2 in `eu-central-1`. The AWS account will launch GPU instances up to the AWS vCPU service quota, accumulating massive AWS costs ($0.75–$1.20/hr per `g4dn.2xlarge` instance) and exhausting GPU capacity for legitimate users.
- **AWS Cost Leakage Risk**: **YES — EXTREME**
- **Cross-User Session Impact**: **YES** (Exhausts AWS GPU quota, starving legitimate users).
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  - Implement strict IP-based and token-based rate limiting (e.g. `express-rate-limit` and Socket.IO middleware).
  - Implement a hard maximum instance cap in `SettingsService` (e.g. `maxActiveInstances = 10`) beyond which requests are queued or rejected.
  - Require user authentication, session tokens, or CAPTCHA verification before instance allocation.

---

#### Finding ID: `AUTH-CRIT-02`
- **Severity**: **CRITICAL**
- **Subsystem**: Authentication & Authorization
- **Exact File(s)**: [`src/app.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L436-L450), [`src/config/index.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/config/index.ts#L17-L20)
- **Exact Function / Route**: `POST /api/admin/login`
- **What is Wrong**:
  Admin login compares the user-submitted plaintext password directly against `config.ADMIN_PASSWORD_HASH` using strict equality (`===`) instead of using `bcrypt.compare()`. If `.env` contains a bcrypt hash as documented in `.env.example` (`ADMIN_PASSWORD_HASH=$2b$10$...`), login will **always fail** unless the admin pastes the raw bcrypt hash into the password field. Furthermore, if `ADMIN_PASSWORD_HASH` is omitted or empty, authentication fails or behaves inconsistently, and the plaintext comparison is vulnerable to timing attacks.
- **Evidence**:
  - `src/app.ts:437-439`:
    ```typescript
    app.post('/api/admin/login', (req, res) => {
      const { username, password } = req.body;
      if (username === config.ADMIN_USERNAME && password === config.ADMIN_PASSWORD_HASH) {
        (req.session as any).isAdmin = true;
    ```
  - `src/config/index.ts:18`:
    ```typescript
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',
    ```
  - `.env.example:15`:
    ```ini
    ADMIN_PASSWORD_HASH=$2b$10$...
    ```
- **Reproduction Scenario**:
  Set `ADMIN_PASSWORD_HASH` to a valid bcrypt hash of `"MySecretPassword123"`. Navigate to `/login.html` and attempt to log in with username `admin` and password `MySecretPassword123`. Login will fail with `401 Unauthorized` because `"MySecretPassword123" !== "$2b$10$..."`.
- **Real-World Consequence**:
  Administrators cannot log in to the admin dashboard when following standard security practices (storing bcrypt hashes in environment variables), or administrators are forced to store plaintext passwords in `.env`.
- **AWS Cost Leakage Risk**: **NO**
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  - Use `bcrypt.compare(password, config.ADMIN_PASSWORD_HASH)` (or `crypto.timingSafeEqual`) for password validation.
  - Fail closed if `ADMIN_PASSWORD_HASH` is undefined or empty.

---

#### Finding ID: `STATE-CRIT-03`
- **Severity**: **CRITICAL**
- **Subsystem**: State Management / Process Lifecycle / Session Continuity
- **Exact File(s)**: [`src/server.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/server.ts#L28-L58), [`src/services/databaseService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/databaseService.ts#L1-L71), [`src/services/websocketService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts#L51-L110)
- **Exact Function / Route**: `bootstrap()`, `WebSocketService.startSessionCleanupLoop`
- **What is Wrong**:
  All runtime state (`DatabaseService.store`, `activeSessions`, `TimeTrackerService.realTimers`, `gracePeriodTimers`, `DatabaseService.totalArchivedSeconds`) is stored exclusively in process memory. When the process restarts:
  1. `server.ts` discovers EC2 instances from AWS tags, but **`activeSessions` is initialized as empty `new Map()`**.
  2. All client WebSocket connections are severed.
  3. The periodic garbage collector (`startSessionCleanupLoop` in `websocketService.ts:88-98`) runs within 30 seconds. Because `activeSessions` is empty (`hasAnySocket === false`, `hasAnyActiveDisplay === false`, `allSessionsAbandoned === true`), it assumes the instance was abandoned and calls `startGracePeriod(uuid)`.
  4. 60 seconds later, **the orchestrator permanently terminates all running user EC2 instances via `ScalingService.terminateAndRemove`**.
  5. All historical billing statistics (`totalArchivedSeconds` and `realTimeUsedSeconds`) are wiped to 0.
- **Evidence**:
  - `src/server.ts:38-51`: Re-discovered instances have `activeSessions = new Map()`.
  - `src/services/websocketService.ts:88-98`:
    ```typescript
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
    ```
- **Reproduction Scenario**:
  A user is actively streaming inside Unreal Engine. The backend container is restarted (e.g. during a deployment or unexpected restart). Within 60–90 seconds, the watchdog triggers a grace period and calls AWS `TerminateInstancesCommand`, killing the user's active session.
- **Real-World Consequence**:
  100% loss of all active streaming user sessions upon backend restart; active instances are abruptly terminated on AWS; all billing runtime history is lost.
- **AWS Cost Leakage Risk**: **YES** (Lost runtime metrics prevent accurate billing auditing).
- **Cross-User Session Impact**: **YES** (All concurrent users dropped and terminated).
- **Data / State Loss Risk**: **YES — TOTAL**
- **Recommended Direction**:
  - Persist instance records and session tokens in a lightweight persistent store (Redis, SQLite, or JSON file) or avoid auto-terminating newly re-discovered non-pool instances until a grace reconnection window has elapsed.
  - Persist `totalArchivedSeconds` and settings to disk.

---

### HIGH FINDINGS

#### Finding ID: `SEC-HIGH-01`
- **Severity**: **HIGH**
- **Subsystem**: Webhook Authentication / Denial of Service
- **Exact File(s)**: [`src/app.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L666-L693)
- **Exact Function / Route**: `POST /api/instances/:uuid/streamer-disconnected`
- **What is Wrong**:
  In `POST /api/instances/:uuid/streamer-disconnected`, if `process.env.TUNNEL_REPORT_SECRET` is not set or is empty, the authentication check `if (expectedSecret && secret !== expectedSecret)` evaluates to `false` and is completely bypassed. This allows anyone on the internet to call this endpoint over raw HTTP (via Port 80 Nginx bypass) with no secret and force any active user instance into a 60-second termination countdown.
- **Evidence**:
  - `src/app.ts:670-675`:
    ```typescript
    // Verify secret if configured (using TUNNEL_REPORT_SECRET as the default key)
    const expectedSecret = process.env.TUNNEL_REPORT_SECRET || '';
    if (expectedSecret && secret !== expectedSecret) {
      console.warn(`[Streamer Disconnect Webhook] Unauthorized request for instance ${uuid}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    ```
- **Reproduction Scenario**:
  Run backend without `TUNNEL_REPORT_SECRET` in `.env`. Send `POST http://<SERVER_IP>/api/instances/<UUID>/streamer-disconnected` with `{ "secret": "anything" }`. The endpoint responds with `200 OK` and immediately calls `wsService.startGracePeriod(uuid)`.
- **Real-World Consequence**:
  External malicious users can terminate active customer sessions at will.
- **AWS Cost Leakage Risk**: **NO**
- **Cross-User Session Impact**: **YES — HIGH** (Denial of Service).
- **Data / State Loss Risk**: **YES** (Premature session termination).
- **Recommended Direction**:
  Enforce mandatory secret validation: `if (!expectedSecret || secret !== expectedSecret) return res.status(401).json(...)`.

---

#### Finding ID: `SEC-HIGH-02`
- **Severity**: **HIGH**
- **Subsystem**: Session Security / CSRF / Session Hijacking
- **Exact File(s)**: [`src/app.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L21-L38), [`src/config/index.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/config/index.ts#L19)
- **Exact Function / Route**: Express Session & CORS configuration
- **What is Wrong**:
  1. `config.SESSION_SECRET` defaults to `'secret'`. If `SESSION_SECRET` is not defined in `.env`, the session cookie signing key is predictable, allowing attackers to forge `express-session` cookies with `{ isAdmin: true }`.
  2. CORS is configured with `origin: (origin, cb) => cb(null, true)` and `credentials: true`. This reflects any requesting Origin header and permits cross-origin credentialed requests. Combined with cookie-based session auth and no CSRF tokens, any website visited by an admin can perform CSRF attacks against `/api/admin/*` endpoints (e.g. terminating instances, changing hourly rates, or resetting quotas).
- **Evidence**:
  - `src/config/index.ts:19`: `SESSION_SECRET: process.env.SESSION_SECRET || 'secret'`
  - `src/app.ts:21-29`:
    ```typescript
    app.use(cors({
      origin: (origin, callback) => {
        callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'ngrok-skip-browser-warning'],
    }));
    ```
- **Reproduction Scenario**:
  An administrator logged into the Maximall admin panel visits a malicious third-party website. The malicious page executes `fetch('https://18-185-5-251.nip.io/api/admin/instances/sync', { method: 'POST', credentials: 'include' })` or triggers instance terminations. The browser attaches the session cookie because CORS allows origin reflection with credentials.
- **Real-World Consequence**:
  Full administrative compromise and unauthorized AWS infrastructure manipulation via CSRF.
- **AWS Cost Leakage Risk**: **YES** (Malicious pool manipulation / realign attacks).
- **Cross-User Session Impact**: **YES**
- **Data / State Loss Risk**: **YES**
- **Recommended Direction**:
  - Require a strong, non-default `SESSION_SECRET` on startup (`throw Error if SESSION_SECRET === 'secret'`).
  - Restrict CORS origins to explicitly allowed production domains.
  - Set `SameSite=Lax` or `SameSite=Strict` and `secure: true` on session cookies.

---

#### Finding ID: `RACE-HIGH-03`
- **Severity**: **HIGH**
- **Subsystem**: Standby Pool Orchestration / Concurrency
- **Exact File(s)**: [`src/services/scalingService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/scalingService.ts#L210-L331), [`src/services/scalingService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/scalingService.ts#L678-L752)
- **Exact Function / Route**: `ScalingService.reconcilePool`, `ScalingService.realignPool`
- **What is Wrong**:
  There is no concurrency lock or mutex between `reconcilePool()` (running every 60s and triggered by buffer claims/aborts) and `realignPool()` (triggered by admin POST `/api/admin/pool/realign`). Both methods perform asynchronous AWS queries and calculate the pool `deficit` against a shared in-memory snapshot before launching instances. If both execute concurrently, both will compute identical deficits and launch duplicate prewarm instances on AWS.
- **Evidence**:
  - `src/services/scalingService.ts:319-330`:
    ```typescript
    const deficit = minBufferTarget - bufferCount - prewarmCount;
    if (deficit <= 0) return;
    const launches = Array.from({ length: deficit }, () => this.launchPrewarmInstance());
    await Promise.allSettled(launches);
    ```
  - `src/services/scalingService.ts:711-727`:
    ```typescript
    const delta = combinedTarget - currentTotal;
    if (delta > 0) {
      const launches = Array.from({ length: delta }, () => this.launchPrewarmInstance());
      await Promise.allSettled(launches);
    ```
- **Reproduction Scenario**:
  The 60s `reconcilePool()` timer ticks. Simultaneously, an admin clicks "Применить и выровнять" on the Dashboard with target=3. Both calculate a deficit of 3. Both trigger `Promise.allSettled` launching 3 instances. 6 total `g4dn.2xlarge` instances are created in AWS instead of 3.
- **Real-World Consequence**:
  Over-provisioning of expensive GPU instances, leading to runaway AWS infrastructure charges.
- **AWS Cost Leakage Risk**: **YES — HIGH**
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  Add an `isReconciling` mutex/boolean lock inside `ScalingService` to serialize pool adjustments.

---

#### Finding ID: `SEC-HIGH-04`
- **Severity**: **HIGH**
- **Subsystem**: Infrastructure as Code / Credential Exposure
- **Exact File(s)**: [`terraform/bootstrap.sh`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/terraform/bootstrap.sh#L38), [`terraform/bootstrap.sh`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/terraform/bootstrap.sh#L7)
- **Exact Function / Route**: EC2 User Data script
- **What is Wrong**:
  1. `terraform/bootstrap.sh:38` contains a hardcoded AWS presigned S3 URL embedding an active IAM Access Key ID: `AKIA3262B7WJSPXE2EMY`.
  2. `terraform/bootstrap.sh:7` contains a hardcoded SSH public key: `admin@DESKTOP-V24EV6F`.
  3. `terraform/terraform.tfstate` is present in the local workspace containing tainted instance IDs and VPC subnet IDs.
- **Evidence**:
  - `terraform/bootstrap.sh:38`:
    ```bash
    curl -L -o /tmp/maximall-deploy.zip "https://maximall-web-deploy-tmp.s3.us-east-2.amazonaws.com/maximall-deploy.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA3262B7WJSPXE2EMY%2F20260626%2Fus-east-2%2Fs3%2Faws4_request..."
    ```
- **Reproduction Scenario**:
  Code repository or script inspection reveals the AWS Access Key ID and deployment infrastructure artifacts.
- **Real-World Consequence**:
  Potential AWS IAM credential enumeration and unauthorized access to deployment S3 buckets.
- **AWS Cost Leakage Risk**: **YES** (If associated credentials have write/create permissions).
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  - Parameterize all S3 downloads via IAM EC2 instance profiles (`aws s3 cp`) rather than presigned URLs with embedded credentials.
  - Ensure `.gitignore` excludes all `.tfstate` and deployment archives.

---

### MEDIUM FINDINGS

#### Finding ID: `RACE-MED-01`
- **Severity**: **MEDIUM**
- **Subsystem**: Buffer Claiming / Allocation Rollback
- **Exact File(s)**: [`src/services/websocketService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts#L207-L264), [`src/app.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L527-L567)
- **Exact Function / Route**: `WebSocketService.handleRequestInstance`, `POST /api/instances/connect-available`
- **What is Wrong**:
  When a buffer instance is claimed via `claimBufferInstance()`, its label is updated to `'LinuxClient'`. Then `ec2Service.startInstance(claimedInstanceId)` is called asynchronously. If `startInstance` throws an AWS error (e.g. AWS throttling or temporary capacity error):
  1. The code catches the error and reverts `assignedTo = 'Buffer'`, `status = 'stopped'`.
  2. However, `claimBufferInstance()` has already fired `setTimeout(() => this.reconcilePool(), 0)`.
  3. When `reconcilePool()` executes, it sees the rollback instance back in the buffer pool plus may have already launched a replacement prewarm instance.
  Additionally, `POST /api/instances/connect-available` and WebSocket `request-instance` claim buffer instances independently with no shared queue.
- **Evidence**:
  - `src/services/scalingService.ts:621-638`:
    ```typescript
    async claimBufferInstance(): Promise<string | null> {
      const instances = this.db.getInstances();
      const bufferInst = Object.values(instances).find(
        i => i.assignedTo === BUFFER_LABEL && i.status === 'stopped'
      );
      if (!bufferInst) return null;
      bufferInst.assignedTo = 'LinuxClient';
      await this.db.saveInstance(bufferInst.instanceId, bufferInst);
      setTimeout(() => this.reconcilePool(), 0);
      return bufferInst.instanceId;
    }
    ```
- **Real-World Consequence**:
  Transient AWS start failures can cause pool size over-expansion.
- **AWS Cost Leakage Risk**: **YES — LOW**
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  Only trigger `reconcilePool()` after `startInstance` has successfully resolved.

---

#### Finding ID: `BILL-MED-02`
- **Severity**: **MEDIUM**
- **Subsystem**: Time Tracking & Billing Accumulation
- **Exact File(s)**: [`src/services/timeTrackerService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/timeTrackerService.ts#L50-L71), [`src/services/databaseService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/databaseService.ts#L61-L69)
- **Exact Function / Route**: `TimeTrackerService.stopRealTimer`, `DatabaseService.deleteInstance`
- **What is Wrong**:
  When `terminateAndRemove` is called, it executes:
  ```typescript
  TimeTrackerService.getInstance().stopRealTimer(instanceId);
  ...
  await this.db.deleteInstance(instanceId);
  ```
  In `stopRealTimer`, if `elapsed < 60`, it calculates `padding = 60 - elapsed` and calls `this.db.saveInstance(instanceUuid, instance)`. Because `saveInstance` inside `stopRealTimer` is asynchronous and **not awaited** (line 64: `this.db.saveInstance(...).catch(...)`), `deleteInstance` in `ScalingService` can execute before the padded `realTimeUsedSeconds` is saved. `deleteInstance` then reads the un-padded `inst.realTimeUsedSeconds` into `totalArchivedSeconds`, dropping the 60-second AWS billing emulation padding.
- **Evidence**:
  - `src/services/timeTrackerService.ts:64-66`:
    ```typescript
    this.db.saveInstance(instanceUuid, instance).catch(err => {
      console.error('[TimeTracker] Failed to save instance padding:', err.message);
    });
    ```
- **Real-World Consequence**:
  Short-lived EC2 instances (< 60 seconds) are under-reported in cumulative billing metrics.
- **AWS Cost Leakage Risk**: **NO** (Metric reporting error, not cloud overcharge).
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **YES** (Billing statistics undercounting).
- **Recommended Direction**:
  Make `stopRealTimer` async and await the padding save, or perform the 60s padding synchronously directly inside `deleteInstance()`.

---

#### Finding ID: `WS-MED-03`
- **Severity**: **MEDIUM**
- **Subsystem**: WebSocket Session Lifecycle / Heartbeat
- **Exact File(s)**: [`src/services/websocketService.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts#L784-L830)
- **Exact Function / Route**: `WebSocketService.startHeartbeatMonitor`
- **What is Wrong**:
  `startHeartbeatMonitor` checks `Date.now() - session.lastSeenAt > 45000` on a 10-second interval. If the client misses heartbeats (e.g. mobile device sleep or heavy render lag), it clears the monitor, sets `session.socketId = undefined`, and calls `startGracePeriod(instanceUuid)`. If the client socket is still physically connected and resumes sending heartbeats, `handleHeartbeat` calls `this.timeTracker.cancelGracePeriod(instanceUuid)`, but `session.socketId` remains `undefined` and `startHeartbeatMonitor` is never restarted for that socket. The session enters a zombie state where future disconnections will not trigger grace periods until the 30-second GC loop catches it.
- **Evidence**:
  - `src/services/websocketService.ts:804-817`: Sets `session.socketId = undefined` and clears monitor.
  - `src/services/websocketService.ts:633-658`: `handleHeartbeat` updates `lastSeenAt` and cancels grace period, but does **not** restore `session.socketId = socket.id` or restart the monitor.
- **Real-World Consequence**:
  If a client recovers from a temporary freeze, subsequent disconnects may fail to trigger timely teardown.
- **AWS Cost Leakage Risk**: **YES — LOW** (Delayed teardown).
- **Cross-User Session Impact**: **NO**
- **Data / State Loss Risk**: **NO**
- **Recommended Direction**:
  In `handleHeartbeat`, if `session.socketId` is unset or mismatched, restore `session.socketId = socket.id` and restart `startHeartbeatMonitor`.

---

### LOW FINDINGS

#### Finding ID: `CFG-LOW-01`
- **Severity**: **LOW**
- **Subsystem**: Configuration Defaults & Fallbacks
- **Exact File(s)**: [`src/config/index.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/config/index.ts#L11), [`src/services/ec2Service.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/ec2Service.ts#L20)
- **Exact Function / Route**: `config.AWS_REGION`
- **What is Wrong**:
  `src/config/index.ts:11` specifies default `AWS_REGION = 'us-east-2'`, whereas production infrastructure (Terraform, AMI, EIP) is located in `'eu-central-1'` (Frankfurt). If `AWS_REGION` is omitted from `.env`, the orchestrator attempts to find AMIs and instances in `us-east-2`, failing EC2 discovery and instance launches.
- **Evidence**:
  - `src/config/index.ts:11`: `AWS_REGION: process.env.AWS_REGION || 'us-east-2'`
  - `src/services/ec2Service.ts:20`: `region: config.AWS_REGION || 'eu-central-1'`
- **Real-World Consequence**:
  Configuration inconsistency if `.env` is incomplete.
- **Recommended Direction**:
  Align all default region fallbacks across `config/index.ts`, `ec2Service.ts`, and `.env.example` to `'eu-central-1'`.

---

#### Finding ID: `CODE-LOW-02`
- **Severity**: **LOW**
- **Subsystem**: Clean Architecture / Dead Code
- **Exact File(s)**: [`src/data/db.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/data/db.ts), [`src/data/models/InstanceModel.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/data/models/InstanceModel.ts), [`src/data/models/SettingsModel.ts`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/data/models/SettingsModel.ts)
- **What is Wrong**:
  Legacy Mongoose schemas and database connection stubs remain in the active codebase despite the complete transition to the in-memory `DatabaseService`.
- **Recommended Direction**:
  Safely remove legacy `src/data/models/` and `src/data/db.ts`.

---

### INFORMATIONAL FINDINGS

#### Finding ID: `INFO-01`
- **Subsystem**: Quota & Display Limits
- **Details**:
  `displayLimitHours` and `realLimitHours` fields exist in `Instance` and `Settings` interfaces, and `TimeTrackerService` contains no-op stubs `startDisplayTimer` and `stopDisplayTimer`. Quota enforcement has been intentionally deprecated in favor of simple cumulative billing metrics.
- **Status**: Verified intentional design choice.

---

## 1. RACE CONDITION MATRIX

| Race Scenario | Components Involved | Concurrency Window | Result / Vulnerability | Severity |
| :--- | :--- | :--- | :--- | :--- |
| **2 Users Request Instance Simultaneously (1 Buffer Available)** | `websocketService.ts`<br/>`scalingService.ts` | Synchronous Map search vs Async `startInstance` | **Safe on claim, Over-provision on error**: The first synchronous call marks `assignedTo = 'LinuxClient'`, preventing the second caller from claiming the same buffer (second caller falls back to On-Demand). However, if `startInstance` fails on AWS, rollback triggers double-replenishment. | **MEDIUM** |
| **5–10 Concurrent User Requests (Buffer Empty)** | `websocketService.ts`<br/>`ec2Service.ts` | Concurrent `createInstance` calls | **Vulnerable to AWS Quota Exhaustion**: All 10 requests concurrently dispatch `RunInstancesCommand` without rate limiting or quota checks. | **CRITICAL** |
| **`reconcilePool()` vs `realignPool()` Race** | `scalingService.ts` | 60s timer ticks during Admin "Apply & Re-align" | **Over-provisioning**: Both calculate deficit against the same snapshot and launch duplicate EC2 prewarm instances ($N + M$). | **HIGH** |
| **Heartbeat vs Grace Expiry Race** | `websocketService.ts`<br/>`timeTrackerService.ts` | Heartbeat arrives during grace termination callback | **Handled / Safe**: `handleHeartbeat` and `handleDisplayStart` call `timeTracker.cancelGracePeriod(uuid)`. In addition, the grace callback verifies `hasActive` viewers before calling `terminateAndRemove`. | **LOW** |
| **Resume-Instance vs Teardown Race** | `websocketService.ts`<br/>`scalingService.ts` | `resume-instance` received while `terminateAndRemove` is executing | **Partial State Window**: If AWS `TerminateInstancesCommand` is already dispatched, `resume-instance` emits `server-ready` but the instance shuts down in AWS, causing client connection failure. | **MEDIUM** |
| **`player-disconnect` vs Socket `disconnect` Race** | `websocketService.ts`<br/>`player.js` | Tab close emits `player-disconnect` then socket drops | **Safe / Idempotent**: Both handlers check `hasAnySocket`. The 15s flicker delay in `handleSocketDisconnect` prevents double-triggering grace periods. | **LOW** |

---

## 2. RESTART & CRASH RECOVERY MATRIX

| System State at Restart | State Reconstructed from AWS | State Permanently Lost | Real-World Consequence |
| :--- | :--- | :--- | :--- |
| **Active User Streaming Session** | Instance ID, Public IP, AWS State (`running`) | `activeSessions` Map, `socketId`, `deviceId`, `hostToken`, WebRTC tunnel binding | **Fatal Drop**: Running instance is detected with 0 active sessions. Watchdog triggers grace period and **terminates the instance 60s later**, dropping the active user. |
| **Stopped Buffer Instance** | Instance ID, State (`stopped`), Tags | None | **Recovered**: Re-absorbed as `assignedTo = 'Buffer'`. |
| **In-Flight Prewarm Instance** | Instance ID, State (`running`/`pending`), `ManagedByBackend=true` tag | Prewarm phase (1–5), WebSocket probe state | **Re-adopted**: If `managedByBackend === true`, `reconcilePool` re-adopts into `activePrewarms` and resumes `waitForWarmupAndStop`. |
| **Active Grace Period Timer** | None | 60-second countdown timer | **Timer Lost**: Instance status remains `running`; watchdog will re-detect 0 sessions within 30s and start a fresh 60s grace timer. |
| **Cumulative Billing Accumulator** | None | `totalArchivedSeconds`, `realTimeUsedSeconds` | **Total Loss**: Billing statistics reset to 0. Historical cost data is wiped. |
| **Admin Settings** | None | `minBufferTarget`, `serverHourlyRate`, `idleTimeoutMinutes` | **Reset to Defaults**: `minBufferTarget` resets to `0` (passive mode). |

---

## 3. SECURITY AUDIT FINDINGS SUMMARY

1. **Admin Login Bypass / Failure**: Plaintext `===` comparison against `ADMIN_PASSWORD_HASH` prevents bcrypt usage ([`src/app.ts:437`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L437)).
2. **Predictable Session Secret**: Default `SESSION_SECRET = 'secret'` allows forging admin session cookies ([`src/config/index.ts:19`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/config/index.ts#L19)).
3. **CORS Credential Reflection**: `origin: true` with `credentials: true` enables CSRF against all `/api/admin/*` endpoints ([`src/app.ts:21-29`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L21-L29)).
4. **Unauthenticated Webhook Teardown**: `POST /api/instances/:uuid/streamer-disconnected` skips auth when secret is empty, allowing remote attackers to trigger 60s instance teardowns ([`src/app.ts:672`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L672)).
5. **Hardcoded Credentials in Deployment Script**: `terraform/bootstrap.sh` contains hardcoded IAM access key IDs in presigned URLs ([`terraform/bootstrap.sh:38`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/terraform/bootstrap.sh#L38)).
6. **Unrestricted Instance Spawning**: Public unauthenticated endpoints allow unbounded EC2 GPU creation ([`src/app.ts:527`](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts#L527)).

---

## 4. AWS COST-RISK FINDINGS SUMMARY

| Cost Risk Vector | Mechanism | Probability | Financial Impact |
| :--- | :--- | :--- | :--- |
| **Unbounded Public Spawning** | No instance cap or rate limit on `connect-available` / `request-instance` | **HIGH** | High (Exhausts account EC2 quota at ~$0.94/hr/instance) |
| **Reconcile / Realign Concurrency** | Overlapping deficit calculations launch duplicate prewarms | **MEDIUM** | Medium ($5–$20/day in surplus GPU hours) |
| **Stale Ghost Buffer Slots** | Stale DB records block replenishment or cause orphan prewarms | **LOW** (Mitigated by ghost purge) | Low |
| **60s Billing Padding Loss** | Un-awaited save in `stopRealTimer` undercounts short runs | **MEDIUM** | Internal accounting discrepancy only |

---

## 5. PIXEL STREAMING LIFECYCLE VERIFICATION

```mermaid
sequenceDiagram
    autonumber
    actor User as Browser (player.html / player.js)
    participant Orchestrator as maximall-web (Backend / WS)
    participant AWS as AWS EC2 API
    participant EC2 as GPU Instance (Pinggy / Wilbur / UE5)

    Note over User, Orchestrator: 1. ALLOCATION & BUFFER CLAIM / SPAWN
    User->>Orchestrator: WS request-instance (deviceId, hostToken)
    alt Case 1: Buffer Instance Available (Stopped)
        Orchestrator->>AWS: StartInstancesCommand(instanceId)
        Orchestrator-->>User: WS instance-assigned (uuid, hostToken, rescued: false)
    else Case 2: Buffer Pool Empty (On-Demand Fallback)
        Orchestrator->>AWS: RunInstancesCommand(g4dn.2xlarge, LinuxClientAMI)
        Orchestrator-->>User: WS instance-assigned (uuid, hostToken, rescued: false)
    else Case 3: Reconnection / Rescue by DeviceId
        Orchestrator-->>User: WS instance-assigned (uuid, hostToken, rescued: true)
    end

    Note over Orchestrator, EC2: 2. BOOT, TUNNEL REPORT & READINESS PROBING
    EC2->>EC2: Boot scripts start Pinggy tunnel, Wilbur signaling & UE5
    EC2->>Orchestrator: POST /api/instances/:uuid/report-tunnel { secret, pinggyUrl } (Port 80 Bypass)
    loop Every 3s Status Poll (Orchestrator to EC2)
        Orchestrator->>EC2: WS Probe {"type": "listStreamers"} via pinggyUrl
        EC2-->>Orchestrator: {"type": "streamerList", "ids": ["DefaultStreamer"]}
    end
    Orchestrator-->>User: WS server-ready (pinggyUrl)

    Note over User, EC2: 3. ACTIVE STREAMING & HEARTBEATS
    User->>EC2: HTTPS/WSS WebRTC connect to player.html via pinggyUrl
    User->>Orchestrator: WS display-start (instanceUuid, hostToken, deviceId)
    Orchestrator->>Orchestrator: Start 45s heartbeat watchdog & startDisplayTimer()
    Orchestrator-->>User: WS display-started (idleTimeoutMinutes)
    loop Every 10s Heartbeat
        User->>Orchestrator: WS heartbeat (deviceId)
        Orchestrator-->>User: WS heartbeat-ack (timestamp)
    end

    Note over User, Orchestrator: 4. TEARDOWN, FLICKER RECOVERY & GRACE PERIOD
    alt Scenario A: Network Drop / Flicker (<15s)
        User-xOrchestrator: Socket Drop
        Orchestrator->>Orchestrator: 15s Flicker Window (Wait for reconnect)
        User->>Orchestrator: Socket Reconnects (same hostToken & deviceId)
        Orchestrator->>Orchestrator: Flicker recovered — Grace cancelled
    else Scenario B: Explicit Tab Close (beforeunload)
        User->>Orchestrator: WS player-disconnect (hostToken, deviceId)
        Orchestrator->>Orchestrator: Start 60s Grace Period
        Orchestrator-->>User: WS grace-period-started (60s)
    else Scenario C: Streamer / UE5 Crash Webhook
        EC2->>Orchestrator: POST /api/instances/:uuid/streamer-disconnected { secret }
        Orchestrator->>Orchestrator: Start 60s Grace Period
    end

    Note over Orchestrator, AWS: 5. GRACE EXPIRY & TERMINATION
    Note over Orchestrator: 60s Timer Expires with 0 active viewers
    Orchestrator-->>User: WS instance-stopping ("The server is shutting down.")
    Orchestrator->>AWS: TerminateInstancesCommand(instanceId)
    Orchestrator->>Orchestrator: stopRealTimer() (with 60s min padding) & deleteInstance()
```

### Verified Disconnect / Reconnect Integrity:
- **Device ID Binding**: `deviceId` stored in `localStorage` successfully blocks token hijacking (`"Session locked to another device"`).
- **15s Flicker Window**: Correctly prevents mobile network transitions from prematurely terminating GPU instances.
- **Port 80 Bypass**: Verified necessary for raw IP EC2 boot callbacks where SSL certificate domain names do not match IP addresses.

---

## 6. DOCUMENTATION VS. IMPLEMENTATION DISCREPANCIES

| Area | Documentation Claim (`COMPLETE_SYSTEM_TECHNICAL_AUDIT.md` / `docs/`) | Actual Code Implementation | Classification |
| :--- | :--- | :--- | :--- |
| **Admin Password Validation** | Stated as bcrypt hash comparison in `.env.example` | `password === config.ADMIN_PASSWORD_HASH` (Plaintext `===`) | **B. Implementation Bug** |
| **Database Engine** | `task.md` references JSON file storage (`instances.json`); models define Mongoose schemas | `src/services/databaseService.ts` is pure in-memory `Map` | **A. Documentation Outdated** |
| **Quota Countdown** | `task.md` describes strict display time quotas and user cutoffs | Quota logic disabled; fields kept as no-op stubs | **E. Intentional Design Difference** |
| **Default Buffer Target** | `docs/lifecycle.md` mentions default buffer of 3 | `SettingsService` defaults `minBufferTarget = 0` (passive startup) | **A. Documentation Outdated** |
| **AWS Region Default** | `.env.example` lists `us-east-2` | Production code and Terraform use `eu-central-1` | **C. Configuration Mismatch** |
| **Streamer Disconnect Webhook Auth** | Stated as protected by `TUNNEL_REPORT_SECRET` | Auth is skipped if `TUNNEL_REPORT_SECRET` is unset | **B. Implementation Bug** |

---

## 7. UNVERIFIED ASSUMPTIONS & EXTERNAL BOUNDARIES

| Component / Subsystem | Verification Classification | Source / Reason for Status |
| :--- | :--- | :--- |
| **Orchestrator Backend (`src/`)** | **VERIFIED FROM CODE** | Full TypeScript codebase inspected. |
| **Nginx & SSL Configuration** | **VERIFIED FROM CONFIG** | `nginx.conf` and `docker-compose.yml` inspected. |
| **Terraform IaC & Bootstrap** | **VERIFIED FROM INFRASTRUCTURE** | `terraform/` scripts and states inspected. |
| **AMI Startup Scripts (`LinuxClientAMI`)** | **DOCUMENTED ONLY** | Resides inside external AWS AMI. Script contents inferred from `/report-tunnel` callbacks. |
| **Signaling Server Source Code** | **UNVERIFIED (External Repo)** | Resides in external repository `C:\Users\Admin\Desktop\Aleg\maximall-pixel-config`. |
| **Unreal Engine 5 Executable** | **UNVERIFIED (External Repo)** | Resides in external repository `C:\Users\Admin\Desktop\Aleg\UE5C++`. |

---

## 8. PRODUCTION BLOCKERS (MUST FIX BEFORE REAL USERS)

1. **[BLOCKER 1] Unbounded GPU Instance Spawning (`SEC-CRIT-01`)**:
   Must implement rate limiting and a configurable global maximum active GPU instance ceiling.
2. **[BLOCKER 2] Broken Admin Password Verification (`AUTH-CRIT-02`)**:
   Must implement `bcrypt.compare` for `POST /api/admin/login`.
3. **[BLOCKER 3] State Loss on Process Restart (`STATE-CRIT-03`)**:
   Must persist active instance records/sessions or add a startup grace shield so backend restarts do not immediately kill all running user instances.
4. **[BLOCKER 4] Unauthenticated Webhook Teardown (`SEC-HIGH-01`)**:
   Must mandate secret validation on `/api/instances/:uuid/streamer-disconnected`.
5. **[BLOCKER 5] Default Session Secret & CORS Wildcard (`SEC-HIGH-02`)**:
   Must enforce a secure `SESSION_SECRET` and restrict CORS origins with credentials.

---

## 9. RECOMMENDED FIX PRIORITY

```text
Priority 1 (Immediate Security & Cost Safety):
  1. Fix POST /api/admin/login to use bcrypt.compare (AUTH-CRIT-02).
  2. Enforce TUNNEL_REPORT_SECRET in /streamer-disconnected webhook (SEC-HIGH-01).
  3. Enforce strong SESSION_SECRET and restrict CORS origins (SEC-HIGH-02).
  4. Add maxActiveInstances guard and rate-limiting on instance spawning (SEC-CRIT-01).

Priority 2 (Reliability & Lifecycle Integrity):
  5. Add startup protection in websocketService to prevent watchdog from terminating
     running instances immediately following a backend restart (STATE-CRIT-03).
  6. Add isReconciling mutex to ScalingService to prevent concurrent prewarm over-provisioning (RACE-HIGH-03).
  7. Await padding save in TimeTrackerService.stopRealTimer before DB deletion (BILL-MED-02).

Priority 3 (Hygiene & Consistency):
  8. Align default AWS_REGION across config/index.ts and .env.example to 'eu-central-1' (CFG-LOW-01).
  9. Clean up legacy Mongoose models and db.ts stubs (CODE-LOW-02).
```

---

*Audit completed with zero code or configuration modifications.*
