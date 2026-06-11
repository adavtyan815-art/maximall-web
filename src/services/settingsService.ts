export interface Settings {
  updateDate: string;
  defaultRealLimitHours: number;
  defaultDisplayLimitHours: number;
  idleTimeoutMinutes?: number;
  serverHourlyRate?: number;
  /** Minimum number of stopped, pre-warmed instances to keep in the buffer pool. */
  minBufferTarget?: number;
}

const DEFAULT_SETTINGS: Settings = {
  updateDate: '18/04/2026',
  defaultRealLimitHours: 8,
  defaultDisplayLimitHours: 4,
  serverHourlyRate: 0.94,
  // 0 = passive mode on startup. The system launches no prewarm instances
  // automatically until the admin explicitly sets a target via the
  // "Применить и выровнять" button on the Dashboard.
  minBufferTarget: 0,
};

/**
 * Pure in-memory settings store.
 * No MongoDB — settings reset on server restart.
 */
export class SettingsService {
  private static instance: SettingsService;
  private cache: Settings = { ...DEFAULT_SETTINGS };

  static getInstance(): SettingsService {
    if (!SettingsService.instance) {
      SettingsService.instance = new SettingsService();
    }
    return SettingsService.instance;
  }

  // Kept for call-site compatibility in server.ts
  async init(): Promise<void> {
    console.log('[SettingsService] In-memory settings ready (no MongoDB).');
  }

  getSettings(): Settings {
    return { ...this.cache };
  }

  async save(settings: Partial<Settings>): Promise<void> {
    this.cache = { ...this.cache, ...settings };
  }
}
