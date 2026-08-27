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
    /** Employee-selected work location for this attendance day. */
    attendanceMode: {
      type: String,
      enum: ['office', 'wfh'],
      required: true,
      default: 'office',
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
    /** Present (P), half-day (HD), or leave-violation (LV) when warnings exhausted — set on allowed check-in. */
    attendanceTag: { type: String, enum: ['P', 'HD', 'LV'], default: null },
    /** Optional note when check-in is after the grace threshold. */
    lateNote: { type: String, default: null, trim: true, maxlength: 500 },
    warningIssued: { type: Boolean, default: false },
    /** 1-based warning index within the calendar quarter (W1, W2, …). */
    quarterWarningIndex: { type: Number, min: 1, max: 10, default: null },
    /** True when the check-out was created by the auto-checkout background job. */
    autoCheckout: { type: Boolean, default: false },
    /** Set when an admin or team lead edits this check-in record. */
    lastEditedAt: { type: Date, default: null },
    lastEditedBy: {
      id: { type: String, default: null },
      name: { type: String, default: null, trim: true },
    },
    editHistory: [
      {
        editedAt: { type: Date, required: true },
        editedBy: {
          id: { type: String, required: true },
          name: { type: String, required: true, trim: true },
        },
        changes: [
          {
            field: { type: String, required: true },
            from: { type: mongoose.Schema.Types.Mixed, default: null },
            to: { type: mongoose.Schema.Types.Mixed, default: null },
          },
        ],
      },
    ],
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