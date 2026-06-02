export interface CreateInstanceRequest {
  displayLimitHours: number;
  realLimitHours: number;
  assignedTo?: string;
  instanceType?: string;              // Default from .env
}

export interface UpdateQuotaRequest {
  displayLimitHours?: number;
  realLimitHours?: number;
}

export interface ConnectResponse {
  success: boolean;
  status: 'pending' | 'running' | 'stopped' | 'quota_exceeded';
  ip?: string;
  instanceUuid: string;
  message?: string;
  timeLeft?: {
    display: string;
    real: string;
  };
}
