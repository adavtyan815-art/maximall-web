export interface Settings {
  updateDate: string;
  defaultRealLimitHours: number;
  defaultDisplayLimitHours: number;
  idleTimeoutMinutes?: number;
}

const DEFAULT_SETTINGS: Settings = {
  updateDate: '18/04/2026',
  defaultRealLimitHours: 8,
  defaultDisplayLimitHours: 4,
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
