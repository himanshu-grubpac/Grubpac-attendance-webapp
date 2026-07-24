import mongoose from 'mongoose';

const leavePolicySchema = new mongoose.Schema(
  {
    leaveTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeaveType',
      required: true,
      unique: true,
    },
    annualQuota: { type: Number, required: true, min: 0 },
    accrualPerMonth: { type: Number, default: 0, min: 0 },
    carryForwardMax: { type: Number, default: 0, min: 0 },
    maxAccumulation: { type: Number, default: 0, min: 0 },
    requireDocAfterConsecutiveDays: { type: Number, default: null, min: 1 },
    paid: { type: Boolean, default: true },
    encashmentMaxPerYear: { type: Number, default: 0, min: 0 },
    combinedCarryGroup: { type: String, default: null, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

leavePolicySchema.methods.toSafeJSON = function toSafeJSON() {
  const typeDoc =
    this.leaveTypeId && typeof this.leaveTypeId === 'object' ? this.leaveTypeId : null;

  return {
    id: this._id.toString(),
    leaveTypeId: typeDoc?._id?.toString() ?? this.leaveTypeId?.toString?.() ?? null,
    leaveTypeCode: typeDoc?.code ?? null,
    leaveTypeName: typeDoc?.name ?? null,
    annualQuota: this.annualQuota,
    accrualPerMonth: this.accrualPerMonth,
    carryForwardMax: this.carryForwardMax,
    maxAccumulation: this.maxAccumulation,
    requireDocAfterConsecutiveDays: this.requireDocAfterConsecutiveDays,
    paid: this.paid,
    encashmentMaxPerYear: this.encashmentMaxPerYear,
    combinedCarryGroup: this.combinedCarryGroup,
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeavePolicy = mongoose.model('LeavePolicy', leavePolicySchema);

export const LEAVE_POLICY_POPULATE = [{ path: 'leaveTypeId', select: 'code name isActive' }];
