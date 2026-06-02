import dotenv from 'dotenv';

dotenv.config();

export const config = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_REGION: process.env.AWS_REGION || 'us-east-2',
  AWS_SECURITY_GROUP_ID: process.env.AWS_SECURITY_GROUP_ID || '',
  AWS_SUBNET_ID: process.env.AWS_SUBNET_ID || '',
  AWS_AMI_ID: process.env.AWS_AMI_ID || '',
  DEFAULT_INSTANCE_TYPE: process.env.DEFAULT_INSTANCE_TYPE || 'g4dn.2xlarge',

  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'secret',

  // Public-facing base URL (ngrok tunnel in production)
  BASE_URL: process.env.BASE_URL || 'https://hooly-superblessed-shan.ngrok-free.dev',

  HEARTBEAT_TIMEOUT_MS: Number(process.env.HEARTBEAT_TIMEOUT_MS) || 30000,
  GRACE_PERIOD_MS: Number(process.env.GRACE_PERIOD_MS) || 60000,
  SESSION_CLEANUP_INTERVAL_MS: Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 10000,
};
