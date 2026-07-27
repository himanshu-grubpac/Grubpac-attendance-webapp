import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, trim: true, lowercase: true },
    role: { type: String, trim: true },
    ip: { type: String, trim: true },
    deviceId: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ['success', 'failed'] },
    reason: { type: String, trim: true },
    timestamp: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ deviceId: 1, timestamp: -1 });
auditLogSchema.index({ ip: 1, timestamp: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
