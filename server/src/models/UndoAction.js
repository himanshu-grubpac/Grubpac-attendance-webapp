import mongoose from 'mongoose';

/**
 * Represents a single-use, short-lived token that lets an employee undo their
 * most recent attendance action (check-in / check-out). Only the latest action
 * is undoable ("one chance at a time"): each new check-in/check-out expires any
 * previously active token and mints a fresh one.
 */
const undoActionSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    targetType: { type: String, enum: ['attendance'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: {
      type: String,
      enum: ['active', 'undone', 'expired'],
      default: 'active',
      index: true,
    },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const UndoAction = mongoose.model('UndoAction', undoActionSchema);
