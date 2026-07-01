import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeImagesCommand,
  Filter,
} from '@aws-sdk/client-ec2';
import { config } from '../config';
import { InstanceWithSessions } from '../types/instance.types';
import { randomUUID } from 'crypto';

export class EC2Service {
  private client: EC2Client;

  constructor() {
    this.client = new EC2Client({
      region: config.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  async startInstance(instanceId: string): Promise<{ success: boolean; state: string }> {
    const command = new StartInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true, state: 'pending' };
  }

  async stopInstance(instanceId: string): Promise<{ success: boolean; state: string }> {
    const command = new StopInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true, state: 'stopping' };
  }

  async terminateInstance(instanceId: string): Promise<{ success: boolean }> {
    console.log(`[EC2Service] TerminateInstancesCommand called for ${instanceId}. Call stack:\n`, new Error().stack);
    const command = new TerminateInstancesCommand({ InstanceIds: [instanceId] });
    await this.client.send(command);
    return { success: true };
  }

  async getInstanceStatus(instanceId: string): Promise<{ state: string; ip: string | null }> {
    const command = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
    const response = await this.client.send(command);
    const instance = response.Reservations?.[0]?.Instances?.[0];
    return {
      state: instance?.State?.Name || 'unknown',
      ip: instance?.PublicIpAddress || null,
    };
  }

  async getAmiIdByName(name: string): Promise<string> {
    // 1. Try to search by Tag: Name (e.g. tag:Name=LinuxClientAMI)
    try {
      const command = new DescribeImagesCommand({
        Owners: ['self'],
        Filters: [
          { Name: 'tag:Name', Values: [name] }
        ]
      });
      const response = await this.client.send(command);
      const amiId = response.Images?.[0]?.ImageId;
      if (amiId) return amiId;
    } catch (e: any) {
      console.warn(`[EC2] DescribeImages by tag:Name failed: ${e.message}`);
    }

    // 2. Try to search by Image Name attribute (e.g. name=LinuxClientAMI)
    try {
      const command = new DescribeImagesCommand({
        Owners: ['self'],
        Filters: [
          { Name: 'name', Values: [name] }
        ]
      });
      const response = await this.client.send(command);
      const amiId = response.Images?.[0]?.ImageId;
      if (amiId) return amiId;
    } catch (e: any) {
      console.warn(`[EC2] DescribeImages by name failed: ${e.message}`);
    }

    // 3. Fallback: if name is 'LinuxClientAMI', try to search by Image Name 'LinuxClient'
    if (name === 'LinuxClientAMI') {
      try {
        const command = new DescribeImagesCommand({
          Owners: ['self'],
          Filters: [
            { Name: 'name', Values: ['LinuxClient'] }
          ]
        });
        const response = await this.client.send(command);
        const amiId = response.Images?.[0]?.ImageId;
        if (amiId) return amiId;
      } catch (e: any) {
        console.warn(`[EC2] DescribeImages by fallback name failed: ${e.message}`);
      }
    }

    throw new Error(`AMI named ${name} (or fallback) not found`);
  }

  async createInstance(
    instanceType: string,
    amiId: string,
    subnetId?: string,
    securityGroupId?: string
  ): Promise<{ instanceId: string }> {
    const finalSubnetId = subnetId || config.AWS_SUBNET_ID;
    const finalSecurityGroupId = securityGroupId || config.AWS_SECURITY_GROUP_ID;

    const runParams: any = {
      ImageId: amiId,
      InstanceType: instanceType as any,
      MinCount: 1,
      MaxCount: 1,
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: 'LinuxClient' },
            { Key: 'Purpose', Value: 'Prewarm' },
            { Key: 'ManagedByBackend', Value: 'true' },
          ]
        }
      ]
    };

    if (finalSubnetId && !finalSubnetId.includes('xxxxx')) {
      runParams.SubnetId = finalSubnetId;
    }
    if (finalSecurityGroupId && !finalSecurityGroupId.includes('xxxxx')) {
      runParams.SecurityGroupIds = [finalSecurityGroupId];
    }

    const command = new RunInstancesCommand(runParams);
    const response = await this.client.send(command);
    const instanceId = response.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error('Failed to create instance');
    return { instanceId };
  }

  /**
   * Discovers all EC2 instances that carry a specific Name tag value.
   * Terminated instances are excluded automatically.
   * Returns an array of InstanceWithSessions ready to be inserted into the DB.
   */
  async discoverInstancesByTag(tagName: string, tagValue: string): Promise<InstanceWithSessions[]> {
    const filters: Filter[] = [
      { Name: `tag:${tagName}`, Values: [tagValue] },
      // Exclude terminated instances — they are gone for good
      {
        Name: 'instance-state-name',
        Values: ['pending', 'running', 'stopping', 'stopped'],
      },
    ];

    const command = new DescribeInstancesCommand({ Filters: filters });
    const response = await this.client.send(command);

    const discovered: InstanceWithSessions[] = [];

    for (const reservation of response.Reservations ?? []) {
      for (const ec2 of reservation.Instances ?? []) {
        if (!ec2.InstanceId) continue;

        // Use the EC2 instanceId as a stable UUID seed so restarts
        // always produce the same UUID for the same physical machine.
        const uuid = ec2.InstanceId;

        // Read the Name tag as the display label
        const nameTag = ec2.Tags?.find(t => t.Key === 'Name')?.Value ?? 'Без метки';
        const purposeTag = ec2.Tags?.find(t => t.Key === 'Purpose')?.Value;
        const managedByBackend = ec2.Tags?.find(t => t.Key === 'ManagedByBackend')?.Value === 'true';

        // Map AWS state → app status
        const awsState = ec2.State?.Name ?? 'stopped';
        type AppStatus = 'stopped' | 'running' | 'pending' | 'stopping' | 'terminated';
        const stateMap: Record<string, AppStatus> = {
          pending:  'pending',
          running:  'running',
          stopping: 'stopping',
          stopped:  'stopped',
          'shutting-down': 'stopping',
          terminated: 'terminated',
        };
        const status: AppStatus = stateMap[awsState] ?? 'stopped';

        let assignedTo = nameTag;
        if (purposeTag === 'Prewarm') {
          assignedTo = status === 'stopped' ? 'Buffer' : 'Prewarm';
        }

        discovered.push({
          uuid,
          instanceId: ec2.InstanceId,
          displayLimitHours: 0,
          realLimitHours: 0,
          displayTimeUsedSeconds: 0,
          realTimeUsedSeconds: 0,
          status,
          createdAt: ec2.LaunchTime?.toISOString() ?? new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          assignedTo,
          managedByBackend,
          ec2Config: {
            instanceType: ec2.InstanceType ?? 'g4dn.2xlarge',
            region: config.AWS_REGION || 'eu-central-1',
            amiId: ec2.ImageId ?? '',
            securityGroupId: ec2.SecurityGroups?.[0]?.GroupId ?? '',
            subnetId: ec2.SubnetId ?? '',
          },
          activeSessions: new Map(),
        });
      }
    }

    return discovered;
  }
}
