import {
  createCompOffRequestSchema,
  compOffAssessSchema,
  compOffDecisionSchema,
  compOffEligibleDaysQuerySchema,
  compOffQuerySchema,
  compOffRejectSchema,
} from '../../../shared/validation/compOff.js';
import {
  assessCompOffWork,
  autoLoginByCompOffDecisionToken,
  createCompOffRequest,
  decideCompOffRequest,
  getCompOffApprovalsCount,
  getCompOffRequest,
  getEligibleCompOffDays,
  listCompOffRequests,
  undoCompOffAssessment,
  undoCompOffDecision,
  undoCompOffSubmit,
  undoCompOffWithdraw,
} from '../services/compOffService.js';
import { getISTYear } from '../utils/istDate.js';
import { signToken } from '../middleware/auth.js';
import { generateCsrfToken, setCsrfCookie } from '../middleware/csrf.js';
import { setAuthCookie } from './authController.js';
import { env } from '../config/env.js';
import { decisionLinkHtml } from './leaveController.js';

export async function getCompOffEligibleDaysHandler(req, res) {
  const parsed = compOffEligibleDaysQuerySchema.parse(req.query);
  const result = await getEligibleCompOffDays(parsed.year ?? getISTYear());
  res.json(result);
}

export async function createCompOffRequestHandler(req, res) {
  const parsed = createCompOffRequestSchema.parse(req.body);
  const request = await createCompOffRequest(req.user._id, parsed);
  res.status(201).json({ request });
}

export async function listCompOffRequestsHandler(req, res) {
  const parsed = compOffQuerySchema.parse(req.query);
  const result = await listCompOffRequests(req.user, req.userPermissions, parsed);
  res.json(result);
}

export async function getCompOffApprovalsCountHandler(req, res) {
  const result = await getCompOffApprovalsCount(req.user, req.userPermissions);
  res.json(result);
}

export async function withdrawCompOffRequestHandler(req, res) {
  const request = await undoCompOffSubmit(req.params.id, req.user);
  res.json({ request });
}

export async function undoCompOffWithdrawHandler(req, res) {
  const request = await undoCompOffWithdraw(req.params.id, req.user);
  res.json({ request });
}

export async function approveCompOffRequestHandler(req, res) {
  const parsed = compOffDecisionSchema.parse(req.body ?? {});
  const request = await decideCompOffRequest(
    req.params.id,
    req.user,
    req.userPermissions,
    'approved',
    parsed,
  );
  res.json({ request });
}

export async function rejectCompOffRequestHandler(req, res) {
  const parsed = compOffRejectSchema.parse(req.body ?? {});
  const request = await decideCompOffRequest(
    req.params.id,
    req.user,
    req.userPermissions,
    'rejected',
    parsed,
  );
  res.json({ request });
}

export async function undoCompOffDecisionHandler(req, res) {
  const request = await undoCompOffDecision(req.params.id, req.user, req.userPermissions);
  res.json({ request });
}

export async function assessCompOffRequestHandler(req, res) {
  const parsed = compOffAssessSchema.parse(req.body ?? {});
  const request = await assessCompOffWork(
    req.params.id,
    req.user,
    req.userPermissions,
    parsed.assessment,
    { comment: parsed.comment ?? null, assessments: parsed.assessments ?? null },
  );
  res.json({ request });
}

export async function undoCompOffAssessHandler(req, res) {
  const request = await undoCompOffAssessment(req.params.id, req.user, req.userPermissions);
  res.json({ request });
}

export async function getCompOffRequestHandler(req, res) {
  const request = await getCompOffRequest(req.params.id, req.user, req.userPermissions);
  res.json({ request });
}

export async function compOffDecisionLoginHandler(req, res) {
  const { request, action, token } = req.query;
  if (!request || !action || !token || action !== 'decide') {
    return res.status(400).type('html').send(decisionLinkHtml(false, 'This link is missing required parameters.'));
  }
  try {
    const { manager } = await autoLoginByCompOffDecisionToken(request, action, token);
    const jwtToken = signToken(manager);
    // Same session as a normal login: auth cookie plus the CSRF pair, so the
    // manager's approve/reject/assess POSTs from the comp-off page pass csrfProtection.
    setAuthCookie(res, jwtToken);
    setCsrfCookie(res, generateCsrfToken());
    return res.redirect(
      302,
      `${env.clientOrigin}/admin/leave/comp-off?decision=request&requestId=${request}`,
    );
  } catch (e) {
    return res.status(e.statusCode || 500).type('html').send(decisionLinkHtml(false, e.message || 'Something went wrong.'));
  }
}
