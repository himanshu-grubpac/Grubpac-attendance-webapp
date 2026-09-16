import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logError, logInfo } from '../utils/logger.js';

let cachedTransport = null;
let transportResolved = false;

/**
 * Returns a configured nodemailer transport, or null when SMTP is not
 * configured. The transport is memoized so the connection pool is reused.
 */
function getTransport() {
  if (transportResolved) return cachedTransport;
  transportResolved = true;

  const { host, port, secure, user, pass, pool } = env.smtp;
  if (!host) {
    cachedTransport = null;
    return null;
  }

  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    pool,
    auth: user ? { user, pass } : undefined,
  });
  return cachedTransport;
}

/** True when a real SMTP transport is configured. */
export function isEmailConfigured() {
  return Boolean(getTransport());
}

/** Close the pooled SMTP transport (test teardown / graceful shutdown). */
export function closeEmailTransport() {
  if (cachedTransport) {
    if (typeof cachedTransport.close === 'function') {
      cachedTransport.close();
    }
    cachedTransport = null;
    transportResolved = false;
  }
}

function buildFrom() {
  const { address, name } = env.emailFrom;
  if (!name) return address;
  // Keep ASCII-safe; nodemailer handles quoting.
  return `"${name}" <${address}>`;
}

/**
 * In-memory outbox used ONLY under NODE_ENV=test so automated tests can
 * assert exactly which emails a workflow emits (and that silent paths emit
 * none) without touching a real SMTP provider. Production path untouched.
 */
export const testEmailOutbox = [];

export function clearTestEmailOutbox() {
  testEmailOutbox.length = 0;
}

/**
 * Send a transactional email. When SMTP is not configured (local/dev), the
 * email content is written to the server console instead of being delivered.
 * Returns `{ delivered }` so callers can decide whether a dev link must be
 * surfaced for local testing.
 */
/**
 * Welcome email for a newly created employee. `tempPassword` is used only to
 * compose this single message — it is never persisted or logged.
 * Returns the sendEmail result (`{ delivered }`).
 */
export async function sendWelcomeEmail({ to, name, tempPassword }) {
  const { subject, html, text } = renderWelcomeEmail({
    name,
    loginId: to,
    tempPassword,
    loginUrl: `${env.clientOrigin}/login`,
  });
  return sendEmail({ to, subject, html, text, tag: 'welcome-credentials' });
}

export async function sendEmail({ to, subject, html, text, tag }) {
  if (process.env.NODE_ENV === 'test') {
    testEmailOutbox.push({ to, subject, html, text, tag });
    return { delivered: true };
  }
  const transport = getTransport();
  const from = buildFrom();

  if (!transport) {
    // Only log email metadata (not body) in dev — body may contain temp passwords.
    logInfo('email:dev_no_smtp', { to, subject });
    // eslint-disable-next-line no-console
    console.log(`\n[DEV EMAIL] To: ${to}\nSubject: ${subject}\n(SMTP not configured — body omitted for security)\n`);
    return { delivered: false };
  }

  const headers = { 'X-Mailin-tag': tag || 'transactional' };
  // List-Unsubscribe (even as mailto-only) is a positive inbox signal for
  // Gmail/Outlook. Only set it when a real sender address is configured.
  const senderAddress = env.emailFrom.address;
  if (senderAddress) {
    headers['List-Unsubscribe'] = `<mailto:${senderAddress}?subject=unsubscribe>`;
  }

  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      html,
      text,
      headers,
      // Replies go to a monitored mailbox instead of bouncing off the relay.
      ...(senderAddress ? { replyTo: from } : {}),
    });
    logInfo('email:sent', { to, subject, messageId: info?.messageId });
    return { delivered: true, messageId: info?.messageId };
  } catch (error) {
    logError('email:send_failed', { to, subject, error: error.message });
    // Do not crash the request; the caller already returned a generic response.
    return { delivered: false, error: error.message };
  }
}

const EXPIRY_MINUTES = Math.max(1, Math.round(env.passwordResetExpiresMs / 60000));

