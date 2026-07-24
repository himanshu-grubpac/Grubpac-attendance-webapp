import mongoose from 'mongoose';

const helpCommentSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpTicket', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: true },
);

helpCommentSchema.index({ ticketId: 1, createdAt: 1 });

helpCommentSchema.methods.toSafeJSON = function toSafeJSON() {
  const userDoc = this.userId && typeof this.userId === 'object' ? this.userId : null;

  return {
    id: this._id.toString(),
    ticketId: this.ticketId?.toString?.() ?? null,
    userId: userDoc?._id?.toString() ?? this.userId?.toString?.() ?? null,
    userName: userDoc?.name ?? null,
    body: this.body,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const HelpComment = mongoose.model('HelpComment', helpCommentSchema);

export const HELP_COMMENT_POPULATE = [{ path: 'userId', select: 'name email' }];
