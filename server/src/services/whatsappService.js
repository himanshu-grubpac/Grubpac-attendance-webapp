import { env } from '../config/env.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * WhatsApp notifications via open-wa (WhatsApp Web automation), sent from the
 * app's own/dedicated WhatsApp number. This is the zero-cost path (no Meta per
 * message fee) but is unofficial — WhatsApp ToS/ban risk applies, which is why
 * sends are gated behind an explicit per-user opt-in (see User.whatsappOptIn).
 *
 * The @open-wa/wa-automate dependency is imported dynamically so the server
 * still boots if it is not installed, and every send degrades gracefully
 * (logged + skipped) when WhatsApp is disabled, the client is not ready, or a
 * send fails.
 */

function isEnabled() {
  return Boolean(env.whatsapp.enabled);
}

// Normalize to international digits (reuse the SMS country-code default), then
// the WhatsApp Web chat id format `<digits>@c.us`.
function toChatId(value) {
  if (!value) return null;
  let digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 10) {
    const cc = String(env.smsDefaultCountryCode || '91').replace(/[^\d]/g, '');
    digits = cc + digits;
  }
  return `${digits}@c.us`;
}

let client = null;
let initStarted = false;
let initFailedAt = 0;

async function loadCreate() {
  const mod = await import('@open-wa/wa-automate');
  const create = mod.create || mod.default?.create || mod.default;
  if (typeof create !== 'function') {
    throw new Error('@open-wa/wa-automate export not found');
  }
  return create;
}

async function initClient() {
  initStarted = true;
  try {
    const create = await loadCreate();
    client = await create({
      session: env.whatsapp.sessionName,
      headless: true,
      disableSpins: true,
      ...(env.whatsapp.executablePath ? { executablePath: env.whatsapp.executablePath } : {}),
    });
    logInfo('whatsapp:connected', { session: env.whatsapp.sessionName });
  } catch (error) {
    client = null;
    initFailedAt = Date.now();
    initStarted = false; // allow a later retry
    logError('whatsapp:init_failed', { error: error.message });
  }
}

// Kick off client init in the background so a request never blocks waiting on
// QR scan / browser launch. Sends before the client is ready are skipped.
function ensureClient() {
  if (!isEnabled() || initStarted || client) return;
  // Don't retry too aggressively if init keeps failing.
  if (initFailedAt && Date.now() - initFailedAt < 60_000) return;
  initClient();
}

/**
 * Send a plain-text WhatsApp message. Returns { delivered, skipped?, error? }.
 * Never throws — callers can fire-and-forget alongside email/sms.
 */
export async function sendWhatsAppText({ to, message }) {
  if (!isEnabled()) {
    return { delivered: false, skipped: true, reason: 'disabled' };
  }
  const chatId = toChatId(to);
  if (!chatId) {
    return { delivered: false, error: 'invalid_phone' };
  }
  ensureClient();
  if (!client) {
    return { delivered: false, skipped: true, reason: 'not_ready' };
  }
  try {
    await client.sendText(chatId, message);
    logInfo('whatsapp:sent', { to: chatId });
    return { delivered: true };
  } catch (error) {
    logError('whatsapp:send_failed', { to: chatId, error: error.message });
    return { delivered: false, error: error.message };
  }
}

/** True when WhatsApp is enabled (does not guarantee the client is ready). */
export function isWhatsAppEnabled() {
  return isEnabled();
}
