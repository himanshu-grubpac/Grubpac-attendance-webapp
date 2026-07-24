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
    /** Office hours and attendance policy (IST HH:mm). Mon–Fri working days. */
    officeStartTime: { type: String, default: '09:00', trim: true },
    officeEndTime: { type: String, default: '17:00', trim: true },
    graceThresholdTime: { type: String, default: '09:00', trim: true },
    halfDayThresholdTime: { type: String, default: '10:00', trim: true },
    warningsPerQuarter: { type: Number, default: 3, min: 0, max: 10 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const OfficeSettings = mongoose.model(
  'OfficeSettings',
  officeSettingsSchema,
);
