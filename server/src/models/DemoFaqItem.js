import mongoose from 'mongoose';

const demoFaqItemSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    /** Whether content is a URL or plain text body. */
    contentKind: {
      type: String,
      enum: ['url', 'text'],
      default: 'text',
    },
    /** Array of role slugs (admin, hr, reporting-manager, employee) that can see this item. */
    visibleRoles: {
      type: [String],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0,
        message: 'At least one visible role is required.',
      },
    },
    sortOrder: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

demoFaqItemSchema.index({ isActive: 1, sortOrder: 1 });

demoFaqItemSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    title: this.title,
    content: this.content,
    contentKind: this.contentKind ?? 'text',
    visibleRoles: this.visibleRoles ?? [],
    sortOrder: this.sortOrder ?? 0,
    isActive: this.isActive,
    createdBy: this.createdBy?.toString?.() ?? null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const DemoFaqItem = mongoose.model('DemoFaqItem', demoFaqItemSchema);
