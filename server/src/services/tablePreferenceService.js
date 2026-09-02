import { TablePreference } from '../models/TablePreference.js';
import { PERMISSIONS, hasAnyPermission } from '../../../shared/permissions.js';

const DEFAULT_COLUMNS = {
  employeeList: [
    { key: 'name', order: 0, width: 200, pinned: null },
    { key: 'email', order: 1, width: 200, pinned: null },
    { key: 'department', order: 2, width: 150, pinned: null },
    { key: 'designation', order: 3, width: 150, pinned: null },
    { key: 'employeeCode', order: 4, width: 140, pinned: null },
    { key: 'joiningDate', order: 5, width: 130, pinned: null },
    { key: 'isActive', order: 6, width: 100, pinned: null },
  ],
  attendanceToday: [
    { key: 'name', order: 0, width: 200, pinned: null },
    { key: 'employeeCode', order: 1, width: 140, pinned: null },
    { key: 'department', order: 2, width: 150, pinned: null },
    { key: 'status', order: 3, width: 120, pinned: null },
    { key: 'checkIn', order: 4, width: 120, pinned: null },
    { key: 'checkOut', order: 5, width: 120, pinned: null },
  ],
  attendanceHistory: [
    { key: 'date', order: 0, width: 120, pinned: null },
    { key: 'status', order: 1, width: 100, pinned: null },
    { key: 'checkIn', order: 2, width: 120, pinned: null },
    { key: 'checkOut', order: 3, width: 120, pinned: null },
    { key: 'workingHours', order: 4, width: 120, pinned: null },
  ],
  leaveList: [
    { key: 'type', order: 0, width: 120, pinned: null },
    { key: 'startDate', order: 1, width: 120, pinned: null },
    { key: 'endDate', order: 2, width: 120, pinned: null },
    { key: 'status', order: 3, width: 120, pinned: null },
    { key: 'reason', order: 4, width: 200, pinned: null },
  ],
};

/**
 * Per-table column → required permission mapping.
 * If a column key is NOT listed here, it is accessible to all authenticated users.
 * If a column key IS listed, the user must have at least one of the listed permissions.
 */
const COLUMN_PERMISSIONS = {
  employeeList: {
    employeeCode: [PERMISSIONS.USERS_READ],
    email: [PERMISSIONS.USERS_READ],
    designation: [PERMISSIONS.USERS_READ],
    joiningDate: [PERMISSIONS.USERS_READ],
    isActive: [PERMISSIONS.USERS_READ],
  },
  attendanceToday: {
    employeeCode: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
  },
  attendanceHistory: {},
  leaveList: {},
};

function getDefaultPreference(tableKey) {
  return {
    columns: DEFAULT_COLUMNS[tableKey] ?? [],
    pageSize: 20,
    sort: { key: null, direction: null },
    filters: null,
  };
}

/**
 * Returns the list of column keys the user is allowed to access for a given table.
 * Columns not listed in COLUMN_PERMISSIONS are accessible to everyone.
 */
export function getAllowedColumnKeys(tableKey, userPermissions) {
  const allColumns = DEFAULT_COLUMNS[tableKey] ?? [];
  const permissionMap = COLUMN_PERMISSIONS[tableKey] ?? {};

  return allColumns
    .filter((col) => {
      const requiredPermissions = permissionMap[col.key];
      if (!requiredPermissions || requiredPermissions.length === 0) return true;
      return hasAnyPermission(userPermissions, requiredPermissions);
    })
    .map((col) => col.key);
}

/**
 * Filters columns to only those the user is permitted to see.
 */
function filterColumnsByPermission(columns, tableKey, userPermissions) {
  const allowedKeys = new Set(getAllowedColumnKeys(tableKey, userPermissions));
  return columns.filter((col) => allowedKeys.has(col.key));
}

/**
 * Validates that all requested column keys exist in the table's default columns
 * and that the user has permission to access each one.
 * Returns the list of disallowed keys if any.
 */
export function validateColumns(tableKey, requestedKeys, userPermissions) {
  const allDefaultColumns = DEFAULT_COLUMNS[tableKey] ?? [];
  const validKeys = new Set(allDefaultColumns.map((col) => col.key));
  const allowedKeys = new Set(getAllowedColumnKeys(tableKey, userPermissions));

  const invalidKeys = requestedKeys.filter((key) => !validKeys.has(key));
  const unauthorizedKeys = requestedKeys.filter(
    (key) => validKeys.has(key) && !allowedKeys.has(key),
  );

  return { invalidKeys, unauthorizedKeys };
}

export async function getPreference(userId, tableKey, userPermissions) {
  const preference = await TablePreference.findOne({ userId, tableKey });
  if (!preference) {
    return { ...getDefaultPreference(tableKey), tableKey };
  }

  const prefObj = preference.toJSON();
  prefObj.columns = filterColumnsByPermission(prefObj.columns, tableKey, userPermissions);
  return prefObj;
}

export async function upsertPreference(userId, tableKey, update, userPermissions) {
  if (update.columns !== undefined) {
    const requestedKeys = update.columns.map((col) => col.key);
    const { invalidKeys, unauthorizedKeys } = validateColumns(
      tableKey,
      requestedKeys,
      userPermissions,
    );

    if (invalidKeys.length > 0) {
      const error = new Error(
        `Invalid column keys for table "${tableKey}": ${invalidKeys.join(', ')}.`,
      );
      error.statusCode = 400;
      throw error;
    }

    if (unauthorizedKeys.length > 0) {
      const error = new Error(
        `You do not have permission to access these columns: ${unauthorizedKeys.join(', ')}.`,
      );
      error.statusCode = 403;
      throw error;
    }
  }

  const setFields = {};
  if (update.columns !== undefined) setFields.columns = update.columns;
  if (update.pageSize !== undefined) setFields.pageSize = update.pageSize;
  if (update.sort !== undefined) setFields.sort = update.sort;
  if (update.filters !== undefined) setFields.filters = update.filters;

  const preference = await TablePreference.findOneAndUpdate(
    { userId, tableKey },
    { $set: setFields },
    { new: true, upsert: true, runValidators: true },
  );

  const prefObj = preference.toJSON();
  prefObj.columns = filterColumnsByPermission(prefObj.columns, tableKey, userPermissions);
  return prefObj;
}

export async function deletePreference(userId, tableKey) {
  const result = await TablePreference.findOneAndDelete({ userId, tableKey });
  return { deleted: Boolean(result) };
}
