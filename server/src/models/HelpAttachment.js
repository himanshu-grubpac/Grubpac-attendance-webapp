import mongoose from 'mongoose';

export const HELP_ATTACHMENT_STATUSES = ['pending', 'confirmed', 'deleted'];

const helpAttachmentSchema = new mongoose.Schema(
  {
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpTicket', required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true, trim: true, maxlength: 127 },
    sizeBytes: { type: Number, required: true, min: 1 },
    s3Key: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: HELP_ATTACHMENT_STATUSES,
      default: 'pending',
    },
  },
  { timestamps: true },
);

helpAttachmentSchema.index({ ticketId: 1, createdAt: 1 });

helpAttachmentSchema.methods.toSafeJSON = function toSafeJSON() {
  const uploaderDoc =
    this.uploadedBy && typeof this.uploadedBy === 'object' ? this.uploadedBy : null;

  return {
    id: this._id.toString(),
    ticketId: this.ticketId?.toString?.() ?? null,
    uploadedBy: uploaderDoc?._id?.toString() ?? this.uploadedBy?.toString?.() ?? null,
    uploadedByName: uploaderDoc?.name ?? null,
    fileName: this.fileName,
    mimeType: this.mimeType,
    sizeBytes: this.sizeBytes,
    status: this.status,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const HelpAttachment = mongoose.model('HelpAttachment', helpAttachmentSchema);

export const HELP_ATTACHMENT_POPULATE = [{ path: 'uploadedBy', select: 'name email' }];
