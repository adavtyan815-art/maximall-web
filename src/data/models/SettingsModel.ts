import mongoose, { Schema, Document } from 'mongoose';

export interface ISettingsDocument extends Document {
  // Use a fixed key so there is only ever ONE settings document
  _key: string;
  updateDate: string;
  defaultRealLimitHours: number;
  defaultDisplayLimitHours: number;
}

const SettingsSchema = new Schema<ISettingsDocument>(
  {
    _key:                   { type: String, default: 'global', unique: true, index: true },
    updateDate:             { type: String, default: '' },
    defaultRealLimitHours:  { type: Number, default: 8 },
    defaultDisplayLimitHours: { type: Number, default: 4 },
  },
  { versionKey: false }
);

export const SettingsModel = mongoose.model<ISettingsDocument>('Settings', SettingsSchema);
