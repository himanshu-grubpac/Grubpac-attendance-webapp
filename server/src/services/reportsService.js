import { getISTYear, parseDateInputAsISTDay } from '../utils/istDate.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { HelpTicket } from '../models/HelpTicket.js';
import { User } from '../models/User.js';

export async function getAdminReportsSummary() {
  const year = getISTYear();
  const yearStart = parseDateInputAsISTDay(`${year}-01-01`);
  const yearEnd = parseDateInputAsISTDay(`${year}-12-31`);

  const [pendingLeave, approvedLeaveDays, openHelpTickets, activeEmployees] = await Promise.all([
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
  ]);

  return {
    year,
    pendingLeaveRequests: pendingLeave,
    approvedLeaveDaysYtd: approvedLeaveDays[0]?.totalDays ?? 0,
    openHelpTickets,
    activeEmployees,
  };
}
