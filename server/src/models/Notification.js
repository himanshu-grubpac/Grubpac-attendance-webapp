import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    link: { type: String, trim: true, default: null },
    readAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

notificationSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId?.toString?.() ?? null,
    type: this.type,
    title: this.title,
    body: this.body,
    link: this.link ?? null,
    readAt: this.readAt ?? null,
    metadata: this.metadata ?? {},
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Notification = mongoose.model('Notification', notificationSchema);
