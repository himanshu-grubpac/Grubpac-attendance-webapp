import {
  endOfDayIST,
  getISTDateInputValue,
  getISTYear,
  parseDateInputAsISTDay,
  startOfDayIST,
} from '../utils/istDate.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { SYSTEM_ROLE_SLUGS, PERMISSIONS, hasCompanyWideScope, hasPermission } from
  '../../../shared/permissions.js';
import { resolveLeaveApprovalUserIds } from './teamScopeService.js';

/** Help tickets are raised by `createdBy` (not `userId`) — map the scope filter. */
function helpRequesterFilter(scopedIds) {
  if (scopedIds === null) return {};
  return { createdBy: { $in: scopedIds } };
}

async function loadAdminRole() {
  return Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id');
}

function adminExclusionQuery(adminRole) {
  return adminRole ? { roleId: { $ne: adminRole._id } } : {};
}

function adminUserFilter(adminRole) {
  return adminRole ? { roleId: adminRole._id } : { _id: null };
}

export async function getAdminReportsSummary(actor = null, permissions = []) {
  // Company-wide scope is the employees record read slug: the collapsed
  // LEAVE/ATTENDANCE _READ_ALL slugs are held by RMs too and no longer
  // distinguish full from team scope.
  const unscoped = hasCompanyWideScope(permissions);
  // Team-scoped callers (e.g. reporting managers) see only their direct
  // reports (+ delegate chain) — never org-wide counts.
  const scopedIds = unscoped || !actor?._id ? null : await resolveLeaveApprovalUserIds(actor);
  const userFilter = scopedIds === null ? {} : { userId: { $in: scopedIds } };
  const year = getISTYear();
  const yearStart = parseDateInputAsISTDay(`${year}-01-01`);
  const yearEnd = parseDateInputAsISTDay(`${year}-12-31`);
  const todayStart = startOfDayIST();
  const todayEnd = endOfDayIST();
  const todayKey = getISTDateInputValue();
  const todayDay = parseDateInputAsISTDay(todayKey);

  const adminRole = await loadAdminRole();
  const adminExclusion = adminExclusionQuery(adminRole);
  const adminFilter = adminUserFilter(adminRole);

  const [
    pendingLeave,
    approvedLeaveDays,
    openHelpTickets,
    activeEmployees,
    presentUserIds,
    onLeaveToday,
    adminUserIds,
  ] = await Promise.all([
    LeaveRequest.countDocuments({ status: 'pending', ...userFilter }),
    LeaveRequest.aggregate([
      {
        $match: {
          status: 'approved',
          startDate: { $gte: yearStart, $lte: yearEnd },
          ...(scopedIds === null ? {} : { userId: { $in: scopedIds } }),
        },
      },
      { $group: { _id: null, totalDays: { $sum: '$days' } } },
    ]),
    HelpTicket.countDocuments({ status: { $in: ['open', 'in_progress'] }, ...helpRequesterFilter(scopedIds) }),
    scopedIds === null
      ? User.countDocuments({ isActive: true, ...adminExclusion })
      : User.countDocuments({ _id: { $in: scopedIds }, isActive: true, ...adminExclusion }),
    AttendanceRecord.distinct('userId', {
      type: 'check_in',
      status: 'allowed',
      timestamp: { $gte: todayStart, $lte: todayEnd },
      ...userFilter,
    }),
    LeaveRequest.distinct('userId', {
      status: 'approved',
      startDate: { $lte: todayEnd },
      endDate: { $gte: todayStart },
      ...userFilter,
    }),
    User.find({ isActive: true, ...adminFilter }).select('_id').lean(),
  ]);

  const adminIdSet = new Set(adminUserIds.map((u) => u._id.toString()));

  const presentSet = new Set(
    presentUserIds
      .map((id) => id.toString())
      .filter((id) => !adminIdSet.has(id)),
  );
  const leaveOnlyCount = onLeaveToday.filter((id) => !presentSet.has(id.toString())).length;
  const presentToday = presentSet.size;
  const absentToday = Math.max(0, activeEmployees - presentToday - leaveOnlyCount);

  return {
    year,
    pendingLeaveRequests: pendingLeave,
    approvedLeaveDaysYtd: approvedLeaveDays[0]?.totalDays ?? 0,
    openHelpTickets,
    activeEmployees,
    presentToday,
    absentToday,
  };
}
