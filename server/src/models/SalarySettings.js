import mongoose from 'mongoose';

const salarySettingsSchema = new mongoose.Schema(
  {
    /** Day of month (1–28) when payroll is scheduled. Null = not configured. */
    payrollDayOfMonth: { type: Number, default: null, min: 1, max: 28 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const SalarySettings = mongoose.model('SalarySettings', salarySettingsSchema);
