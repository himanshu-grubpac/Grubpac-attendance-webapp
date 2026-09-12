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
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { resolveLeaveApprovalUserIds } from './teamScopeService.js';

/** Help tickets are raised by `createdBy` (not `userId`) — map the scope filter. */
function helpRequesterFilter(scopedIds) {
  if (scopedIds === null) return {};
  return { createdBy: { $in: scopedIds } };
}

export async function getAdminReportsSummary(actor = null, permissions = []) {
  const unscoped =
    hasPermission(permissions, PERMISSIONS.LEAVE_READ_ALL) ||
    hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL);
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

  const [
    pendingLeave,
    approvedLeaveDays,
    openHelpTickets,
    activeEmployees,
    presentUserIds,
    onLeaveToday,
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
      ? User.countDocuments({ isActive: true })
      : User.countDocuments({ _id: { $in: scopedIds }, isActive: true }),
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
  ]);

  const presentSet = new Set(presentUserIds.map((id) => id.toString()));
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