/** Build the branded password-reset email body (HTML + plain text). */
export function renderPasswordResetEmail({ name, resetLink }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const subject = 'Reset your Grubpac Attendance password';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">
                Grubpac Attendance
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px;">
                <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
                  We received a request to reset the password for your employee account.
                  Click the button below to choose a new password. This link expires in
                  ${EXPIRY_MINUTES} minutes and can only be used once.
                </p>
                <p style="margin:0 0 24px;">
                  <a href="${resetLink}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">
                    Reset password
                  </a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#2563eb;word-break:break-all;">
                  ${resetLink}
                </p>
                <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
                  If you didn't request this, you can safely ignore this email — your
                  password will not change.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                &copy; Grubpac Technologies. This is an automated message, please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${greeting}

We received a request to reset the password for your Grubpac Attendance employee account.

Reset your password using this link (expires in ${EXPIRY_MINUTES} minutes, single use):
${resetLink}

If you didn't request this, you can safely ignore this email — your password will not change.

© Grubpac Technologies`;

  return { subject, html, text };
}

/** New-employee welcome email with first-time login credentials. */
export function renderWelcomeEmail({ name, loginId, tempPassword, loginUrl }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const subject = 'Welcome to Grubpac Attendance — your login credentials';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">
                Grubpac Attendance
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px;">
                <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">
                  Your Grubpac Attendance account has been created. Sign in with these
                  first-time credentials:
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;line-height:1.5;">
                  <tr><td style="padding:10px 14px;color:#6b7280;">Login ID</td><td style="padding:10px 14px;font-weight:600;">${loginId}</td></tr>
                  <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb;">Temporary password</td><td style="padding:10px 14px;border-top:1px solid #e5e7eb;font-weight:600;">${tempPassword}</td></tr>
                </table>
                <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${loginUrl}" style="height:44px;v-text-anchor:middle;width:150px;" arcsize="10%" fillcolor="#1d4ed8" stroke="f">
                  <w:anchorlock/>
                  <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;">Sign in</center>
                </v:roundrect>
                <![endif]-->
                <!--[if !mso]><!-->
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td align="center" bgcolor="#1d4ed8" style="border-radius:8px;">
                      <a href="${loginUrl}" target="_blank" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">
                        Sign in
                      </a>
                    </td>
                  </tr>
                </table>
                <!--<![endif]-->
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all;">
                  <a href="${loginUrl}" target="_blank" style="color:#2563eb;">${loginUrl}</a>
                </p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.5;">
                  <strong>First-time steps:</strong>
                </p>
                <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.6;color:#374151;">
                  <li>Open the sign-in page and log in with the credentials above.</li>
                  <li>You will be asked to change your temporary password immediately — please do so.</li>
                  <li>Optionally set a 4-digit security PIN from Change Password for faster sign-in.</li>
                </ol>
                <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
                  Keep this email safe until you have signed in. If you did not expect
                  this account, please contact your administrator.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                &copy; Grubpac Technologies. This is an automated message, please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${greeting}

Your Grubpac Attendance account has been created. Sign in with these first-time credentials:

Login ID: ${loginId}
Temporary password: ${tempPassword}

Sign in here: ${loginUrl}

First-time steps:
1. Open the sign-in page and log in with the credentials above.
2. You will be asked to change your temporary password immediately — please do so.
3. Optionally set a 4-digit security PIN from Change Password for faster sign-in.

Keep this email safe until you have signed in.

© Grubpac Technologies`;

  return { subject, html, text };
}

const EXPIRY_MINUTES_LEAVE = Math.max(1, Math.round(env.passwordResetExpiresMs / 60000));

/**
 * Manager notification when an employee applies for leave.
 * withActions=false (e.g. auto-approved leave types) omits the Approve/Reject buttons.
 */
export function renderLeaveManagerEmail({
  requesterName,
  leaveTypeName,
  reason,
  dateText,
  timeText,
  withActions,
  actionUrl,
}) {
  const subject = `Leave request applied: ${leaveTypeName}`;
  const actions = withActions
    ? `<p style="margin:0 0 20px;">
         <a href="${actionUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 24px;border-radius:8px;">Take Action &rarr;</a>
       </p>`
    : `<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#6b7280;">This leave type is auto-approved, so no action is required from you.</p>`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${requesterName} has applied for <strong>${leaveTypeName}</strong>.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Reason:</strong> ${reason || '—'}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
            ${actions}
            <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">This link is secure, single-use, and expires automatically. If the button does not work, open the approvals page in the admin portal.</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `${requesterName} applied for ${leaveTypeName}.
Reason: ${reason || '—'}
Date: ${dateText}
Time: ${timeText}
${withActions ? `Take action here: ${actionUrl}` : 'This leave type is auto-approved; no action required.'}`;
  return { subject, html, text };
}

/** Applicant confirmation when a leave request survives its undo window and is finally submitted. */
export function renderLeaveApplicantSubmittedEmail({ leaveTypeName, reason, dateText, timeText }) {
  const subject = `Leave request submitted: ${leaveTypeName}`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Your <strong>${leaveTypeName}</strong> leave request has been <strong>submitted</strong> and sent to your reporting manager for action.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Reason:</strong> ${reason || '—'}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Your ${leaveTypeName} leave request has been submitted and sent to your reporting manager for action.
Reason: ${reason || '—'}
Date: ${dateText}
Time: ${timeText}`;
  return { subject, html, text };
}

