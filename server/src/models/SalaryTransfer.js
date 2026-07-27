import mongoose from 'mongoose';

const SALARY_TRANSFER_STATUSES = ['pending', 'paid', 'failed'];

const salaryTransferSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    periodKey: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true },
    status: {
      type: String,
      enum: SALARY_TRANSFER_STATUSES,
      default: 'pending',
    },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    failureReason: { type: String, default: null, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);

salaryTransferSchema.index({ userId: 1, periodKey: 1 }, { unique: true });
salaryTransferSchema.index({ periodKey: 1, status: 1 });

export const SALARY_TRANSFER_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
});

export const SalaryTransfer = mongoose.model('SalaryTransfer', salaryTransferSchema);
