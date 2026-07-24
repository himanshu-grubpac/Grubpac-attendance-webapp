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
