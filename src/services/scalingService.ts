import { EC2Service } from './ec2Service';
import { DatabaseService } from './databaseService';

export class ScalingService {
  private static instance: ScalingService;
  private ec2Service: EC2Service;
  private db: DatabaseService;

  private constructor() {
    this.ec2Service = new EC2Service();
    this.db = DatabaseService.getInstance();
  }

  static getInstance(): ScalingService {
    if (!ScalingService.instance) {
      ScalingService.instance = new ScalingService();
    }
    return ScalingService.instance;
  }

  /**
   * Terminate and remove an instance from AWS and DatabaseService.
   */
  async terminateAndRemove(uuid: string): Promise<void> {
    const inst = this.db.getInstance(uuid);
    if (!inst) return;

    console.log(`[Scaling] On-Demand Clean: Terminating instance ${inst.instanceId} (${uuid})`);
    inst.status = 'stopping';
    await this.db.saveInstance(uuid, inst);

    try {
      await this.ec2Service.terminateInstance(inst.instanceId);
      await this.db.deleteInstance(uuid);
      console.log(`[Scaling] On-Demand Clean: Instance ${inst.instanceId} successfully terminated and removed from pool.`);
    } catch (err: any) {
      console.error(`[Scaling] On-Demand Clean: Failed to terminate ${inst.instanceId}:`, err.message);
    }
  }
}
