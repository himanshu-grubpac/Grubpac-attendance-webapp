import mongoose from 'mongoose';
import { normalizePermissions } from '../../../shared/permissions.js';

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, default: '' },
    isSystem: { type: Boolean, default: false },
    permissions: {
      type: [String],
      default: [],
      set: (value) => normalizePermissions(value),
    },
    /** Bumped on every permission save — clients poll to refresh stale nav/buttons. */
    permissionsVersion: { type: Number, default: 1, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

roleSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    slug: this.slug,
    description: this.description ?? '',
    isSystem: this.isSystem,
    permissions: this.permissions ?? [],
    permissionsVersion: this.permissionsVersion ?? 1,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Role = mongoose.model('Role', roleSchema);
