import { z } from 'zod';
import {
  getEmployeeHistory,
  getMonthDayStatusSummary,
  getTodayStatus,
  markAttendance,
  resolveMonthSummaryTargetUserId,
} from '../services/attendanceService.js';
import { attendancePayloadSchema } from '../../../shared/validation/attendance.js';
import { paginationSchema } from '../../../shared/validation/common.js';

const monthSummaryQuerySchema = z
  .object({
    month: z.union([
      z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      z.coerce.number().int().min(1).max(12),
    ]).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    userId: z.string().optional(),
  })
  .refine(
    (value) => {
      if (typeof value.month === 'string') return true;
      return value.year != null && value.month != null;
    },
    { message: 'Provide month as YYYY-MM, or year and month (1–12).' },
  );

function resolveMonthInput(query) {
  if (typeof query.month === 'string') {
    return query.month;
  }
  return `${query.year}-${String(query.month).padStart(2, '0')}`;
}
export async function getToday(req, res) {
  const status = await getTodayStatus(req.user._id);
  res.json({ status });
}

export async function checkIn(req, res) {
  const payload = attendancePayloadSchema.parse(req.body);
  const result = await markAttendance(req.user._id, 'check_in', payload);
  res.status(result.status === 'allowed' ? 201 : 400).json(result);
}

export async function checkOut(req, res) {
  const payload = attendancePayloadSchema.parse(req.body);
  const result = await markAttendance(req.user._id, 'check_out', payload);
  res.status(result.status === 'allowed' ? 201 : 400).json(result);
}

export async function getHistory(req, res) {
  const { page, limit } = paginationSchema.parse(req.query);
  const result = await getEmployeeHistory(req.user._id, { page, limit });
  res.json(result);
}

export async function getMonthSummary(req, res) {
  const query = monthSummaryQuerySchema.parse(req.query);
  const monthInput = resolveMonthInput(query);

  const targetUserId = await resolveMonthSummaryTargetUserId(
    req.user,
    req.userPermissions,
    query.userId,
  );
  const summary = await getMonthDayStatusSummary(targetUserId, monthInput);
  res.json(summary);
}