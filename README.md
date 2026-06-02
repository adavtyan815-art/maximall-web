# Multi-Instance 3D Streaming Platform

This codebase contains the implementation for a production-ready Multi-Instance 3D Streaming platform powered by Epic Games Pixel Streaming and AWS EC2.

## Features

- **Multi-Instance Support**: Isolated 3D applications running on individual AWS EC2 instances.
- **WebSocket Communication**: Real-time heartbeat, display timers, and session state via Socket.io.
- **Usage Tracking**: Tracks both "display" vs "real" EC2 hourly usage per instance.
- **Auto-stop Grace Periods**: Unused instances auto-stop gracefully based on inactivity.
- **Admin Dashboard**: Web interface for managing quotas, instances, and usage metrics.

## Getting Started

1. Clone or download in local folder: `new-version`
2. Install dependencies:
   ```bash
   npm install
   ```
3. Update `.env` file with your AWS details.
4. Run in dev:
   ```bash
   npm run dev
   ```
5. Seed a test instance:
   ```bash
   npm run seed
   ```

## Integrations

- Ensure you replace `webserver-aws/player.js` on your actual EC2 AMIs so they correctly emit WebSockets.
- Make sure `webserver-aws/player.html` references socket.io.
