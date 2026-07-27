import mongoose from 'mongoose';

const weekAttendanceConfirmationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** IST Monday of the confirmed week (YYYY-MM-DD). */
    weekStart: { type: String, required: true, trim: true },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    confirmedAt: { type: Date, required: true, default: Date.now },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

weekAttendanceConfirmationSchema.index({ userId: 1, weekStart: 1 }, { unique: true });

weekAttendanceConfirmationSchema.methods.toSafeJSON = function toSafeJSON() {
  const confirmer =
    this.confirmedBy && typeof this.confirmedBy === 'object' ? this.confirmedBy : null;
  return {
    id: this._id.toString(),
    userId: this.userId?.toString?.() ?? String(this.userId),
    weekStart: this.weekStart,
    confirmedBy: confirmer?._id?.toString() ?? this.confirmedBy?.toString?.() ?? null,
    confirmedByName: confirmer?.name ?? null,
    confirmedAt: this.confirmedAt,
    notes: this.notes ?? null,
  };
};

export const WeekAttendanceConfirmation = mongoose.model(
  'WeekAttendanceConfirmation',
  weekAttendanceConfirmationSchema,
);
