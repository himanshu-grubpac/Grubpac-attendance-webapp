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

function buildFrom() {
  const { address, name } = env.emailFrom;
  if (!name) return address;
  // Keep ASCII-safe; nodemailer handles quoting.
  return `"${name}" <${address}>`;
}

/**
 * Send a transactional email. When SMTP is not configured (local/dev), the
 * email content is written to the server console instead of being delivered.
 * Returns `{ delivered }` so callers can decide whether a dev link must be
 * surfaced for local testing.
 */
export async function sendEmail({ to, subject, html, text }) {
  const transport = getTransport();
  const from = buildFrom();

  if (!transport) {
    logInfo('email:dev_console', { to, subject, text });
    // eslint-disable-next-line no-console
    console.log(
      `\n[DEV EMAIL] To: ${to}\nSubject: ${subject}\n${text}\n`,
    );
    return { delivered: false };
  }

  try {
    const info = await transport.sendMail({ from, to, subject, html, text });
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
