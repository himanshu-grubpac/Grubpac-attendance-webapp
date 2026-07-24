import mongoose from 'mongoose';

const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    route: { type: String, required: true },
    statusCode: { type: Number, required: true },
    body: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
