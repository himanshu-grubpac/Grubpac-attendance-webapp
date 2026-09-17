import mongoose from 'mongoose';

const leavePolicyHistorySchema = new mongoose.Schema(
  {
    policyId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeavePolicy', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    annualQuota: { type: Number, required: true },
    accrualPerMonth: { type: Number, default: 0 },
    carryForwardMax: { type: Number, default: 0 },
    maxAccumulation: { type: Number, default: 0 },
    requireDocAfterConsecutiveDays: { type: Number, default: null },
    paid: { type: Boolean, default: true },
    encashmentMaxPerYear: { type: Number, default: 0 },
    combinedCarryGroup: { type: String, default: null },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
    changeReason: { type: String, trim: true },
    snapshot: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false },
);

leavePolicyHistorySchema.index({ policyId: 1, changedAt: -1 });
leavePolicyHistorySchema.index({ leaveTypeId: 1, year: 1 });

export const LeavePolicyHistory = mongoose.model('LeavePolicyHistory', leavePolicyHistorySchema);
