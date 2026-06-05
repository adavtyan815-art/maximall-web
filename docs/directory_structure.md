# Project Directory Structure - maximall-web

This document details the local workspace folder structure of the `maximall-web` orchestrator service and lists the purpose of each key file.

---

## 1. Directory Tree Layout

```
maximall-web/
├── .env                        # Local environment configuration file (not committed)
├── .env.example                # Sample environment variables for setup
├── Dockerfile                  # Container configuration file for production builds
├── docker-compose.yml          # Container configuration for staging deployments
├── nginx.conf                  # Reverse-proxy configuration for frontend assets
├── package.json                # Project dependencies and script commands
├── tsconfig.json               # TypeScript compiler configurations
│
├── docs/                       # System technical documentation
│   ├── architecture.md         # Core component architecture and network boundary flows
│   ├── directory_structure.md  # This file layout reference
│   ├── api_reference.md        # REST API endpoints and Socket.IO websocket protocols
│   ├── lifecycle.md            # pre-warm, claiming, grace periods and idle timeouts
│   └── infrastructure.md       # AWS IAM, AMI and network requirements
│
├── public/                     # Admin dashboard static pages
│   ├── admin.html              # Glassmorphic admin control panel page
│   ├── index.html              # Client entryway and loading screen launcher
│   ├── login.html              # Credentials check screen for administrators
│   └── settings.html           # Limits settings configuration page
│
└── src/                        # TypeScript source files
    ├── app.ts                  # REST API endpoints, routing, and admin control handlers
    ├── server.ts               # App bootstrapper initializing services on port 3000
    │
    ├── config/                 # Configurations loader
    │   └── index.ts            # Parses environment variables into a static config object
    │
    ├── data/                   # Data structures compatibility layer
    │   ├── db.ts               # Legacy database stub
    │   └── models/             # Legacy database models
    │
    ├── services/               # Core backend services
    │   ├── databaseService.ts  # In-memory database registry for instances
    │   ├── settingsService.ts  # In-memory settings storage
    │   ├── ec2Service.ts       # AWS EC2 SDK command wrapping service
    │   ├── timeTrackerService.ts # Real timer increments and grace periods
    │   ├── scalingService.ts   # Standby pre-warm loop and phase transitions
    │   └── websocketService.ts # Client Socket.IO routing sessions and watcher loops
    │
    └── types/                  # TypeScript interface declarations
        ├── api.types.ts        # Admin dashboard HTTP response types
        ├── instance.types.ts   # Database registry instance schemas
        └── websocket.types.ts  # Socket.IO incoming and outgoing event typings
```

---

## 2. Key File Summary

### A. Root Configuration Files
- **[package.json](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/package.json)**: Declares metadata and packages. Important dependencies are `@aws-sdk/client-ec2`, `express`, `socket.io`, `ws`, and development packages like `typescript`, `ts-node-dev`, and `nodemon`.
- **[tsconfig.json](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/tsconfig.json)**: Instructs the TypeScript compiler (`target: es2020`, `moduleResolution: node`).

### B. Core Services
- **[app.ts](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/src/app.ts)**: Implements all REST endpoints, middleware configurations, security cookie sessions, and public client redirect pathways.
- **[websocketService.ts](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts)**: Configures Socket.IO real-time client management, connection recovery intervals, and user inactivity watchdog timers.
- **[scalingService.ts](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/src/services/scalingService.ts)**: Hosts the standby pre-warm pool reconciliation loop and guides instances through the 5-phase validation sequence (BOOT -> TUNNEL -> SIGNAL -> STREAMER -> STOP).
- **[ec2Service.ts](file:///C:/Users/Admin/Desktop/Aleg/maximall-web/src/services/ec2Service.ts)**: Integrates with the AWS SDK client, firing start/stop/terminate/describe commands.

---

## 3. Conceptual Link: `maximall-pixel-config` Repository

The `maximall-web` application does **not** contain the rendering or streaming code directly. Instead, it interfaces with **`maximall-pixel-config`**, which is a separate and distinct Git repository located on the desktop filesystem under:
- Local path: `C:/Users/Admin/Desktop/Aleg/maximall-pixel-config`
- Remote URL: `https://github.com/adavtyan815-art/maximall-pixel-config.git`

This separate repository handles:
1. **The Signaling Layer**: Exposes WebRTC ports and tracks connection states.
   - Key File: `SignallingWebServer/src/index.ts` (triggers the streamer-disconnected webhook back to `maximall-web`).
2. **The Streamer Page**: Exposes the interactive UI player.
   - Key Files: `Frontend/implementations/typescript/src/player.html` and `player.ts` (implements the glassmorphic Idle Timeout modal overlay and reports user activity).

Refer to the external repository's documentation directory (`maximall-pixel-config/docs/`) for a comprehensive guide on the streaming infrastructure.
