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
    /** Who staged the current (or last) cancellation: applicant self-cancel or approver cancel. Cleared when the cancellation is undone or the request is edited. */
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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
    /** True once the manager-facing submit notification has been delivered. */
    submitNotificationsSent: { type: Boolean, default: false },
    /**
     * Provisional → final lifecycle (undoable actions).
     * Every provisional action (submit, edit, approve/reject stage,
     * approved-cancel stage) bumps `revision`. The staged outcome records the
     * revision it was created at in `pendingRevision`, so a stale delayed job
     * or timer can never finalize a newer revision.
     */
    revision: { type: Number, default: 0, min: 0 },
    /** Revision bound when the current pendingDecision was staged. Null when no action is pending. */
    pendingRevision: { type: Number, default: null },
    /**
     * Explicit end of the undo window for the current provisional action
     * (submit deferral or staged decision/cancellation). Exposed to clients
     * as `decisionUndoExpiresAt`. `notifyAfter` is the finalize/notify time
     * (undo expiry + notification delay) and must NOT drive undo countdowns.
     */
    undoExpiresAt: { type: Date, default: null },
    /** When the current outcome was finalized by the background job. Null until finalized. */
    finalizedAt: { type: Date, default: null },
    /**
     * When an admin acts (approve/reject/cancel) but the undo window is still
     * open, the intended final status is stored here. The actual `status` field
     * stays unchanged until the undo window expires and the decision is
     * finalised by the background job.
     */
    pendingDecision: {
      type: String,
      enum: ['approved', 'rejected', 'cancelled'],
      default: null,
    },
  },
  { timestamps: true },
);

leaveRequestSchema.index({ userId: 1, status: 1, startDate: -1 });
leaveRequestSchema.index({ status: 1, createdAt: -1 });
/** Finalizer sweep: staged decisions/cancels due for finalize + notify. */
leaveRequestSchema.index({ pendingDecision: 1, notifyAfter: 1 });
/** Submit-notification sweep: submitted but not yet notified. */
leaveRequestSchema.index({ status: 1, submitNotificationsSent: 1, notifyAfter: 1 });

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
    cancelledBy: this.cancelledBy?.toString?.() ?? null,
    decidedAt: this.decidedAt,
    decisionComment: this.decisionComment,
    adminException: this.adminException,
    pendingDecision: this.pendingDecision ?? null,
    revision: this.revision ?? 0,
    finalizedAt: this.finalizedAt ?? null,
    decisionUndoExpiresAt: this.undoExpiresAt ?? this.notifyAfter ?? null,
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
