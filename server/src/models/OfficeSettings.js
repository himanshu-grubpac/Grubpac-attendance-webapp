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
    /** IST weekday numbers treated as non-working (0=Sun … 6=Sat). Default Sat+Sun. */
    weekendDays: { type: [Number], default: [0, 6] },
    /** Recurring holiday rules materialized per calendar year. */
    recurringHolidayRules: [{
      nth: { type: Number, required: true },
      weekday: { type: Number, required: true, min: 0, max: 6 },
      months: { type: mongoose.Schema.Types.Mixed, default: 'all' },
      type: { type: String, default: 'public', trim: true },
      name: { type: String, required: true, trim: true, maxlength: 200 },
    }],
    /**
     * Auto-checkout (auto logout): when enabled, employees still checked in past the
     * configured IST time are checked out automatically by the background job.
     * - officeTime: same-day IST HH:mm (default 23:59).
     * - wfhTime: next-day IST HH:mm (default 06:00).
     */
    autoCheckout: {
      enabled: { type: Boolean, default: true },
      officeTime: { type: String, default: '23:59', trim: true },
      wfhTime: { type: String, default: '06:00', trim: true },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const OfficeSettings = mongoose.model(
  'OfficeSettings',
  officeSettingsSchema,
);
