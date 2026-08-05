import {
  getISTDateInputValue,
  parseDateInputAsISTDay,
  WFH_LEAVE_TYPE_CODE,
} from '../../../shared/utils/wfhPolicy.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeaveRequest } from '../models/LeaveRequest.js';

export {
  LEAVE_APPLY_CUTOFF_TIME,
  LEAVE_APPLY_DEADLINE_ERROR,
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

export async function hasApprovedWfhForIstDate(userId, dateInput) {
  const istDay = resolveIstDay(dateInput);
  if (!istDay) {
    return false;
  }

  const wfhType = await LeaveType.findOne({ code: WFH_LEAVE_TYPE_CODE, isActive: true }).select('_id');
  if (!wfhType) {
    return false;
  }

  const request = await LeaveRequest.findOne({
    userId,
    leaveTypeId: wfhType._id,
    status: 'approved',
    startDate: { $lte: istDay },
    endDate: { $gte: istDay },
  }).select('_id');

  return Boolean(request);
}
