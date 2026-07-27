import mongoose from 'mongoose';

const holidayCategorySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    name: { type: String, required: true, trim: true, maxlength: 50 },
    color: { type: String, required: true, trim: true, match: /^#[0-9a-fA-F]{6}$/ },
  },
  { timestamps: true },
);

holidayCategorySchema.methods.toSafeJSON = function toSafeJSON() {
  return { id: this._id.toString(), slug: this.slug, name: this.name, color: this.color };
};

export const HolidayCategory = mongoose.model('HolidayCategory', holidayCategorySchema);