/** Applicant notification when a leave request is approved or rejected. */
export function renderLeaveApplicantEmail({ leaveTypeName, status, remarks, dateText, timeText }) {
  const subject = `Leave request ${status}: ${leaveTypeName}`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Your <strong>${leaveTypeName}</strong> leave request has been <strong>${status}</strong>.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Remarks:</strong> ${remarks || '—'}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Your ${leaveTypeName} leave request has been ${status}.
Date: ${dateText}
Time: ${timeText}
Remarks: ${remarks || '—'}`;
  return { subject, html, text };
}

/** Applicant notification when a leave request (approved or pending) is cancelled by the employee. */
export function renderLeaveCancelledEmail({ leaveTypeName, dateText, timeText, wasApproved }) {
  const subject = `Leave request cancelled: ${leaveTypeName}`;
  const balanceNote = wasApproved
    ? '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;">The approved leave days have been returned to your leave balance.</p>'
    : '';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Your <strong>${leaveTypeName}</strong> leave request has been <strong>cancelled</strong>.</p>
            ${balanceNote}
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Your ${leaveTypeName} leave request has been cancelled.
Date: ${dateText}
Time: ${timeText}
${wasApproved ? 'The approved leave days have been returned to your leave balance.' : ''}`;
  return { subject, html, text };
}

/**
 * Reporting-chain notification when a leave request is cancelled.
 * Neutral wording covers both pending-request and approved-leave cancels;
 * when someone other than the applicant cancelled (e.g. an approver), the
 * actor is named explicitly instead of implying the employee did it.
 */
export function renderLeaveCancelledForManagerEmail({ applicantName, leaveTypeName, dateText, timeText, wasApproved, cancelledByName = null }) {
  const subject = wasApproved
    ? `Approved leave cancelled: ${leaveTypeName}`
    : `Leave request cancelled: ${leaveTypeName}`;
  const what = wasApproved ? 'approved' : 'pending';
  const actionHtml = cancelledByName
    ? `<strong>${cancelledByName}</strong> has cancelled <strong>${applicantName}</strong>'s ${what} <strong>${leaveTypeName}</strong> leave.`
    : `<strong>${applicantName}</strong> has cancelled their ${what} <strong>${leaveTypeName}</strong> leave.`;
  const actionText = cancelledByName
    ? `${cancelledByName} has cancelled ${applicantName}'s ${what} ${leaveTypeName} leave.`
    : `${applicantName} cancelled their ${what} ${leaveTypeName} leave.`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${actionHtml}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `${actionText}
Date: ${dateText}
Time: ${timeText}`;
  return { subject, html, text };
}

/** Approver notification when an approved leave is cancelled by the employee (or, with cancelledByName, by another approver). */
export function renderLeaveCancelledForApproverEmail({ applicantName, leaveTypeName, dateText, timeText, cancelledByName = null }) {
  const subject = `Approved leave cancelled: ${leaveTypeName}`;
  const actionHtml = cancelledByName
    ? `<strong>${cancelledByName}</strong> has cancelled <strong>${applicantName}</strong>'s approved <strong>${leaveTypeName}</strong> leave.`
    : `<strong>${applicantName}</strong> has cancelled their approved <strong>${leaveTypeName}</strong> leave.`;
  const actionText = cancelledByName
    ? `${cancelledByName} has cancelled ${applicantName}'s approved ${leaveTypeName} leave.`
    : `${applicantName} cancelled their approved ${leaveTypeName} leave.`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${actionHtml}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Time:</strong> ${timeText}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `${actionText}
Date: ${dateText}
Time: ${timeText}`;
  return { subject, html, text };
}

/** Manager notification when an employee submits a comp-off work request. No Take Action button (plain portal link). */
export function renderCompOffManagerEmail({ applicantName, dateText, days, reason, withActions = false, actionUrl = '' }) {
  const subject = `Comp off work requested: ${dateText}`;
  const actions = withActions && actionUrl
    ? `<p style="margin:0 0 20px;">
         <a href="${actionUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 24px;border-radius:8px;">Take Action &rarr;</a>
       </p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;"><strong>${applicantName}</strong> has requested approval to work on <strong>${dateText}</strong>.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Days:</strong> ${days} day(s)</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Reason:</strong> ${reason || '—'}</p>
            ${actions}
            <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">This link is secure, single-use, and expires automatically. If the button does not work, open the Comp off requests section in the admin portal.</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `${applicantName} requested approval to work on ${dateText} (${days} day(s)).
Reason: ${reason || '—'}
${withActions && actionUrl ? `Take action here: ${actionUrl}` : 'Open Comp off requests in the admin portal to respond.'}`;
  return { subject, html, text };
}

/** Applicant notification when a comp-off request is approved or rejected. */
export function renderCompOffDecisionEmail({ status, dateText, remarks }) {
  const subject = `Comp off request ${status}: ${dateText}`;
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Your comp off work request for <strong>${dateText}</strong> has been <strong>${status}</strong>.</p>
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Date:</strong> ${dateText}</p>
            <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Remarks:</strong> ${remarks || '—'}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Your comp off work request for ${dateText} has been ${status}.
Date: ${dateText}
Remarks: ${remarks || '—'}`;
  return { subject, html, text };
}

