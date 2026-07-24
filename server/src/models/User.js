import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['admin', 'employee'],
      required: true,
    },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
    reportingManagerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    /** Optional delegate who may approve leave for this user's direct reports while set on the manager. */
    delegateApproverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    /** Full display name — derived from firstName + lastName on save. Kept for backward compat with UI reading user.name. */
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    mobile: { type: String, required: true, unique: true, trim: true },
    employeeCode: { type: String, trim: true, sparse: true, unique: true },
    /** @deprecated Use departmentId — kept for migration and bulk import compat. */
    department: { type: String, trim: true },
    /** Job title — separate from RBAC roleId. */
    designation: { type: String, trim: true, default: null },
    joiningDate: { type: Date, default: null },
    /** Null while employed; set when the employee separates. */
    endingDate: { type: Date, default: null },
    passwordHash: { type: String, required: true },
    /** Monthly gross salary in INR — admin/HR only. */
    monthlySalary: { type: Number, default: null, min: 0 },
    salaryEffectiveFrom: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    /** Incremented to invalidate outstanding JWT sessions (logout / password change). */
    tokenVersion: { type: Number, default: 0, min: 0 },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Keep the display `name` in sync with firstName/lastName so existing UI/reports
// that read user.name continue to work without touching every call site.
userSchema.pre('validate', function deriveDisplayName() {
  if (this.firstName || this.lastName) {
    const derived = [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
    if (derived) {
      this.name = derived;
    }
  }
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const roleDoc = this.roleId && typeof this.roleId === 'object' ? this.roleId : null;
  const departmentDoc =
    this.departmentId && typeof this.departmentId === 'object' ? this.departmentId : null;
  const managerDoc =
    this.reportingManagerId && typeof this.reportingManagerId === 'object'
      ? this.reportingManagerId
      : null;
  const delegateDoc =
    this.delegateApproverId && typeof this.delegateApproverId === 'object'
      ? this.delegateApproverId
      : null;

  const permissions = roleDoc?.permissions ?? [];

  return {
    id: this._id.toString(),
    role: this.role,
    roleId: roleDoc?._id?.toString() ?? this.roleId?.toString?.() ?? null,
    roleName: roleDoc?.name ?? null,
    roleSlug: roleDoc?.slug ?? null,
    permissions,
    firstName: this.firstName,
    lastName: this.lastName,
    name: this.name,
    email: this.email,
    mobile: this.mobile,
    employeeCode: this.employeeCode ?? null,
    designation: this.designation ?? null,
    joiningDate: this.joiningDate ?? null,
    endingDate: this.endingDate ?? null,
    department: departmentDoc?.name ?? this.department ?? null,
    departmentId: departmentDoc?._id?.toString() ?? this.departmentId?.toString?.() ?? null,
    departmentName: departmentDoc?.name ?? null,
    reportingManagerId:
      managerDoc?._id?.toString() ?? this.reportingManagerId?.toString?.() ?? null,
    reportingManagerName: managerDoc?.name ?? null,
    delegateApproverId:
      delegateDoc?._id?.toString() ?? this.delegateApproverId?.toString?.() ?? null,
    delegateApproverName: delegateDoc?.name ?? null,
    monthlySalary: this.monthlySalary ?? null,
    salaryEffectiveFrom: this.salaryEffectiveFrom ?? null,
    salaryCurrency: 'INR',
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const User = mongoose.model('User', userSchema);

export const USER_POPULATE_FIELDS = [
  { path: 'roleId', select: 'name slug permissions isSystem' },
  { path: 'departmentId', select: 'name code isActive' },
  { path: 'reportingManagerId', select: 'name email delegateApproverId' },
  { path: 'delegateApproverId', select: 'name email' },
];
