import { env } from '../config/env.js';
import { logError, logInfo } from '../utils/logger.js';

const SMS_ENDPOINT = 'https://api.brevo.com/v3/transactionalSMS/sms';

export function isSmsConfigured() {
  return Boolean(env.brevoApiKey && env.smsSender);
}

// Normalize to international digits. Local 10-digit numbers get the default country code.
function normalizePhone(value) {
  if (!value) return null;
  let digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 10) {
    const cc = String(env.smsDefaultCountryCode || '91').replace(/[^\d]/g, '');
    digits = cc + digits;
  }
  return digits;
}

export async function sendSms({ to, message }) {
  if (!isSmsConfigured()) {
    logInfo('sms:skipped', { reason: 'not configured' });
    return { delivered: false, skipped: true };
  }
  const recipient = normalizePhone(to);
  if (!recipient) {
    return { delivered: false, error: 'invalid_phone' };
  }
  try {
    const res = await fetch(SMS_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'api-key': env.brevoApiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: env.smsSender,
        recipient,
        content: message,
        type: 'transactional',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logError('sms:send_failed', { status: res.status, data });
      return { delivered: false, error: data };
    }
    logInfo('sms:sent', { recipient, messageId: data?.smsId ?? data?.reference });
    return { delivered: true, messageId: data?.smsId ?? data?.reference };
  } catch (error) {
    logError('sms:send_failed', { error: error.message });
    return { delivered: false, error: error.message };
  }
}