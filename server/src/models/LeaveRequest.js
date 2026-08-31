import mongoose from 'mongoose';

const leaveRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true, min: 0.5 },
    /** Half-day leave: null = full day(s), 'am' | 'pm' for single-day 0.5 day requests. */
    halfDay: { type: String, enum: ['am', 'pm'], default: null },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
    },
    documentUrl: { type: String, default: null, trim: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionComment: { type: String, default: null, trim: true, maxlength: 1000 },
    adminException: { type: Boolean, default: false },
    decisionTokens: [
      {
        tokenHash: { type: String, required: true },
        action: { type: String, enum: ['approve', 'reject', 'decide'], required: true },
        managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        expiresAt: { type: Date, required: true },
        used: { type: Boolean, default: false },
        usedAt: { type: Date, default: null },
      },
    ],
    notifyAfter: { type: Date, default: null },
    notificationsSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

leaveRequestSchema.index({ userId: 1, status: 1, startDate: -1 });
leaveRequestSchema.index({ status: 1, createdAt: -1 });

leaveRequestSchema.methods.toSafeJSON = function toSafeJSON() {
  const typeDoc =
    this.leaveTypeId && typeof this.leaveTypeId === 'object' ? this.leaveTypeId : null;
  const userDoc = this.userId && typeof this.userId === 'object' ? this.userId : null;
  const approverDoc =
    this.approverId && typeof this.approverId === 'object' ? this.approverId : null;

  return {
    id: this._id.toString(),
    userId: userDoc?._id?.toString() ?? this.userId?.toString?.() ?? null,
    userName: userDoc?.name ?? null,
    userEmail: userDoc?.email ?? null,
    leaveTypeId: typeDoc?._id?.toString() ?? this.leaveTypeId?.toString?.() ?? null,
    leaveTypeCode: typeDoc?.code ?? null,
    leaveTypeName: typeDoc?.name ?? null,
    startDate: this.startDate,
    endDate: this.endDate,
    days: this.days,
    halfDay: this.halfDay ?? null,
    reason: this.reason,
    status: this.status,
    documentUrl: this.documentUrl,
    approverId: approverDoc?._id?.toString() ?? this.approverId?.toString?.() ?? null,
    approverName: approverDoc?.name ?? null,
    decidedAt: this.decidedAt,
    decisionComment: this.decisionComment,
    adminException: this.adminException,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);

export const LEAVE_REQUEST_POPULATE = [
  { path: 'leaveTypeId', select: 'code name isActive' },
  { path: 'userId', select: 'name email departmentId reportingManagerId' },
  { path: 'approverId', select: 'name email' },
];
