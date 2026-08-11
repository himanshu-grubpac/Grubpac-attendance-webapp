import mongoose from 'mongoose';

const leaveBalanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    entitled: { type: Number, default: 0, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    pending: { type: Number, default: 0, min: 0 },
    carried: { type: Number, default: 0, min: 0 },
    encashed: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

leaveBalanceSchema.index({ userId: 1, leaveTypeId: 1, year: 1 }, { unique: true });
leaveBalanceSchema.index({ userId: 1, year: 1 });

leaveBalanceSchema.methods.toSafeJSON = function toSafeJSON() {
  const typeDoc =
    this.leaveTypeId && typeof this.leaveTypeId === 'object' ? this.leaveTypeId : null;

  // Remaining may be negative when overdrawn leave is allowed.
  const available =
    (this.entitled ?? 0) +
    (this.carried ?? 0) -
    (this.used ?? 0) -
    (this.pending ?? 0) -
    (this.encashed ?? 0);

  return {
    id: this._id.toString(),
    userId: this.userId?.toString?.() ?? this.userId,
    leaveTypeId: typeDoc?._id?.toString() ?? this.leaveTypeId?.toString?.() ?? null,
    leaveTypeCode: typeDoc?.code ?? null,
    leaveTypeName: typeDoc?.name ?? null,
    year: this.year,
    entitled: this.entitled,
    used: this.used,
    pending: this.pending,
    carried: this.carried,
    encashed: this.encashed,
    available,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeaveBalance = mongoose.model('LeaveBalance', leaveBalanceSchema);

export const LEAVE_BALANCE_POPULATE = [{ path: 'leaveTypeId', select: 'code name isActive' }];
