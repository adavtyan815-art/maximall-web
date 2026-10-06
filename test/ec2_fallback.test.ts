/**
 * 2026-10-06: g6.xlarge InsufficientInstanceCapacity in all Frankfurt AZs. createInstance falls back over
 * FALLBACK_INSTANCE_TYPES (each subnet + once without a subnet), reports the launched type, and records the last error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EC2Service } from '../src/services/ec2Service';

function capacityErr(type: string) {
  const e: any = new Error(`We currently do not have sufficient ${type} capacity in the Availability Zone you requested.`);
  e.name = 'InsufficientInstanceCapacity';
  return e;
}

function svcWith(send: (input: any) => any) {
  const svc = new EC2Service() as any;
  svc.client = { send: async (cmd: any) => send(cmd.input) };
  svc.getAvailableSubnets = async () => ['subnet-a', 'subnet-b', 'subnet-c'];
  return svc as EC2Service;
}

describe('EC2 capacity fallback', () => {
  beforeEach(() => { process.env.FALLBACK_INSTANCE_TYPES = 'g6.2xlarge,g4dn.2xlarge'; process.env.LAUNCH_RETRY_ROUNDS = '1'; EC2Service.lastLaunchError = null; });
  afterEach(() => { delete process.env.FALLBACK_INSTANCE_TYPES; delete process.env.LAUNCH_RETRY_ROUNDS; });

  it('launches the first fallback type with capacity and reports it', async () => {
    const seen: string[] = [];
    const svc = svcWith((input) => {
      seen.push(`${input.InstanceType}@${input.SubnetId ?? 'any'}`);
      if (input.InstanceType === 'g6.xlarge') throw capacityErr('g6.xlarge');
      return { Instances: [{ InstanceId: 'i-123' }] };
    });
    const r = await svc.createInstance('g6.xlarge', 'ami-1');
    expect(r).toEqual({ instanceId: 'i-123', instanceType: 'g6.2xlarge' });
    expect(seen).toEqual(['g6.xlarge@subnet-a', 'g6.xlarge@subnet-b', 'g6.xlarge@subnet-c', 'g6.xlarge@any', 'g6.2xlarge@subnet-a']);
    expect(EC2Service.lastLaunch?.ok).toBe(true);
  });

  it('records a capacity error when every type and AZ is full', async () => {
    const svc = svcWith((input) => { throw capacityErr(input.InstanceType); });
    await expect(svc.createInstance('g6.xlarge', 'ami-1')).rejects.toMatchObject({ capacity: true });
    expect(EC2Service.lastLaunchError?.ok).toBe(false);
    expect(EC2Service.lastLaunchError?.attempts?.length).toBe(12);
  });

  it('stops trying subnets of a type on a non-capacity error', async () => {
    let calls = 0;
    const svc = svcWith(() => { calls++; const e: any = new Error('Not authorized'); e.name = 'UnauthorizedOperation'; throw e; });
    await expect(svc.createInstance('g6.xlarge', 'ami-1')).rejects.toMatchObject({ capacity: false });
    expect(calls).toBe(3); // one per type, no subnet loop, no retry round
  });
});
