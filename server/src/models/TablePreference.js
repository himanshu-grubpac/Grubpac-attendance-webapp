import mongoose from 'mongoose';

const columnSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    order: { type: Number, required: true },
    width: { type: Number, default: null, min: 0 },
    pinned: { type: String, enum: ['left', 'right', null], default: null },
  },
  { _id: false },
);

const sortSchema = new mongoose.Schema(
  {
    key: { type: String, default: null },
    direction: { type: String, enum: ['asc', 'desc', null], default: null },
  },
  { _id: false },
);

const tablePreferenceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tableKey: {
      type: String,
      required: true,
      trim: true,
    },
    columns: { type: [columnSchema], default: [] },
    pageSize: { type: Number, default: 20, min: 1, max: 200 },
    sort: { type: sortSchema, default: () => ({}) },
    filters: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

tablePreferenceSchema.index({ userId: 1, tableKey: 1 }, { unique: true });

tablePreferenceSchema.methods.toJSON = function toJSON() {
  return {
    id: this._id.toString(),
    userId: this.userId.toString(),
    tableKey: this.tableKey,
    columns: this.columns,
    pageSize: this.pageSize,
    sort: this.sort,
    filters: this.filters,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const TablePreference = mongoose.model('TablePreference', tablePreferenceSchema);
