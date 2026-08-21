# Claude Code & AI Agent Guide — Maximall Web Orchestrator (`maximall-web`)

---

## 1. Project Overview & Primary Sources of Truth

`maximall-web` is the Node.js TypeScript orchestrator and reverse-proxy backend managing multi-instance Epic Games Pixel Streaming on AWS EC2 GPU instances (`g4dn.2xlarge` with NVIDIA Tesla T4 GPU, running custom AMI `LinuxClientAMI`).

- **What it does**: Dynamically manages a hot-standby pool of stopped GPU instances, wakes or launches instances on user demand, reverse-proxies HTTP player assets and WebSocket signaling over intra-VPC private IPs (`172.31.x.x:8000`), enforces session ownership and time limits, and gracefully recycles idle instances back into the buffer pool.
- **Deep Source of Truth**: Before making architectural, scaling, or backend changes, Claude Code, Antigravity, and future AI agents **must read** [`docs/MAXIMALL_WEB_GUIDE.md`](MAXIMALL_WEB_GUIDE.md).
- **Roadmap & Future Tasks**: Active planned work and edge-case tasks are tracked in [`docs/todo.md`](todo.md).

---

## 2. Essential Build & Run Commands

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Start development server (with ts-node / watcher)
npm run dev

# Start production compiled server
npm start

# Seed in-memory database with test instances
npm run seed
```

---

## 3. Protected Invariants & Rules (DO NOT BREAK THESE RULES)

### A. Private-IP-First Intra-VPC Routing
- Always use `inst.privateIp || inst.publicIp` when connecting to GPU instances for readiness polling, prewarm verification, HTTP proxying, or WebSocket signaling proxying.
- The client browser never connects directly to the raw GPU instance IP; all browser traffic passes through the reverse proxy.

### B. Base / Extra Standby Pool State Machine
- Invariant Formulas:
  - $\text{MaxAllowed} = \max(0, \text{Base} + \text{Extra} - \text{Active})$
  - $\text{EffectiveBuffer} = \text{Ready (stopped Buffer)} + \text{Recycling} + \text{Prewarming}$
  - $\text{Deficit} = \max(0, \text{Base} - \text{EffectiveBuffer})$
  - $\text{Surplus} = \max(0, \text{EffectiveBuffer} - \text{MaxAllowed})$
- Extra boost capacity is consumed by active users without spawning replacement prewarms.
- Surplus instances are terminated LIFO from stopped buffers only; in-flight prewarms are never killed.

### C. Multi-Buffer Claim with Rollback
- When waking up stopped buffers, iterate sequentially through candidate buffers. If `StartInstancesCommand` fails on candidate #1 (e.g. AWS AZ capacity), roll back its claim (`assignedTo = "Buffer"`, `status = "stopped"`) and immediately attempt candidate #2.

### D. Automated Graceful Recycling (`recycleInstanceToBuffer`)
- When a user session disconnects and the 60-second grace period expires, running instances must **not** be terminated with `TerminateInstancesCommand`. Instead, call `recycleInstanceToBuffer(instanceUuid)`, sending AWS `StopInstancesCommand` to return the instance to `assignedTo = "Buffer"` in the stopped pool.

### E. Multi-Tab & Session Protection
- One active streaming session per physical device (`deviceId`). Secondary tabs from the same device must receive `session-in-use` (*"3D-комната уже открыта в другой вкладке."*).
- Page refreshes (F5) must re-attach to the existing session via `hostToken` without spawning duplicate instances.

### F. Russian User-Facing Errors
- All user-facing error messages, banners, and modal dialogs must be in clean, user-friendly Russian.

---

## 4. Change Inspection & Verification Workflow

Before modifying any file:
1. Inspect the corresponding source code and [`docs/MAXIMALL_WEB_GUIDE.md`](MAXIMALL_WEB_GUIDE.md).
2. Ensure proposed changes do not break external contracts with `maximall-pixel-config` (Wilbur signaling on port 8000) or `awsTutorial` (Unreal Engine Save/Load REST payloads).

After making changes:
1. Run `npm run build` (Must succeed with zero TypeScript compilation errors).
2. Test session allocation, WebSocket proxying, and pool reconciliation logic.
