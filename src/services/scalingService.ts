import { EC2Service } from './ec2Service';
import { DatabaseService } from './databaseService';
import { config } from '../config';
import { randomUUID } from 'crypto';

export class ScalingService {
  private static instance: ScalingService;
  private ec2Service: EC2Service;
  private db: DatabaseService;
  private isPrewarming = false;

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
   * Ensures exactly 1 idle (stopped) instance exists in the pool.
   * If there are 0 stopped instances, it triggers a pre-warm.
   */
  async ensureBufferInstance(): Promise<void> {
    if (this.isPrewarming) {
      console.log('[Scaling] Pre-warm already in progress. Skipping duplicate request.');
      return;
    }

    const instances = this.db.getInstances();
    const stoppedInstances = Object.values(instances).filter(inst => inst.status === 'stopped');

    if (stoppedInstances.length === 0) {
      this.isPrewarming = true;
      console.log('[Scaling] 0 idle buffer instances found. Triggering pre-warm...');
      
      this.preWarmNewInstance().finally(() => {
        this.isPrewarming = false;
      });
    } else {
      console.log(`[Scaling] Buffer check: ${stoppedInstances.length} idle instance(s) available. No action needed.`);
    }
  }

  /**
   * Launches a new instance using LinuxClientAMI, polls it until running,
   * sends stop command, and sets its final status to 'stopped' in the DB.
   */
  private async preWarmNewInstance(): Promise<void> {
    const tempUuid = randomUUID();
    try {
      console.log('[Scaling] Resolving LinuxClientAMI ID...');
      const amiId = await this.ec2Service.getAmiIdByName('LinuxClientAMI');
      console.log(`[Scaling] AMI resolved: ${amiId}. Spawning EC2 instance...`);

      // 1. Create the instance
      const { instanceId } = await this.ec2Service.createInstance('g4dn.2xlarge', amiId);
      console.log(`[Scaling] Pre-warm instance created: ${instanceId}`);

      // 2. Register it in our in-memory DB as pending
      await this.db.saveInstance(tempUuid, {
        uuid: tempUuid,
        instanceId,
        displayLimitHours: 0,
        realLimitHours: 0,
        displayTimeUsedSeconds: 0,
        realTimeUsedSeconds: 0,
        status: 'pending',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        assignedTo: `Buffer-${instanceId.substring(2, 8)}`,
        ec2Config: {
          instanceType: 'g4dn.2xlarge',
          region: config.AWS_REGION || 'eu-central-1',
          amiId,
          securityGroupId: config.AWS_SECURITY_GROUP_ID,
          subnetId: config.AWS_SUBNET_ID,
        },
        activeSessions: new Map(),
      });

      // 3. Start polling until the instance is running, then stop it.
      this.pollAndStopInstance(tempUuid, instanceId);

    } catch (err: any) {
      console.error('[Scaling] Pre-warm failed:', err.message);
      await this.db.deleteInstance(tempUuid);
    }
  }

  private pollAndStopInstance(uuid: string, instanceId: string): void {
    const pollInterval = setInterval(async () => {
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`[Scaling] Pre-warm instance ${instanceId} status check: ${awsStatus.state}`);

        const inst = this.db.getInstance(uuid);
        if (!inst) {
          clearInterval(pollInterval);
          return;
        }

        if (awsStatus.state === 'running') {
          clearInterval(pollInterval);
          console.log(`[Scaling] Pre-warm instance ${instanceId} is RUNNING. Sending STOP command to buffer it...`);
          
          await this.ec2Service.stopInstance(instanceId);
          inst.status = 'stopping';
          await this.db.saveInstance(uuid, inst);

          this.pollStoppedState(uuid, instanceId);
        } else if (awsStatus.state === 'stopped') {
          clearInterval(pollInterval);
          inst.status = 'stopped';
          await this.db.saveInstance(uuid, inst);
          console.log(`[Scaling] Pre-warm complete. Instance ${instanceId} is idle/stopped.`);
        }
      } catch (err: any) {
        console.error(`[Scaling] Error polling pre-warm instance ${instanceId}:`, err.message);
      }
    }, 5000);
  }

  private pollStoppedState(uuid: string, instanceId: string): void {
    const pollInterval = setInterval(async () => {
      try {
        const awsStatus = await this.ec2Service.getInstanceStatus(instanceId);
        console.log(`[Scaling] Pre-warm instance ${instanceId} stopping check: ${awsStatus.state}`);

        const inst = this.db.getInstance(uuid);
        if (!inst) {
          clearInterval(pollInterval);
          return;
        }

        if (awsStatus.state === 'stopped') {
          clearInterval(pollInterval);
          inst.status = 'stopped';
          await this.db.saveInstance(uuid, inst);
          console.log(`[Scaling] Pre-warm complete. Instance ${instanceId} is now idle/stopped (buffer).`);
        }
      } catch (err: any) {
        console.error(`[Scaling] Error polling stopped state for ${instanceId}:`, err.message);
      }
    }, 5000);
  }

  /**
   * Terminate and remove an instance from AWS and DatabaseService.
   */
  async terminateAndRemove(uuid: string): Promise<void> {
    const inst = this.db.getInstance(uuid);
    if (!inst) return;

    console.log(`[Scaling] Auto-Clean: Terminating instance ${inst.instanceId} (${uuid})`);
    inst.status = 'stopping';
    await this.db.saveInstance(uuid, inst);

    try {
      await this.ec2Service.terminateInstance(inst.instanceId);
      await this.db.deleteInstance(uuid);
      console.log(`[Scaling] Auto-Clean: Instance ${inst.instanceId} successfully terminated and removed from pool.`);
      
      // Check buffer status again
      await this.ensureBufferInstance();
    } catch (err: any) {
      console.error(`[Scaling] Auto-Clean: Failed to terminate ${inst.instanceId}:`, err.message);
    }
  }
}
