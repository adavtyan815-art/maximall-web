# Multi-Instance 3D Pixel Streaming Platform (`maximall-web`)

Production-ready orchestrator and reverse-proxy backend for multi-instance Epic Games Pixel Streaming on AWS EC2 GPU instances (`g4dn.2xlarge` with NVIDIA Tesla T4).

---

## 1. Core Architectural Capabilities

- **Base / Extra Standby Pool**:
  - `Base`: Permanent standby floor, automatically replenished upon consumption.
  - `Extra`: Expendable surge capacity, consumed without triggering redundant prewarms.
  - Invariant math: $\text{MaxAllowed} = \max(0, \text{Base} + \text{Extra} - \text{Active})$.
- **Private-IP-First Routing**:
  - All internal backend $\leftrightarrow$ GPU communication (readiness polling, prewarm streamer verification, HTTP asset reverse proxy, WebSocket signaling proxy) uses intra-VPC Private IPs (`172.31.x.x`) with sub-millisecond latency (0.001s), falling back to public IP if private IP is unavailable.
- **Multi-AZ Subnet Fallback**:
  - `EC2Service.getAvailableSubnets()` automatically discovers public subnets across `eu-central-1a`, `eu-central-1b`, and `eu-central-1c`, sequentially falling back to the next AZ if `InsufficientInstanceCapacity` occurs.
- **Multi-Buffer Fallback & Safe Claim Rollback**:
  - When waking up stopped buffers, the backend tries all candidate Ready Buffers in sequence upon AWS start errors, rolling back failed claims to `stopped` without quota or state leaks.
- **Automated Graceful Recycling**:
  - Healthy instances with expired sessions are automatically stopped via AWS `StopInstancesCommand` and returned to the Ready Buffer pool for instant reuse.
- **Multi-Tab Stream Protection**:
  - Enforces one active stream per hardware device. Secondary tabs are intercepted with `session-in-use` (`"3D-комната уже открыта в другой вкладке."`), while F5 refreshes cleanly re-attach without launching duplicate instances.
- **100% Russian User-Facing Errors**:
  - All error banners, loading messages, and fallback dialogs are localized in Russian.

---

## 2. Verified Live AWS Closed-Testing Status

The current codebase is deployed to the AWS closed-testing backend (`i-077a8a8febf8aa7fa`). The following live end-to-end tests have been verified:

| Test Scenario | Result | Verification Notes |
|---|---|---|
| **Manual Buffer Cold Wake** | **PASS** | Manually created buffer `i-06ce1e5c62edc9594` (`eu-central-1c`) woke in 36s and streamed. |
| **Backend Buffer Cold Wake** | **PASS** | Backend-created buffer `i-0cd53326a9e9cc39e` (`eu-central-1b`) woke in 39s and streamed. |
| **Repeat Wake-up of Recycled Buffer** | **PASS** | Previously recycled buffer woke again in ~36s with zero startup delay. |
| **99% Startup Stall Resolution** | **PASS** | Streamer detected at +30–33s via Private IP; browser passes 99% immediately at +36–39s. |
| **Pool Expansion (`Base=1, Extra=2`)** | **PASS** | Starting from 2 buffers, launched **exactly 1 prewarm** (`i-0957cf865b52f96d5`) in `eu-central-1c`. |
| **Concurrent 2-User Streaming** | **PASS** | Both users claimed distinct buffers simultaneously with active heartbeats. |
| **No Duplicate Prewarm Launches** | **PASS** | Verified zero extra `RunInstances` during active multi-user streaming. |
| **Post-Session Recycling** | **PASS** | Disconnected instances gracefully stopped and returned to Ready Buffer pool. |
| **Multi-AZ Creation Fallback** | **PASS** | Subnet discovery across `eu-central-1a`, `1b`, and `1c` validated under simulated and real AZ placement. |

---

## 3. Known Remaining External Issue (Unreal Engine Side)

- **Issue**: Client Internet disconnection (~30–35s) followed by reconnect causes a deferred crash inside the Unreal Engine Linux binary (`awsTutorialClient-Linux-Shipping`) approximately 40–60 seconds after streaming resumes.
- **Failure Signature**: `libc++abi: terminating` $\rightarrow$ `Signal 6 (SIGABRT)` triggered in `EmbeddedVoiceChat::AbstractCaptureDevice::start()`.
- **System Behavior**: `systemd` detects the crash (`status=6/ABRT`) and restarts `aws-client.service`, reloading the default startup map (`UserLogin`).
- **Classification**: This is an internal **Unreal Engine / EmbeddedVoiceChat C++ plugin issue**, not a backend orchestrator or session routing failure. The backend preserves session tokens, cancels flicker timers, and proxies WebSockets correctly.

---

## 4. Local Development & Testing

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Run regression suites
node scratch/test_final_batch_suite.js   # 23 scenarios
node scratch/audit_suite.js              # 13 scenarios
node scratch/test_buffer_fallback.js     # 6 scenarios
```

---

## 5. Documentation Directory

- [System Architecture](docs/architecture.md)
- [Lifecycle & State Machine](docs/lifecycle.md)
- [Infrastructure & AWS Configuration](docs/infrastructure.md)
- [Server Billing & Cost Tracking](docs/billing.md)
- [API Reference](docs/api_reference.md)
