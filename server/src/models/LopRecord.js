import mongoose from 'mongoose';

const LOP_STATUSES = ['pending', 'settled'];

const lopRecordSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    leaveRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest', required: true },
    leaveDate: { type: Date, required: true },
    periodKey: { type: String, required: true, trim: true },
    days: { type: Number, required: true, min: 0 },
    deductionAmount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: LOP_STATUSES,
      default: 'pending',
    },
    settledAt: { type: Date, default: null },
    year: { type: Number, required: true, min: 2000, max: 2100 },
  },
  { timestamps: true },
);

lopRecordSchema.index(
  { userId: 1, leaveTypeId: 1, periodKey: 1, leaveRequestId: 1 },
  { unique: true },
);
lopRecordSchema.index({ periodKey: 1, status: 1 });
lopRecordSchema.index({ userId: 1, periodKey: 1 });
lopRecordSchema.index({ leaveRequestId: 1 });

lopRecordSchema.methods.toJSON = function toJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId?.toString?.() ?? this.userId,
    leaveTypeId: this.leaveTypeId?.toString?.() ?? this.leaveTypeId,
    leaveRequestId: this.leaveRequestId?.toString?.() ?? this.leaveRequestId,
    leaveDate: this.leaveDate,
    periodKey: this.periodKey,
    days: this.days,
    deductionAmount: this.deductionAmount,
    status: this.status,
    settledAt: this.settledAt,
    year: this.year,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LopRecord = mongoose.model('LopRecord', lopRecordSchema);
