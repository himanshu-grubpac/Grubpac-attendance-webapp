import mongoose from 'mongoose';

const leaveTypeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

leaveTypeSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    code: this.code,
    name: this.name,
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeaveType = mongoose.model('LeaveType', leaveTypeSchema);
