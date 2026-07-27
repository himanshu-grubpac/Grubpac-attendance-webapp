import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, requireEmployeePortalAccess } from '../middleware/auth.js';
import { attendanceLimiter } from '../middleware/rateLimiters.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import {
  checkIn,
  checkOut,
  getHistory,
  getMonthSummary,
  getMyQuarterWarnings,
  getToday,
} from '../controllers/attendanceController.js';

const router = Router();

router.get('/month-summary', authenticate, asyncHandler(getMonthSummary));

router.use(authenticate, requireEmployeePortalAccess);

router.get('/today', asyncHandler(getToday));
router.post('/check-in', attendanceLimiter, idempotencyMiddleware, asyncHandler(checkIn));
router.post('/check-out', attendanceLimiter, asyncHandler(checkOut));
router.get('/history', asyncHandler(getHistory));
router.get('/quarter-warnings', asyncHandler(getMyQuarterWarnings));

export default router;
