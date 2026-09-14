import mongoose from 'mongoose';

const leaveBalanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    entitled: { type: Number, default: 0, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    pending: { type: Number, default: 0, min: 0 },
    // Negative carried stock is allowed as a deduction (reduces available balance).
    carried: { type: Number, default: 0, min: -365 },
    encashed: { type: Number, default: 0, min: 0 },
    /**
     * Comp-off credit earned from worked weekend/holiday requests. Additive by
     * design: NEVER overwritten by accrual refresh (`refreshAccruedEntitlements`
     * only writes `entitled`) or carry-forward logic, so assessed credit
     * survives every balance job. CO policy accrual is 0, but keeping the
     * earned stock in its own field stays robust against future policy edits.
     */
    compOffEarned: { type: Number, default: 0, min: 0 },
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
    (this.carried ?? 0) +
    (this.compOffEarned ?? 0) -
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
    compOffEarned: this.compOffEarned ?? 0,
    available,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeaveBalance = mongoose.model('LeaveBalance', leaveBalanceSchema);

export const LEAVE_BALANCE_POPULATE = [{ path: 'leaveTypeId', select: 'code name isActive' }];
