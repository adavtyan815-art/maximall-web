export interface WebSocketMessage {
  type: 'display-start' | 'heartbeat' | 'disconnect' | 'time-expired' | 'instance-stopping';
  instanceUuid: string;
  hostToken?: string;
  timestamp?: number;
  data?: any;
}

export interface HeartbeatData {
  instanceUuid: string;
  hostToken: string;
  timestamp: number;
}

export interface DisplayStartData {
  instanceUuid: string;
  hostToken: string;
  timestamp: number;
  deviceId?: string;
}
