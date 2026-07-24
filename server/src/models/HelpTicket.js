import mongoose from 'mongoose';

export const HELP_CATEGORIES = ['Login', 'Attendance', 'Leave', 'Salary', 'Other'];
export const HELP_PRIORITIES = ['low', 'medium', 'high'];
export const HELP_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const helpTicketSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    category: {
      type: String,
      enum: HELP_CATEGORIES,
      required: true,
    },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    priority: {
      type: String,
      enum: HELP_PRIORITIES,
      default: 'medium',
    },
    status: {
      type: String,
      enum: HELP_STATUSES,
      default: 'open',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

helpTicketSchema.index({ createdBy: 1, status: 1, createdAt: -1 });
helpTicketSchema.index({ status: 1, createdAt: -1 });

helpTicketSchema.methods.toSafeJSON = function toSafeJSON() {
  const creatorDoc =
    this.createdBy && typeof this.createdBy === 'object' ? this.createdBy : null;
  const assigneeDoc =
    this.assignedTo && typeof this.assignedTo === 'object' ? this.assignedTo : null;

  return {
    id: this._id.toString(),
    title: this.title,
    category: this.category,
    description: this.description,
    priority: this.priority,
    status: this.status,
    createdBy: creatorDoc?._id?.toString() ?? this.createdBy?.toString?.() ?? null,
    createdByName: creatorDoc?.name ?? null,
    createdByEmail: creatorDoc?.email ?? null,
    assignedTo: assigneeDoc?._id?.toString() ?? this.assignedTo?.toString?.() ?? null,
    assignedToName: assigneeDoc?.name ?? null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const HelpTicket = mongoose.model('HelpTicket', helpTicketSchema);

export const HELP_TICKET_POPULATE = [
  { path: 'createdBy', select: 'name email reportingManagerId' },
  { path: 'assignedTo', select: 'name email' },
];
