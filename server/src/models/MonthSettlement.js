import mongoose from 'mongoose';

const monthSettlementSchema = new mongoose.Schema(
  {
    periodKey: { type: String, required: true, trim: true, unique: true },
    settledAt: { type: Date, required: true },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    employeesProcessed: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

monthSettlementSchema.methods.toJSON = function toJSON() {
  return {
    id: this._id.toString(),
    periodKey: this.periodKey,
    settledAt: this.settledAt,
    settledBy: this.settledBy?.toString?.() ?? this.settledBy,
    employeesProcessed: this.employeesProcessed,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const MonthSettlement = mongoose.model('MonthSettlement', monthSettlementSchema);
