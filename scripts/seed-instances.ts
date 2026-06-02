import { DatabaseService } from '../src/services/databaseService';
import { randomUUID } from 'crypto';

async function seed() {
  const db = DatabaseService.getInstance();
  await db.init();

  const uuid = randomUUID();
  await db.saveInstance(uuid, {
    uuid,
    instanceId: 'i-0abcd1234efgh5678', // Fake ID
    displayLimitHours: 3,
    realLimitHours: 5,
    displayTimeUsedSeconds: 0,
    realTimeUsedSeconds: 0,
    status: 'stopped',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    assignedTo: 'Test Client',
    ec2Config: {
      instanceType: 'g4dn.2xlarge',
      region: 'us-east-2',
      amiId: 'ami-12345678',
      securityGroupId: 'sg-12345678',
      subnetId: 'subnet-12345678'
    },
    activeSessions: new Map()
  });

  console.log(`Seeded instance: ${uuid}`);
}

seed();
