import mongoose from 'mongoose';

const attendanceRecordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['check_in', 'check_out'],
      required: true,
    },
    timestamp: { type: Date, required: true, default: Date.now },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracyMeters: { type: Number, required: true },
    distanceMeters: { type: Number, required: true },
    officeLatitude: { type: Number, required: true },
    officeLongitude: { type: Number, required: true },
    radiusMeters: { type: Number, required: true },
    status: {
      type: String,
      enum: ['allowed', 'rejected'],
      required: true,
    },
    rejectionReasons: [{ type: String }],
    /** Present (P) or half-day (HD) per office policy — set on allowed check-in. */
    attendanceTag: { type: String, enum: ['P', 'HD'], default: null },
    warningIssued: { type: Boolean, default: false },
    /** 1-based warning index within the calendar quarter (W1, W2, …). */
    quarterWarningIndex: { type: Number, min: 1, max: 10, default: null },
  },
  { timestamps: true },
);

attendanceRecordSchema.index({ userId: 1, timestamp: -1 });
attendanceRecordSchema.index({ userId: 1, type: 1, timestamp: -1 });
attendanceRecordSchema.index({ status: 1, timestamp: -1 });

export const AttendanceRecord = mongoose.model(
  'AttendanceRecord',
  attendanceRecordSchema,
);
