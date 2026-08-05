import mongoose from 'mongoose';
import { PERMISSIONS, SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import {
  DEFAULT_LEAVE_ADJUSTMENT_REASON,
  leaveAdjustmentBatchSchema,
  leaveAdjustmentGridQuerySchema,
} from '../../../shared/validation/leaveAdjustment.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveBalance, LEAVE_BALANCE_POPULATE } from '../models/LeaveBalance.js';
import { adjustBalance } from './leaveBalanceService.js';
import {
  applyTeamScopeToEmployeeQuery,
  isUserInTeamScope,
} from './teamScopeService.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function buildEmployeeDirectoryQuery() {
  const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
  return adminRole ? { roleId: { $ne: adminRole._id } } : { role: { $ne: 'admin' } };
}

function applyEmployeeFilters(query, { search, departmentId }) {
  query.isActive = true;

  if (departmentId) {
    query.departmentId = new mongoose.Types.ObjectId(departmentId);
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { name: regex },
      { email: regex },
      { employeeCode: regex },
      { department: regex },
    ];
  }

  return query;
}

async function buildScopedEmployeeQuery(actor, permissions, filters) {
  let query = applyEmployeeFilters(await buildEmployeeDirectoryQuery(), filters);
  query = await applyTeamScopeToEmployeeQuery(
    query,
    actor,
    permissions,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  return query;
}

async function assertEmployeeInScope(actor, permissions, userId) {
  const allowed = await isUserInTeamScope(
    actor,
    permissions,
    userId,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (!allowed) {
    throwError('Employee is outside your access scope.', 403);
  }
}

export async function getLeaveAdjustmentGrid(actor, permissions, rawQuery) {
  const parsed = leaveAdjustmentGridQuerySchema.parse(rawQuery);
  const query = await buildScopedEmployeeQuery(actor, permissions, {
    search: parsed.search,
    departmentId: parsed.departmentId,
  });

  const skip = (parsed.page - 1) * parsed.limit;
  const [employees, total, leaveTypes] = await Promise.all([
    User.find(query)
      .populate(USER_POPULATE_FIELDS)
      .sort({ name: 1 })
      .skip(skip)
      .limit(parsed.limit),
    User.countDocuments(query),
    LeaveType.find({ isActive: true }).sort({ code: 1 }),
  ]);

  const userIds = employees.map((employee) => employee._id);
  const balances =
    userIds.length > 0
      ? await LeaveBalance.find({
          userId: { $in: userIds },
          year: parsed.year,
        }).populate(LEAVE_BALANCE_POPULATE)
      : [];

  const balanceByUser = new Map();
  for (const balance of balances) {
    const userKey = balance.userId.toString();
    const typeKey = balance.leaveTypeId?._id?.toString() ?? balance.leaveTypeId?.toString();
    if (!balanceByUser.has(userKey)) {
      balanceByUser.set(userKey, new Map());
    }
    balanceByUser.get(userKey).set(typeKey, balance.toSafeJSON());
  }

  const rows = employees.map((employee) => {
    const userBalances = balanceByUser.get(employee._id.toString()) ?? new Map();
    const carriedByLeaveType = {};

    for (const leaveType of leaveTypes) {
      const typeId = leaveType._id.toString();
      const balance = userBalances.get(typeId);
      carriedByLeaveType[typeId] = {
        leaveTypeId: typeId,
        leaveTypeCode: leaveType.code,
        carried: balance?.carried ?? 0,
        entitled: balance?.entitled ?? 0,
        used: balance?.used ?? 0,
        available: balance?.available ?? 0,
      };
    }

    return {
      id: employee._id.toString(),
      name: employee.name,
      employeeCode: employee.employeeCode ?? null,
      departmentId: employee.departmentId?._id?.toString() ?? employee.departmentId?.toString() ?? null,
      departmentName: employee.departmentId?.name ?? employee.department ?? null,
      carriedByLeaveType,
    };
  });

  return {
    year: parsed.year,
    leaveTypes: leaveTypes.map((leaveType) => ({
      id: leaveType._id.toString(),
      code: leaveType.code,
      name: leaveType.name,
    })),
    rows,
    pagination: {
      page: parsed.page,
      limit: parsed.limit,
      total,
      totalPages: Math.ceil(total / parsed.limit) || 1,
    },
  };
}

export async function batchAdjustLeaveCarried(actor, permissions, rawBody) {
  const parsed = leaveAdjustmentBatchSchema.parse(rawBody);
  const results = [];
  let successCount = 0;

  for (const adjustment of parsed.adjustments) {
    try {
      await assertEmployeeInScope(actor, permissions, adjustment.userId);

      const result = await adjustBalance(
        adjustment.userId,
        {
          leaveTypeId: adjustment.leaveTypeId,
          year: adjustment.year,
          carried: adjustment.carried,
          reason: adjustment.reason?.trim() || DEFAULT_LEAVE_ADJUSTMENT_REASON,
        },
        actor._id,
      );

      successCount += 1;
      results.push({
        userId: adjustment.userId,
        leaveTypeId: adjustment.leaveTypeId,
        status: 'success',
        balance: result.balance,
      });
    } catch (error) {
      results.push({
        userId: adjustment.userId,
        leaveTypeId: adjustment.leaveTypeId,
        status: 'error',
        message: error.message ?? 'Adjustment failed.',
      });
    }
  }

  return {
    summary: {
      total: parsed.adjustments.length,
      success: successCount,
      error: parsed.adjustments.length - successCount,
    },
    results,
  };
}
