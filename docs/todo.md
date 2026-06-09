# Roadmap & Edge Cases To-Do List

This document outlines the next sprint's roadmap to resolve potential failure and billing edge cases, making the orchestrator and streamer environment even more robust.

---

## 1. Roadmap Overview

| ID | Task Description | Target Repository | Priority |
|---|---|---|---|
| **A** | Persist Billing & Settings Data | `maximall-web` | High |
| **B** | Active Tunnel Health Probes | `maximall-web` | Medium |
| **C** | AWS SDK API Throttling Safeguard | `maximall-web` | Medium |
| **D** | "Stopping" State Hang Watchdog | `maximall-web` | Low |

---

## 2. Technical Breakdowns

### Task A: Persist Billing & Settings Data (Process Restarts)
* **Goal**: Prevent the local server cost tracking accumulator (`totalArchivedSeconds`) and Settings changes from resetting to default values when the Node.js process restarts.
* **Repository**: `maximall-web`
* **Implementation Plan**:
  - Implement a simple file-based storage helper (e.g. saving to `src/data/billing-stats.json` and `src/data/settings-config.json`) inside `DatabaseService` and `SettingsService`.
  - On application startup, load any existing values from the JSON files.
  - On modification (e.g., `deleteInstance` archiving, saving settings), write the updated state back to disk asynchronously.
  - *Future-proofing*: Ensure this matches production environments where file writes are local or can transition to database adapters (e.g., SQLite/PostgreSQL/MongoDB).

### Task B: Active Instance Tunnel Health Probes
* **Goal**: Detect if a tunnel (Pinggy/ngrok) crashes or expires on a running instance during an active user session. This prevents the server from running (and billing) indefinitely while the user stares at a frozen screen.
* **Repository**: `maximall-web`
* **Implementation Plan**:
  - Add a periodic check inside `WebSocketService` or `ScalingService` that probes the `/api/status` or Wilbur WebSocket of active instances every 60 seconds.
  - If the connection fails or is unreachable consecutively for more than 2 minutes, trigger the 60-second grace period countdown (`startGracePeriod(uuid)`).
  - Ensure this does not trigger on pool-managed (`Prewarm` / `Buffer`) instances which already have their own phase reconciliation timeouts.

### Task C: AWS SDK API Throttling Safeguard (Caching)
* **Goal**: Avoid hitting AWS rate limits (throttling) when multiple clients simultaneously check status, which can break the pool replenishment loop and dashboard audits.
* **Repository**: `maximall-web`
* **Implementation Plan**:
  - Add a caching layer inside `EC2Service.getInstanceStatus(instanceId)`.
  - Cache the AWS state and IP address of instances with a TTL (Time-To-Live) of 2–3 seconds.
  - If a client status check requests status within the TTL, return the cached record instead of executing a new `DescribeInstancesCommand` on AWS.

### Task D: "Stopping" State Hang Watchdog
* **Goal**: Identify and clean up EC2 instances that get stuck indefinitely in the `"stopping"` state due to OS-level shutdown hangs on AWS.
* **Repository**: `maximall-web`
* **Implementation Plan**:
  - Add a watchdog audit check inside `ScalingService.forceReconcile()`.
  - Track how long an instance has spent in the `"stopping"` status in the database.
  - If an instance remains in `"stopping"` for more than 10 minutes, automatically issue a force-termination request to AWS using `TerminateInstancesCommand` to clean up the resource.
