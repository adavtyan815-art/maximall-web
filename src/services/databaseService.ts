import { InstanceRegistry, InstanceWithSessions } from '../types/instance.types';

/**
 * Pure in-memory store for instance state.
 * No MongoDB — all data lives in process memory.
 * Data is reset on server restart (intentional for this architecture).
 */
export class DatabaseService {
  private static instance: DatabaseService;

  private store: Map<string, InstanceWithSessions> = new Map();

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
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
    return this.store.delete(uuid);
  }
}
