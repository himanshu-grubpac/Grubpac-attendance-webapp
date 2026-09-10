import mongoose from 'mongoose';

/**
 * Comp-off (Compensatory Off) work request.
 *
 * Lifecycle: pending → approved → worked → assessed (credit) — or
 * rejected / lapsed (approved but never worked) / cancelled (withdrawn).
 * Like LeaveRequest, every undoable action (submit, approve/reject, assess)
 * is provisional: it records a staged outcome (`pendingAction` /
 * `pendingAssessment`) with an undo deadline (`undoExpiresAt`) and a finalize
 * time (`notifyAfter`). Only the background finalizer may send notifications
 * or mutate the CO balance, and only after the undo window has expired.
 */
const compOffRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    /** Count of eligible (weekend/holiday) days in the requested range. */
    days: { type: Number, required: true, min: 0.5 },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'worked', 'assessed', 'lapsed', 'cancelled'],
      default: 'pending',
    },
    // Staged outcome while undoable: approved / rejected / assessed, plus
    // 'cancelled' for an employee-staged withdrawal (finalizes silently).
    pendingAction: {
      type: String,
      enum: ['approved', 'rejected', 'assessed', 'cancelled'],
      default: null,
    },
    /** Staged assessment rate while undoable (legacy single-rate form). */
    pendingAssessment: {
      type: String,
      enum: ['completed', 'half', 'none'],
      default: null,
    },
    // Staged per-day assessments while undoable: one entry per eligible day
    // in the request range. Canonical form going forward; pendingAssessment
    // is only a fallback for in-flight legacy stages.
    pendingDayAssessments: {
      type: [{ dayKey: { type: String }, assessment: { type: String, enum: ['completed', 'half', 'none'] } }],
      default: undefined,
    },
    /** Finalized per-day assessment record [{ dayKey, assessment, credit }]. */
    assessmentBreakdown: {
      type: [{ dayKey: { type: String }, assessment: { type: String }, credit: { type: Number } }],
      default: undefined,
    },
    /** Granted CO credit after the assessment finalizes (days × rate). */
    creditedDays: { type: Number, default: 0, min: 0 },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Single-use email Take-Action tokens (mirrors LeaveRequest.decisionTokens):
    // issued per manager at submit-finalize, peeked (not consumed) by the
    // auto-login link, invalidated on decide/undo/withdraw.
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
    /** Timestamp when the current outcome was staged. */
    decidedAt: { type: Date, default: null },
    /** Staged remark from the decision/assessment. */
    comment: { type: String, default: null, trim: true, maxlength: 1000 },
    /** Allowed check-out attendance record that flipped this request to worked. */
    checkoutRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceRecord', default: null },
    revision: { type: Number, default: 0, min: 0 },
    pendingRevision: { type: Number, default: null },
    /** End of the undo window for the current provisional action. */
    undoExpiresAt: { type: Date, default: null },
    /** undoExpiresAt + notification delay — when finalization may notify. */
    notifyAfter: { type: Date, default: null },
    /** Decision/assessment notification delivered. */
    notificationsSent: { type: Boolean, default: false },
    /** Manager submit notification delivered. */
    submitNotificationsSent: { type: Boolean, default: false },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

compOffRequestSchema.index({ userId: 1, status: 1, startDate: -1 });
compOffRequestSchema.index({ status: 1, notifyAfter: 1 });
/** Decision/assess finalizer sweep: staged outcome due for finalize + notify. */
compOffRequestSchema.index({ pendingAction: 1, notifyAfter: 1 });
/** Submit-notification sweep: submitted but not yet notified. */
compOffRequestSchema.index({ status: 1, submitNotificationsSent: 1, notifyAfter: 1 });

compOffRequestSchema.methods.toSafeJSON = function toSafeJSON() {
  const userDoc = this.userId && typeof this.userId === 'object' ? this.userId : null;
  const approverDoc =
    this.approverId && typeof this.approverId === 'object' ? this.approverId : null;

  return {
    id: this._id.toString(),
    userId: userDoc?._id?.toString() ?? this.userId?.toString?.() ?? null,
    userName: userDoc?.name ?? null,
    userEmail: userDoc?.email ?? null,
    leaveType: 'CO',
    leaveTypeCode: 'CO',
    leaveTypeName: 'Compensatory Off',
    startDate: this.startDate,
    endDate: this.endDate,
    days: this.days,
    reason: this.reason,
    status: this.status,
    pendingAction: this.pendingAction ?? null,
    pendingAssessment: this.pendingAssessment ?? null,
    pendingDayAssessments: (this.pendingDayAssessments ?? []).map((entry) => ({
      dayKey: entry.dayKey,
      assessment: entry.assessment,
    })),
    assessmentBreakdown: (this.assessmentBreakdown ?? []).map((entry) => ({
      dayKey: entry.dayKey,
      assessment: entry.assessment,
      credit: entry.credit,
    })),
    creditedDays: this.creditedDays ?? 0,
    approverId: approverDoc?._id?.toString() ?? this.approverId?.toString?.() ?? null,
    approverName: approverDoc?.name ?? null,
    decidedAt: this.decidedAt,
    comment: this.comment ?? null,
    checkoutRecordId: this.checkoutRecordId?.toString?.() ?? null,
    revision: this.revision ?? 0,
    finalizedAt: this.finalizedAt ?? null,
    decisionUndoExpiresAt: this.undoExpiresAt ?? this.notifyAfter ?? null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const CompOffRequest = mongoose.model('CompOffRequest', compOffRequestSchema);

export const COMP_OFF_REQUEST_POPULATE = [
  { path: 'userId', select: 'name email departmentId reportingManagerId' },
  { path: 'approverId', select: 'name email' },
];
