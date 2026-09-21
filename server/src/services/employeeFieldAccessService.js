import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { isUserInTeamScope } from './teamScopeService.js';

/** Field groups on employee detail — maps to catalog rows 8–15. */
export const EMPLOYEE_FIELD_GROUPS = {
  account: {
    read: PERMISSIONS.EMPLOYEES_ACCOUNT_R,
    fields: ['firstName', 'lastName', 'name', 'email', 'mobile', 'employeeCode', 'isActive', 'lastLoginAt'],
  },
  employment: {
    read: PERMISSIONS.EMPLOYEES_EMPLOYMENT_R,
    update: PERMISSIONS.EMPLOYEES_EMPLOYMENT_U,
    fields: [
      'roleId',
      'departmentId',
      'designation',
      'reportingManagerId',
      'joiningDate',
      'dateOfBirth',
      'endingDate',
    ],
  },
  salary: {
    read: PERMISSIONS.EMPLOYEES_SALARY_R,
    update: PERMISSIONS.EMPLOYEES_SALARY_U,
    fields: ['monthlySalary', 'salaryEffectiveFrom', 'salaryCurrency'],
  },
  delegate: {
    read: PERMISSIONS.EMPLOYEES_DELEGATE_R,
    update: PERMISSIONS.EMPLOYEES_DELEGATE_U,
    fields: ['delegateApproverId', 'delegateApproverName'],
  },
  managedDepts: {
    read: PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_R,
    update: PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U,
    fields: ['managedDepartmentIds'],
  },
  credentials: {
    update: PERMISSIONS.EMPLOYEES_CREDENTIALS_U,
    fields: ['hasPassword', 'hasPin', 'mustChangePassword'],
  },
};

const PATCH_FIELD_TO_GROUP = {
  firstName: 'account',
  lastName: 'account',
  email: 'account',
  mobile: 'account',
  roleId: 'employment',
  departmentId: 'employment',
  designation: 'employment',
  reportingManagerId: 'employment',
  joiningDate: 'employment',
  dateOfBirth: 'employment',
  endingDate: 'employment',
  delegateApproverId: 'delegate',
  managedDepartmentIds: 'managedDepts',
  isActive: 'status',
};

export function buildEmployeeFieldAccess(permissions) {
  return {
    account: hasPermission(permissions, PERMISSIONS.EMPLOYEES_ACCOUNT_R),
    employment: {
      read: hasPermission(permissions, PERMISSIONS.EMPLOYEES_EMPLOYMENT_R),
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_EMPLOYMENT_U),
    },
    salary: {
      read: hasPermission(permissions, PERMISSIONS.EMPLOYEES_SALARY_R),
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_SALARY_U),
    },
    salaryHistory: {
      read: hasPermission(permissions, PERMISSIONS.EMPLOYEES_SALARY_HISTORY_R),
      detail: hasPermission(permissions, PERMISSIONS.EMPLOYEES_SALARY_HISTORY_X0),
    },
    credentials: {
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_CREDENTIALS_U),
      resetPassword: hasPermission(permissions, PERMISSIONS.EMPLOYEES_CREDENTIALS_X0),
      resetPin: hasPermission(permissions, PERMISSIONS.EMPLOYEES_CREDENTIALS_X1),
      sendCredentials: hasPermission(permissions, PERMISSIONS.EMPLOYEES_CREDENTIALS_X2),
    },
    status: {
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_STATUS_U),
      deactivate:
        hasPermission(permissions, PERMISSIONS.EMPLOYEES_STATUS_X0) ||
        hasPermission(permissions, PERMISSIONS.EMPLOYEES_RECORD_D),
      reactivate: hasPermission(permissions, PERMISSIONS.EMPLOYEES_STATUS_X1),
    },
    delegate: {
      read: hasPermission(permissions, PERMISSIONS.EMPLOYEES_DELEGATE_R),
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_DELEGATE_U),
    },
    managedDepts: {
      read: hasPermission(permissions, PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_R),
      update: hasPermission(permissions, PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U),
    },
    salaryColumn: hasPermission(permissions, PERMISSIONS.EMPLOYEES_SALARY_COLUMN_R),
  };
}

export function maskEmployeePayload(employeeJson, permissions, { includeMeta = true } = {}) {
  const access = buildEmployeeFieldAccess(permissions);
  const masked = { ...employeeJson };

  if (!access.account) {
    for (const key of EMPLOYEE_FIELD_GROUPS.account.fields) {
      if (key !== 'name') delete masked[key];
    }
    masked.name = masked.name ?? 'Employee';
  }

  if (!access.employment.read) {
    for (const key of [...EMPLOYEE_FIELD_GROUPS.employment.fields, 'department', 'departmentName', 'roleName', 'roleSlug', 'reportingManagerName']) {
      delete masked[key];
    }
  }

  if (!access.salary.read) {
    for (const key of EMPLOYEE_FIELD_GROUPS.salary.fields) {
      delete masked[key];
    }
  }

  if (!access.delegate.read) {
    for (const key of EMPLOYEE_FIELD_GROUPS.delegate.fields) {
      delete masked[key];
    }
  }

  if (!access.managedDepts.read) {
    delete masked.managedDepartmentIds;
  }

  if (!access.credentials.update) {
    for (const key of EMPLOYEE_FIELD_GROUPS.credentials.fields) {
      delete masked[key];
    }
  }

  if (includeMeta) {
    masked.fieldAccess = access;
  }

  return masked;
}

export async function assertEmployeeReadable(actor, permissions, targetUserId) {
  const inScope = await isUserInTeamScope(actor, permissions, targetUserId);
  if (!inScope) {
    return { ok: false, status: 404, message: 'Employee not found.' };
  }
  const canRead =
    hasPermission(permissions, PERMISSIONS.EMPLOYEES_RECORD_R) ||
    hasPermission(permissions, PERMISSIONS.EMPLOYEES_ACCOUNT_R) ||
    hasPermission(permissions, PERMISSIONS.EMPLOYEES_STATS_R);
  if (!canRead) {
    return { ok: false, status: 403, message: 'You do not have permission to view this employee.' };
  }
  return { ok: true };
}

export function assertEmployeePatchAllowed(permissions, body) {
  const access = buildEmployeeFieldAccess(permissions);
  const keys = Object.keys(body ?? {}).filter((key) => body[key] !== undefined);

  for (const key of keys) {
    if (key === 'isActive') {
      const activating = body.isActive === true;
      const deactivating = body.isActive === false;
      if (activating && !access.status.reactivate) {
        return { ok: false, message: 'You do not have permission to reactivate employees.' };
      }
      if (deactivating && !access.status.deactivate) {
        return { ok: false, message: 'You do not have permission to deactivate employees.' };
      }
      if (!access.status.update) {
        return { ok: false, message: 'You do not have permission to change employment status.' };
      }
      continue;
    }

    const group = PATCH_FIELD_TO_GROUP[key];
    if (!group) continue;

    if (group === 'account') {
      if (!access.account) {
        return { ok: false, message: `You do not have permission to update ${key}.` };
      }
      continue;
    }

    if (group === 'employment' && !access.employment.update) {
      return { ok: false, message: `You do not have permission to update ${key}.` };
    }
    if (group === 'delegate' && !access.delegate.update) {
      return { ok: false, message: 'You do not have permission to update delegate approver.' };
    }
    if (group === 'managedDepts' && !access.managedDepts.update) {
      return { ok: false, message: 'You do not have permission to update managed departments.' };
    }
  }

  return { ok: true };
}
