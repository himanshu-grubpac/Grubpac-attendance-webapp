import mongoose from 'mongoose';
import { getISTDateInputValue } from '../utils/istDate.js';

const holidaySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 500 },
    type: { type: String, default: 'public', trim: true, maxlength: 50 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

holidaySchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    date: this.date,
    dateInput: getISTDateInputValue(this.date),
    name: this.name,
    description: this.description,
    type: this.type || 'public',
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Holiday = mongoose.model('Holiday', holidaySchema);
