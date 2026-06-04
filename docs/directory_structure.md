# Project Directory Structure

This document details the workspace folder structure and lists the purpose of each key file.

```
maximall-web/
├── .env                  # Local environment configuration file (not committed)
├── .env.example          # Sample environment variables for setup
├── Dockerfile            # Container configuration file for build packaging
├── docker-compose.yml    # Development server composition mapping
├── nginx.conf            # Reverse-proxy configuration for frontend assets
├── package.json          # Node package dependency mapping
├── tsconfig.json         # TypeScript compiler configurations
│
├── docs/                 # System technical documentation (reference folder)
│   ├── architecture.md   # Core component architecture and workflows
│   ├── directory_structure.md  # File layout references
│   ├── api_reference.md  # Endpoint details and socket protocols
│   ├── lifecycle.md      # State machines and prewarm lifecycles
│   └── infrastructure.md # AWS AMI and network requirements
│
├── public/               # Frontend client interfaces
│   ├── admin.html        # Glassmorphic admin dashboard layout
│   ├── index.html        # Client redirect and Wilbur loader interface
│   ├── login.html        # Credentials check screen for administrators
│   └── settings.html     # Settings configurations form
│
└── src/                  # TypeScript source files
    ├── app.ts            # REST API endpoints, routing, and manual controls
    ├── server.ts         # Bootstrapper initializing services on port 3000
    │
    ├── config/           # Configurations loader
    │   └── index.ts      # Merges process.env values into a static configuration config object
    │
    ├── data/             # Persistent schema compatibility layers
    │   ├── db.ts         # Legacy connection script (unused fallback stub)
    │   └── models/       # Models kept for backward-compatibility stubs
    │
    ├── services/         # Application core business logic
    │   ├── databaseService.ts    # In-memory Map repository registry
    │   ├── settingsService.ts    # Settings cache (display limits, limits configuration)
    │   ├── ec2Service.ts         # Wraps AWS SDK calls (Run, Terminate, Describe)
    │   ├── timeTrackerService.ts # Grace periods and active timer increments
    │   ├── scalingService.ts     # Pre-warm lifecycle machine & replenishment audits
    │   └── websocketService.ts   # Device websocket session mappings and grace periods
    │
    └── types/            # TypeScript type declarations
        ├── api.types.ts       # Endpoint response typing declarations
        ├── instance.types.ts  # Instance mappings and sessions schemas
        └── websocket.types.ts # Socket events signature mappings
```

---

## 1. Key File Summary

### A. Root Configuration Files
- **[package.json](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/package.json)**: Declares application metadata and npm packages. Key dependencies include `@aws-sdk/client-ec2`, `express`, `socket.io`, `ws`, and `ts-node-dev`/`nodemon` for hot-reloads.
- **[tsconfig.json](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/tsconfig.json)**: Configures compiler properties (`target: es2020`, `moduleResolution: node`, etc.).

### B. Core Services
- **[scalingService.ts](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/scalingService.ts)**: Contains the prewarm engine state-machine which manages five setup phases (BOOT, TUNNEL, SIGNAL, STREAMER, STOP) to prepare ready instances.
- **[websocketService.ts](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/websocketService.ts)**: Handles real-time communication, active sessions matching, reconnect buffer (15s), and client disconnect grace termination (60s).
- **[ec2Service.ts](file:///c:/Users/Admin/Desktop/Aleg/maximall-web/src/services/ec2Service.ts)**: Wraps all AWS SDK command invocations, handling instance start, stop, termination, and dynamic AMI name resolution.
