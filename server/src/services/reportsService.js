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

export async function getAdminReportsSummary() {
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
    LeaveRequest.countDocuments({ status: 'pending' }),
    LeaveRequest.aggregate([
      {
        $match: {
          status: 'approved',
          startDate: { $gte: yearStart, $lte: yearEnd },
        },
      },
      { $group: { _id: null, totalDays: { $sum: '$days' } } },
    ]),
    HelpTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
    User.countDocuments({ isActive: true }),
    AttendanceRecord.distinct('userId', {
      type: 'check_in',
      status: 'allowed',
      timestamp: { $gte: todayStart, $lte: todayEnd },
    }),
    LeaveRequest.distinct('userId', {
      status: 'approved',
      startDate: { $lte: todayDay },
      endDate: { $gte: todayDay },
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
