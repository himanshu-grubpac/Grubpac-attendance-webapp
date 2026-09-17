import {
  batchAdjustLeaveCarried,
  getLeaveAdjustmentGrid,
  getLeaveAdjustmentHistory,
} from '../services/leaveAdjustmentService.js';
import { auditRequest } from '../utils/auditLog.js';

export async function getLeaveAdjustmentGridHandler(req, res) {
  const data = await getLeaveAdjustmentGrid(req.user, req.userPermissions, req.query);
  res.json(data);
}

export async function getLeaveAdjustmentHistoryHandler(req, res) {
  const data = await getLeaveAdjustmentHistory(
    req.user,
    req.userPermissions,
    req.params.userId,
    req.query,
  );
  res.json(data);
}

export async function batchAdjustLeaveCarriedHandler(req, res) {
  const result = await batchAdjustLeaveCarried(req.user, req.userPermissions, req.body);

  auditRequest(req, 'leave_adjustment_batch', {
    adminId: req.user._id.toString(),
    summary: result.summary,
    adjustments: req.body?.adjustments?.map((item) => ({
      userId: item.userId,
      leaveTypeId: item.leaveTypeId,
      year: item.year,
      carried: item.carried,
    })),
  });

  res.json(result);
}
