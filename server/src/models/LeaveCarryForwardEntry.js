import mongoose from 'mongoose';

const leaveCarryForwardEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    fromYear: { type: Number, required: true, min: 2000, max: 2100 },
    toYear: { type: Number, required: true, min: 2000, max: 2100 },
    remaining: { type: Number, required: true, min: 0 },
    carried: { type: Number, required: true, min: 0 },
    forfeited: { type: Number, required: true, min: 0 },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

leaveCarryForwardEntrySchema.index(
  { userId: 1, leaveTypeId: 1, fromYear: 1 },
  { unique: true },
);

export const LeaveCarryForwardEntry = mongoose.model(
  'LeaveCarryForwardEntry',
  leaveCarryForwardEntrySchema,
);
