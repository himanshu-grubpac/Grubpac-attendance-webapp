import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, invalidateUserSessions } from '../middleware/auth.js';
import { authLimiter, passwordResetLimiter, refreshLimiter } from '../middleware/rateLimiters.js';
import {
  loginUser,
  getCurrentUser,
  refreshSession,
  updateProfile,
  changePassword,
  setPin,
  deletePin,
  applyAuthSession,
  clearAuthCookie,
} from '../controllers/authController.js';
import {
  requestPasswordReset,
  verifyPasswordReset,
  resetPassword,
} from '../controllers/passwordResetController.js';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, clearCsrfCookie } from '../middleware/csrf.js';
import { auditLog, auditRequest, getRequestAuditContext } from '../utils/auditLog.js';

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
    auditRequest(req, 'logout', { userId: req.user._id.toString(), email: req.user.email });
    clearAuthCookie(res);
    clearCsrfCookie(res);
    res.json({ message: 'Logged out successfully.' });
  }),
);

// Sliding session renewal (see refreshSession). Authenticated only, CSRF
// enforced by the global csrfProtection middleware — the client sends the
// X-CSRF-Token header like any other mutation. Deliberately not audit-logged:
// it fires unattended every ~45 minutes per open browser.
router.post(
  '/refresh',
  refreshLimiter,
  authenticate,
  asyncHandler(async (req, res) => {
    const csrfToken = req.cookies?.[CSRF_COOKIE_NAME] ?? req.headers[CSRF_HEADER_NAME] ?? null;
    const result = await refreshSession(req.user._id, csrfToken);
    applyAuthSession(res, result);
    res.json({ csrfToken: result.csrfToken, expiresAt: result.expiresAt });
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
    applyAuthSession(res, result);
    res.json({ message: result.message, csrfToken: result.csrfToken });
  }),
);

// Self-service PIN setup/change (all roles).
router.post(
  '/set-pin',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await setPin(req.user._id, req.body, getRequestAuditContext(req));
    applyAuthSession(res, result);
    res.json({ message: result.message, csrfToken: result.csrfToken });
  }),
);

// Self-service PIN removal (all roles).
router.post(
  '/delete-pin',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await deletePin(req.user._id, req.body, getRequestAuditContext(req));
    applyAuthSession(res, result);
    res.json({ message: result.message, csrfToken: result.csrfToken });
  }),
);

// Employee self-service password reset (public — no session required).
router.post(
  '/forgot-password',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const auditContext = getRequestAuditContext(req);
    const result = await requestPasswordReset(req.body, auditContext);
    res.json(result);
  }),
);

router.post(
  '/reset-password/verify',
  asyncHandler(async (req, res) => {
    const result = await verifyPasswordReset(req.body);
    res.json(result);
  }),
);

router.post(
  '/reset-password',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const auditContext = getRequestAuditContext(req);
    const result = await resetPassword(req.body, auditContext);
    res.json(result);
  }),
);

export default router;
