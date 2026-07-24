import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, invalidateUserSessions } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiters.js';
import {
  loginUser,
  getCurrentUser,
  updateProfile,
  changePassword,
  applyAuthSession,
  clearAuthCookie,
} from '../controllers/authController.js';
import { clearCsrfCookie } from '../middleware/csrf.js';
import { auditLog, getRequestAuditContext } from '../utils/auditLog.js';

const router = Router();

router.post(
  '/admin/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const auditContext = getRequestAuditContext(req);
    const result = await loginUser(req.body, 'admin', auditContext);
    applyAuthSession(res, result);
    res.json({ user: result.user, csrfToken: result.csrfToken });
  }),
);

router.post(
  '/user/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const auditContext = getRequestAuditContext(req);
    const result = await loginUser(req.body, 'employee', auditContext);
    applyAuthSession(res, result);
    res.json({ user: result.user, csrfToken: result.csrfToken });
  }),
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await invalidateUserSessions(req.user._id);
    auditLog('logout', { userId: req.user._id.toString(), email: req.user.email });
    clearAuthCookie(res);
    clearCsrfCookie(res);
    res.json({ message: 'Logged out successfully.' });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req.user._id);
    res.json({ user });
  }),
);

router.patch(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await updateProfile(req.user._id, req.body);
    res.json({ user });
  }),
);

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await changePassword(req.user._id, req.body);
    res.json(result);
  }),
);

export default router;
