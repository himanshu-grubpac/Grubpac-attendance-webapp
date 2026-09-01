import {
  getISTDateInputValue,
  parseDateInputAsISTDay,
  WFH_LEAVE_TYPE_CODE,
} from '../../../shared/utils/wfhPolicy.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { endOfDayIST, startOfDayIST } from '../utils/istDate.js';

export {
  LEAVE_APPLY_CUTOFF_TIME,
  LEAVE_APPLY_DEADLINE_ERROR,
  LEAVE_APPLY_ADVANCE_ERROR,
  SL_LEAVE_TYPE_CODE,
  WFH_APPLY_CUTOFF_TIME,
  WFH_APPLY_DEADLINE_ERROR,
  WFH_CHECKIN_REQUIRES_APPROVAL_ERROR,
  getTomorrowISTDateKey,
  isLeaveTypeExemptFromApplyDeadline,
  isPastLeaveApplyCutoff,
  isPastWfhApplyCutoff,
  validateLeaveApplyDeadline,
  validateWfhApplyDeadline,
  validateWfhCheckInMode,
  wfhRangeIncludesISTDate,
} from '../../../shared/utils/wfhPolicy.js';

function resolveIstDay(dateInput) {
  if (typeof dateInput === 'string') {
    return parseDateInputAsISTDay(dateInput);
  }
  return parseDateInputAsISTDay(getISTDateInputValue(dateInput ?? new Date()));
}

/** Single WFH leave request covering the IST day for the given status(es). */
async function findWfhForIstDate(userId, dateInput, status) {
  const istDay = resolveIstDay(dateInput);
  if (!istDay) {
    return null;
  }

  const wfhType = await LeaveType.findOne({ code: WFH_LEAVE_TYPE_CODE, isActive: true }).select('_id');
  if (!wfhType) {
    return null;
  }

  const statusFilter = Array.isArray(status) ? { $in: status } : status;
  // Range-intersect with the full IST day so requests are matched regardless of
  // whether startDate/endDate were stored at UTC midnight or the IST-noon anchor.
  return LeaveRequest.findOne({
    userId,
    leaveTypeId: wfhType._id,
    status: statusFilter,
    startDate: { $lte: endOfDayIST(istDay) },
    endDate: { $gte: startOfDayIST(istDay) },
  })
    .select('_id status startDate endDate notifyAfter')
    .sort({ createdAt: -1 });
}

export async function hasApprovedWfhForIstDate(userId, dateInput) {
  const request = await findWfhForIstDate(userId, dateInput, 'approved');
  return Boolean(request);
}

export async function hasPendingWfhForIstDate(userId, dateInput) {
  const request = await findWfhForIstDate(userId, dateInput, 'pending');
  return Boolean(request);
}

/** Any WFH request (pending or approved) covering the IST day. */
export async function findWfhRequestForIstDate(userId, dateInput) {
  return findWfhForIstDate(userId, dateInput, ['pending', 'approved']);
}
