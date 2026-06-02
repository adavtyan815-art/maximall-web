import mongoose, { Schema, Document } from 'mongoose';

// ---- Session sub-document ----
const SessionSchema = new Schema(
  {
    socketId: { type: String },
    hostToken: { type: String, required: true },
    lastSeenAt: { type: Number, required: true },
    displayStarted: { type: Boolean, default: false },
    ipAddress: { type: String },
  },
  { _id: false }
);

// ---- EC2 config sub-document ----
const Ec2ConfigSchema = new Schema(
  {
    instanceType: { type: String, required: true },
    region: { type: String, required: true },
    amiId: { type: String, required: true },
    securityGroupId: { type: String, required: true },
    subnetId: { type: String, required: true },
  },
  { _id: false }
);

// ---- Main Instance document ----
export interface IInstanceDocument extends Document {
  uuid: string;
  instanceId: string;
  displayLimitHours: number;
  realLimitHours: number;
  displayTimeUsedSeconds: number;
  realTimeUsedSeconds: number;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt?: string;
  assignedTo: string | null;
  lastError?: string | null;
  ec2Config: {
    instanceType: string;
    region: string;
    amiId: string;
    securityGroupId: string;
    subnetId: string;
  };
  // Stored as plain object array in Mongo; converted to Map in-memory
  activeSessions: Record<string, {
    socketId?: string;
    hostToken: string;
    lastSeenAt: number;
    displayStarted: boolean;
    ipAddress?: string;
  }>;
}

const InstanceSchema = new Schema<IInstanceDocument>(
  {
    uuid:                    { type: String, required: true, unique: true, index: true },
    instanceId:              { type: String, required: true },
    displayLimitHours:       { type: Number, required: true },
    realLimitHours:          { type: Number, required: true },
    displayTimeUsedSeconds:  { type: Number, default: 0 },
    realTimeUsedSeconds:     { type: Number, default: 0 },
    status:                  { type: String, required: true },
    createdAt:               { type: String, required: true },
    lastActiveAt:            { type: String, required: true },
    expiresAt:               { type: String },
    assignedTo:              { type: String, default: null },
    lastError:               { type: String, default: null },
    ec2Config:               { type: Ec2ConfigSchema, required: true },
    // Store Map as a plain object (Mongoose Mixed) - serialized on save, revived on load
    activeSessions:          { type: Schema.Types.Mixed, default: {} },
  },
  {
    // Disable auto-generated _id-based timestamps; we manage our own ISO strings
    timestamps: false,
    versionKey: false,
  }
);

export const InstanceModel = mongoose.model<IInstanceDocument>('Instance', InstanceSchema);
