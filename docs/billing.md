# Server Cost Tracking & Billing Architecture

This document describes the billing architecture, time-tracking logic, and server configuration settings implemented in the `maximall-web` orchestrator.

---

## 1. Billing Overview

To monitor and control infrastructure costs without relying on paid AWS APIs (such as Cost Explorer), the orchestrator calculates server costs locally in real-time. The calculations are based on:
1. **Server Uptime Tracking**: Accurately measuring the lifecycle duration of EC2 instances.
2. **Hourly Rate Configuration**: A user-defined rate ($) to scale running hours into costs.
3. **AWS Billing Matching**: Emulating AWS billing rules (e.g., minimum run time limits).

---

## 2. Server Hourly Rate Settings

In the **Настройки** (Settings) panel of the Admin Dashboard, administrators can configure the hourly running rate of GPU instances:
- **Parameter**: `serverHourlyRate` (stored in settings schema via `SettingsService`).
- **Default Value**: `0.94` (corresponding to the standard hourly cost of a `g4dn.2xlarge` instance).
- **Access and Updates**: The hourly rate is loaded and persisted dynamically when changes are submitted, updating the calculation coefficient for the dashboard statistics.

---

## 3. Lifecycle Time Tracking

Instance running times are measured continuously across all execution phases.

### A. Active States
The calculation tracks the absolute uptime of instances by monitoring transitions in the scaling lifecycle:
* **Pre-warm & Provisioning**: Cost accumulation begins the exact second an EC2 instance transitions to the `'running'` state in AWS (Phase 1 BOOT). It continues as the instance goes through tunnel verification, signal validation, and streamer health checks.
* **Buffer standby**: While an instance is running in the buffer pool or awaiting a user connection, its time continues to accumulate.
* **Active sessions**: The timer runs uninterrupted when a user claims the instance and connects to their WebRTC session.
* **Shutdown / Terminated states**: Cost accumulation stops the exact second the instance transitions to `stopping`, `stopped`, or is permanently terminated by AWS.

### B. 60-Second Minimum Launch Rule
AWS bills EC2 instances with a 60-second minimum charge upon startup. To align local cost calculations with actual AWS billing with high accuracy:
- The `TimeTrackerService` tracks the duration of each individual start-stop or start-termination cycle using `runElapsedSeconds`.
- If an instance is stopped or terminated before it has run for at least 60 seconds (for example, a failed pre-warm instance is cleaned up after 20 seconds), the system automatically pads the `realTimeUsedSeconds` of that instance to meet the 60-second minimum.
- For example, if an instance runs for only 15 seconds, the service adds a 45-second padding upon shutdown.

---

## 4. Historical Cost Preservation (Accumulator)

Because instances are deleted from the backend memory database registry upon termination (`deleteInstance()`), calculating total time using only active/active-idle memory maps would result in the loss of all historical cost data when servers shut down.

To solve this:
1. **`totalArchivedSeconds` Accumulator**: The `DatabaseService` maintains a global running time accumulator.
2. **Archiving on Deletion**: When an instance is terminated and its database record is removed via `deleteInstance(uuid)`, its accumulated lifetime running time (including any 60-second minimum padding) is archived to the `totalArchivedSeconds` global state.
3. **Dashboard Summation**: The Admin Dashboard `/api/admin/dashboard` endpoint calculates total time and costs by summing:
   $$\text{Total Time} = \text{totalArchivedSeconds} + \sum \text{realTimeUsedSeconds of active instances}$$
4. **Resets**: Clicking the **Сброс** (Reset) button on the dashboard triggers a request to `/api/admin/instances/reset-all-time`. This resets all current instance counters to `0` and clears `totalArchivedSeconds` back to `0`.

---

## 5. Summary of API Properties

The `/api/admin/dashboard` endpoint includes the following billing metadata in the `stats` response:
* `totalTimeSeconds`: Combined running time of active and archived instances (seconds).
* `totalCost`: Cumulative dollar amount spent based on total hours and the hourly rate.
* `serverHourlyRate`: The active multiplier used for calculations.