/** Applicant notification when assessed comp-off credit is granted. */
export function renderCompOffAssessedEmail({ dateText, creditedDays, assessment, breakdown = [] }) {
  const subject = `Comp off credited: +${creditedDays} day(s)`;
  const assessmentLabel =
    assessment === 'completed' ? 'Work completed'
    : assessment === 'half' ? 'Half work done'
    : assessment === 'mixed' ? 'Assessed per day'
    : 'Work not completed';
  const breakdownLines = (breakdown ?? [])
    .filter((entry) => entry && entry.dayKey)
    .map((entry) => {
      const label = entry.assessment === 'completed' ? 'Work completed'
        : entry.assessment === 'half' ? 'Half work done'
        : 'Work not completed';
      return { dayKey: entry.dayKey, label, credit: entry.credit ?? 0 };
    });
  const breakdownHtml = breakdownLines.length > 1
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:14px;line-height:1.5;">${
      breakdownLines.map((entry) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${entry.dayKey}</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${entry.label}</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:right;">+${entry.credit}</td></tr>`).join('')
    }</table>`
    : '';
  const breakdownText = breakdownLines.length > 1
    ? `\n${breakdownLines.map((entry) => `${entry.dayKey}: ${entry.label} (+${entry.credit})`).join('\n')}`
    : '';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr><td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">Grubpac Attendance</td></tr>
          <tr><td style="padding:28px 24px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Your comp off work on <strong>${dateText}</strong> was assessed as <strong>${assessmentLabel}</strong>.</p>
            ${breakdownHtml}
            <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Credit added:</strong> +${creditedDays} day(s) to your Compensatory Off balance</p>
            <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">The credit is available for comp off leave via Apply Leave &rarr; CO.</p>
          </td></tr>
          <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">&copy; Grubpac Technologies. This is an automated message, please do not reply.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Your comp off work on ${dateText} was assessed as ${assessmentLabel}.${breakdownText}
Credit added: +${creditedDays} day(s) to your Compensatory Off balance.`;
  return { subject, html, text };
}

/**
 * Welcome email for newly created employees with temporary credentials.
 */
export function renderWelcomeEmployeeEmail({ name, email, loginId, temporaryPassword, loginUrl }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const subject = 'Welcome to Grubpac Attendance — Your Account is Ready';
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#1d4ed8;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:700;">
                Grubpac Attendance
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px;">
                <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
                  Your employee account has been created. You can now log in to the Grubpac Attendance portal using the credentials below.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 20px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Login ID:</strong> ${loginId || email}</p>
                      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;"><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;font-size:14px;">${temporaryPassword}</code></p>
                      <p style="margin:0 0 0;font-size:14px;line-height:1.5;"><strong>Login URL:</strong> <a href="${loginUrl}" style="color:#2563eb;">${loginUrl}</a></p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 12px;font-size:14px;line-height:1.5;">
                  <strong>First-time login instructions:</strong>
                </p>
                <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.8;">
                  <li>Go to the login URL above.</li>
                  <li>Enter your Login ID and the temporary password shown above.</li>
                  <li>You will be prompted to change your password on first login.</li>
                  <li>Set a new strong password that you will remember.</li>
                </ol>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6b7280;">
                  For security, the temporary password must be changed after your first login. Please do not share your credentials with anyone.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">
                  If you have any questions, reach out to your reporting manager or HR administrator.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
                &copy; Grubpac Technologies. This is an automated message, please do not reply.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `${greeting}

Your employee account has been created. You can now log in to the Grubpac Attendance portal.

Login ID: ${loginId || email}
Temporary Password: ${temporaryPassword}
Login URL: ${loginUrl}

First-time login instructions:
1. Go to the login URL above.
2. Enter your Login ID and the temporary password shown above.
3. You will be prompted to change your password on first login.
4. Set a new strong password that you will remember.

For security, the temporary password must be changed after your first login. Please do not share your credentials with anyone.

If you have any questions, reach out to your reporting manager or HR administrator.

© Grubpac Technologies`;

  return { subject, html, text };
}