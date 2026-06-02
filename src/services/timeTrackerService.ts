import { DatabaseService } from './databaseService';
import { EventEmitter } from 'events';

/**
 * Tracks real-time timers and grace periods per instance.
 * Quota/display-timer logic removed — no limits enforced.
 * Grace period (60 s) and real-time start/stop are preserved.
 */
export class TimeTrackerService extends EventEmitter {
  private static instance: TimeTrackerService;
  private db: DatabaseService;
  private realTimers: Map<string, NodeJS.Timeout> = new Map();
  private gracePeriodTimers: Map<string, NodeJS.Timeout> = new Map();

  static getInstance(): TimeTrackerService {
    if (!TimeTrackerService.instance) {
      TimeTrackerService.instance = new TimeTrackerService();
    }
    return TimeTrackerService.instance;
  }

  private constructor() {
    super();
    this.db = DatabaseService.getInstance();
  }

  // ── Display timer stubs (kept for call-site compatibility) ───────────────
  startDisplayTimer(_instanceUuid: string): void { /* no-op */ }
  stopDisplayTimer(_instanceUuid: string): void  { /* no-op */ }

  // ── Real-time tracker ────────────────────────────────────────────────────
  startRealTimer(instanceUuid: string): void {
    if (!this.realTimers.has(instanceUuid)) {
      const timer = setInterval(async () => {
        const instance = this.db.getInstance(instanceUuid);
        if (instance && (instance.status === 'running' || instance.status === 'stopping')) {
          instance.realTimeUsedSeconds = (instance.realTimeUsedSeconds || 0) + 1;
          await this.db.saveInstance(instanceUuid, instance);
        }
      }, 1000);
      this.realTimers.set(instanceUuid, timer);
    }
  }

  stopRealTimer(instanceUuid: string): void {
    const timer = this.realTimers.get(instanceUuid);
    if (timer) {
      clearInterval(timer);
      this.realTimers.delete(instanceUuid);
    }
  }

  // ── Grace period ─────────────────────────────────────────────────────────
  startGracePeriod(instanceUuid: string, onTimeout: () => Promise<void>): void {
    // Clear any existing grace period for this instance
    const existing = this.gracePeriodTimers.get(instanceUuid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      await onTimeout();
      this.gracePeriodTimers.delete(instanceUuid);
    }, 60000); // 60-second grace period

    this.gracePeriodTimers.set(instanceUuid, timer);
  }

  cancelGracePeriod(instanceUuid: string): void {
    const timer = this.gracePeriodTimers.get(instanceUuid);
    if (timer) {
      clearTimeout(timer);
      this.gracePeriodTimers.delete(instanceUuid);
    }
  }

  hasGracePeriod(instanceUuid: string): boolean {
    return this.gracePeriodTimers.has(instanceUuid);
  }

  getInstancesInGrace(): string[] {
    return Array.from(this.gracePeriodTimers.keys());
  }
}
