import mongoose from 'mongoose';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    isActive: { type: Boolean, default: true },
    leadUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deputyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

departmentSchema.methods.toSafeJSON = function toSafeJSON() {
  const leadDoc = this.leadUserId && typeof this.leadUserId === 'object' ? this.leadUserId : null;
  const deputyDoc =
    this.deputyUserId && typeof this.deputyUserId === 'object' ? this.deputyUserId : null;

  return {
    id: this._id.toString(),
    name: this.name,
    code: this.code,
    isActive: this.isActive,
    leadUserId: leadDoc?._id?.toString() ?? this.leadUserId?.toString?.() ?? null,
    leadUserName: leadDoc?.name ?? null,
    deputyUserId: deputyDoc?._id?.toString() ?? this.deputyUserId?.toString?.() ?? null,
    deputyUserName: deputyDoc?.name ?? null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Department = mongoose.model('Department', departmentSchema);
