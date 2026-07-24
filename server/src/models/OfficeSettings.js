import mongoose from 'mongoose';

const officeSettingsSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    radiusMeters: { type: Number, required: true, default: 100 },
    maxAccuracyMeters: { type: Number, required: true, default: 50 },
    /**
     * Sandwich leave: when true, weekends/holidays between leave working days count
     * toward leave days (e.g. Fri+Mon leave also consumes Sat–Sun). Default off until HR enables.
     */
    sandwichLeaveEnabled: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const OfficeSettings = mongoose.model(
  'OfficeSettings',
  officeSettingsSchema,
);
