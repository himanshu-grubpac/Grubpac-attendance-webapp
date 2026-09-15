import mongoose from 'mongoose';

const leavePolicySchema = new mongoose.Schema(
  {
    leaveTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
    },
    year: { type: Number, required: true, min: 2000, max: 2100 },
    annualQuota: { type: Number, required: true, min: 0 },
    accrualPerMonth: { type: Number, default: 0, min: 0 },
    carryForwardMax: { type: Number, default: 0, min: 0 },
    maxAccumulation: { type: Number, default: 0, min: 0 },
    requireDocAfterConsecutiveDays: { type: Number, default: null, min: 1 },
    paid: { type: Boolean, default: true },
    encashmentMaxPerYear: { type: Number, default: 0, min: 0 },
    combinedCarryGroup: { type: String, default: null, trim: true },
    isActive: { type: Boolean, default: true },
    // Revision history: snapshot of the previous values before every update,
    // plus the creation baseline. Effective date = when the change was saved.
    history: {
      type: [
        {
          annualQuota: { type: Number },
          accrualPerMonth: { type: Number },
          carryForwardMax: { type: Number },
          maxAccumulation: { type: Number },
          requireDocAfterConsecutiveDays: { type: Number, default: null },
          paid: { type: Boolean },
          encashmentMaxPerYear: { type: Number },
          combinedCarryGroup: { type: String, default: null },
          isActive: { type: Boolean },
          changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          effectiveDate: { type: Date, default: Date.now },
          action: { type: String, default: 'updated', trim: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

leavePolicySchema.index({ leaveTypeId: 1, year: 1 }, { unique: true });
leavePolicySchema.index({ year: 1, isActive: 1 });

leavePolicySchema.methods.toSafeJSON = function toSafeJSON() {
  const typeDoc =
    this.leaveTypeId && typeof this.leaveTypeId === 'object' ? this.leaveTypeId : null;

  return {
    id: this._id.toString(),
    leaveTypeId: typeDoc?._id?.toString() ?? this.leaveTypeId?.toString?.() ?? null,
    leaveTypeCode: typeDoc?.code ?? null,
    leaveTypeName: typeDoc?.name ?? null,
    year: this.year,
    annualQuota: this.annualQuota,
    accrualPerMonth: this.accrualPerMonth,
    carryForwardMax: this.carryForwardMax,
    maxAccumulation: this.maxAccumulation,
    requireDocAfterConsecutiveDays: this.requireDocAfterConsecutiveDays,
    paid: this.paid,
    encashmentMaxPerYear: this.encashmentMaxPerYear,
    combinedCarryGroup: this.combinedCarryGroup,
    isActive: this.isActive,
    history: (this.history ?? []).map((entry) => ({
      annualQuota: entry.annualQuota,
      accrualPerMonth: entry.accrualPerMonth,
      carryForwardMax: entry.carryForwardMax,
      maxAccumulation: entry.maxAccumulation,
      requireDocAfterConsecutiveDays: entry.requireDocAfterConsecutiveDays ?? null,
      paid: entry.paid,
      encashmentMaxPerYear: entry.encashmentMaxPerYear,
      combinedCarryGroup: entry.combinedCarryGroup ?? null,
      isActive: entry.isActive,
      changedBy: entry.changedBy?.toString?.() ?? entry.changedBy ?? null,
      effectiveDate: entry.effectiveDate,
      action: entry.action,
    })),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeavePolicy = mongoose.model('LeavePolicy', leavePolicySchema);

export const LEAVE_POLICY_POPULATE = [{ path: 'leaveTypeId', select: 'code name isActive' }];
