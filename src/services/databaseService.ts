import { InstanceRegistry, InstanceWithSessions } from '../types/instance.types';

/**
 * Pure in-memory store for instance state.
 * No MongoDB — all data lives in process memory.
 * Data is reset on server restart (intentional for this architecture).
 */
export class DatabaseService {
  private static instance: DatabaseService;

  private store: Map<string, InstanceWithSessions> = new Map();
  private totalArchivedSeconds: number = 0;

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  // -----------------------------------------------------------------------
  // Archived time accumulator
  // -----------------------------------------------------------------------
  getArchivedSeconds(): number {
    return this.totalArchivedSeconds;
  }

  addArchivedSeconds(seconds: number): void {
    this.totalArchivedSeconds += seconds;
  }

  resetArchivedSeconds(): void {
    this.totalArchivedSeconds = 0;
  }

  // -----------------------------------------------------------------------
  // Init — no-op now (kept for call-site compatibility in server.ts)
  // -----------------------------------------------------------------------
  async init(): Promise<void> {
    console.log('[DatabaseService] In-memory store ready (no MongoDB).');
  }

  // -----------------------------------------------------------------------
  // Reads — synchronous, 0 ms latency
  // -----------------------------------------------------------------------
  getInstances(): Record<string, InstanceWithSessions> {
    return Object.fromEntries(this.store);
  }

  getInstance(uuid: string): InstanceWithSessions | null {
    return this.store.get(uuid) ?? null;
  }

  // -----------------------------------------------------------------------
  // Writes — synchronous updates to the Map
  // -----------------------------------------------------------------------
  async saveInstance(uuid: string, instance: InstanceWithSessions): Promise<void> {
    this.store.set(uuid, instance);
  }

  async deleteInstance(uuid: string): Promise<boolean> {
    const inst = this.store.get(uuid);
    if (inst) {
      const finalSeconds = inst.realTimeUsedSeconds || 0;
      this.totalArchivedSeconds += finalSeconds;
      console.log(`[DatabaseService] Archiving ${finalSeconds}s from deleted instance ${uuid}. Total archived: ${this.totalArchivedSeconds}s`);
    }
    return this.store.delete(uuid);
  }
}
