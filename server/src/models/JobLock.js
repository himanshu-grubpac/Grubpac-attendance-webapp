import mongoose from 'mongoose';

const jobLockSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  lockId: { type: String, required: true },
  createdAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true },
});

jobLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const JobLock = mongoose.model('JobLock', jobLockSchema);
