import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS } from '../permissions.js';
import { indianMobileSchema, objectIdSchema, passwordSchema } from './common.js';
import { EMPLOYEE_CODE_FORMAT_HINT, EMPLOYEE_CODE_REGEX } from './employeeCodeFormat.js';

export { EMPLOYEE_CODE_FORMAT_HINT, EMPLOYEE_CODE_REGEX } from './employeeCodeFormat.js';

const employeeCodeInputSchema = z
  .string()
  .trim()
  .transform((value) => (value ? value.toUpperCase() : ''))
  .pipe(
    z.union([
      z.literal(''),
      z
        .string()
        .regex(
          EMPLOYEE_CODE_REGEX,
          'Employee code must be 2–5 letters followed by 3–6 digits (e.g. EMP001, TL001).',
        ),
    ]),
  );

export const dateInputSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.');

function requiredObjectIdField(label) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .pipe(objectIdSchema);
}

function optionalObjectIdField() {
  return z
    .union([z.literal(''), objectIdSchema])
    .optional()
    .transform((value) => (value === '' || value === undefined ? undefined : value));
}

function nullableObjectIdField() {
  return z
    .union([z.literal(''), objectIdSchema, z.null()])
    .optional()
    .transform((value) => {
      if (value === '' || value === undefined) return undefined;
      return value;
    });
}

const designationSchema = z
  .string()
  .trim()
  .min(1, 'Designation is required.')
  .max(100, 'Designation must be at most 100 characters.');

const optionalLastNameSchema = z
  .string()
  .trim()
  .max(50, 'Last name must be at most 50 characters.')
  .optional()
  .default('');

const optionalLastNameFieldSchema = z
  .string()
  .trim()
  .max(50, 'Last name must be at most 50 characters.')
  .optional();

const endingDateInputSchema = z
  .union([dateInputSchema, z.literal(''), z.null()])
  .optional()
  .transform((value) => (value ? value : undefined));

const managedDepartmentIdsSchema = z.array(objectIdSchema).optional().default([]);

/** Ending date must be on or after joining date when both are set. */
export function applyEmployeeDateRangeRules(data, ctx) {
  if (data.endingDate && data.joiningDate && data.endingDate < data.joiningDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endingDate'],
      message: 'Ending date must be on or after joining date.',
    });
  }
}

/** Shared org/profile conditional rules (role slug + department availability). */
export function applyEmployeeOrgContextRules(data, context, ctx) {
  const roleSlug = context.roleSlug ?? null;
  const hasDepartments = Boolean(context.hasDepartments);

  if (hasDepartments && !data.departmentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['departmentId'],
      message: 'Department is required.',
    });
  }

  if (roleSlug === SYSTEM_ROLE_SLUGS.EMPLOYEE && !data.reportingManagerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reportingManagerId'],
      message: 'Reporting manager is required for employees.',
    });
  }

  if (roleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER) {
    const managed = data.managedDepartmentIds ?? [];
    if (managed.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['managedDepartmentIds'],
        message: 'Select at least one managed department for reporting managers.',
      });
    }
  }
}

export const employeeInputSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(2, 'First name must be at least 2 characters.')
    .max(50, 'First name must be at most 50 characters.'),
  lastName: optionalLastNameSchema,
  email: z.string().trim().email('Valid email is required.').max(254),
  mobile: indianMobileSchema,
  password: passwordSchema,
  employeeCode: employeeCodeInputSchema.optional().or(z.literal('')),
  designation: designationSchema,
  joiningDate: dateInputSchema,
  endingDate: endingDateInputSchema,
  department: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .or(z.literal('')),
  roleId: requiredObjectIdField('Role'),
  departmentId: optionalObjectIdField(),
  reportingManagerId: optionalObjectIdField(),
  managedDepartmentIds: managedDepartmentIdsSchema,
});

const bulkEmployeeInputSchema = employeeInputSchema.extend({
  roleId: optionalObjectIdField(),
});

export function buildEmployeeInputSchema(context = {}) {
  const schema = context.bulkImport ? bulkEmployeeInputSchema : employeeInputSchema;
  return schema.superRefine((data, ctx) => {
    applyEmployeeDateRangeRules(data, ctx);
    applyEmployeeOrgContextRules(data, context, ctx);
  });
}

const PROFILE_ORG_FIELD_KEYS = [
  'firstName',
  'lastName',
  'email',
  'mobile',
  'designation',
  'joiningDate',
  'endingDate',
  'roleId',
  'departmentId',
  'reportingManagerId',
  'delegateApproverId',
  'managedDepartmentIds',
];

export function isProfileOrgUpdate(body) {
  return PROFILE_ORG_FIELD_KEYS.some((key) => body?.[key] !== undefined);
}

/** Full employment/profile update — all core fields required (edit form + server profile PATCH). */
export const employeeProfileUpdateSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(2, 'First name must be at least 2 characters.')
    .max(50, 'First name must be at most 50 characters.'),
  lastName: optionalLastNameSchema,
  email: z.string().trim().email('Valid email is required.').max(254),
  mobile: indianMobileSchema,
  designation: designationSchema,
  joiningDate: dateInputSchema,
  endingDate: z
    .union([dateInputSchema, z.literal(''), z.null()])
    .optional()
    .transform((value) => (value === '' || value === null || value === undefined ? null : value)),
  roleId: requiredObjectIdField('Role'),
  departmentId: optionalObjectIdField(),
  reportingManagerId: nullableObjectIdField(),
  delegateApproverId: nullableObjectIdField(),
  managedDepartmentIds: managedDepartmentIdsSchema,
});

export function buildEmployeeProfileUpdateSchema(context = {}) {
  return employeeProfileUpdateSchema.superRefine((data, ctx) => {
    applyEmployeeDateRangeRules(data, ctx);
    applyEmployeeOrgContextRules(data, context, ctx);
  });
}

/** Partial PATCH — status-only updates stay allowed; profile updates validated separately. */
export const updateEmployeeOrgSchema = z
  .object({
    roleId: objectIdSchema.optional(),
    departmentId: objectIdSchema.nullable().optional(),
    reportingManagerId: objectIdSchema.nullable().optional(),
    delegateApproverId: objectIdSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    firstName: z
      .string()
      .trim()
      .min(2, 'First name must be at least 2 characters.')
      .max(50, 'First name must be at most 50 characters.')
      .optional(),
    lastName: optionalLastNameFieldSchema,
    email: z.string().trim().email('Valid email is required.').max(254).optional(),
    mobile: indianMobileSchema.optional(),
    designation: designationSchema.optional(),
    joiningDate: dateInputSchema.optional(),
    endingDate: dateInputSchema.nullable().optional(),
    managedDepartmentIds: z.array(objectIdSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  })
  .refine(
    (value) => {
      if (!value.endingDate || value.endingDate === null) return true;
      if (!value.joiningDate) return true;
      return value.endingDate >= value.joiningDate;
    },
    {
      message: 'Ending date must be on or after joining date.',
      path: ['endingDate'],
    },
  );
