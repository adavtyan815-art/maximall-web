export interface Instance {
  uuid: string;                       // Public-facing unique identifier
  instanceId: string;                 // AWS EC2 instance ID
  displayLimitHours: number;          // User quota in hours
  realLimitHours: number;             // Internal reserve quota
  displayTimeUsedSeconds: number;     // Accumulated user time
  realTimeUsedSeconds: number;        // Accumulated reserve time
  status: 'stopped' | 'running' | 'pending' | 'stopping' | 'terminated';
  createdAt: string;                  // ISO timestamp
  lastActiveAt: string;               // ISO timestamp
  expiresAt?: string;                 // ISO timestamp
  assignedTo: string | null;          // Optional client name
  pinggyUrl?: string;                 // Dynamic Pinggy tunnel URL reported by EC2 on boot
  publicIp?: string;                  // Public IP of the instance for direct connection proxying
  streamerConnected?: boolean;        // True once UE5 streamer has connected to signaling server
  managedByBackend?: boolean;
  ec2Config: {
    instanceType: string;             // e.g., 'g4dn.2xlarge'
    region: string;                   // e.g., 'us-east-2'
    amiId: string;                    // AMI with Pixel Streaming configured
    securityGroupId: string;
    subnetId: string;
  };
}

export interface Session {
  socketId?: string;                  // Socket.io connection ID
  hostToken: string;                  // Random token for this session
  lastSeenAt: number;                 // Unix timestamp (ms)
  displayStarted: boolean;            // Whether display timer is active
  ipAddress?: string;                 // Client IP for logging
  deviceId?: string;                  // Persistent hardware ID (localStorage)
}

export interface InstanceWithSessions extends Instance {
  activeSessions: Map<string, Session>; // socketId → Session
}

export interface InstanceRegistry {
  instances: Record<string, InstanceWithSessions>;
  lastBackup: string;                 // ISO timestamp
  version: number;                    // Schema version
}
