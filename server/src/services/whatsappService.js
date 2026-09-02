/**
 * WhatsApp notifications via open-wa (WhatsApp Web automation).
 *
 * NOTE: The @open-wa/wa-automate dependency has been removed from package.json
 * because it is not suitable for staging / Lambda deployments. The original
 * implementation is preserved below (commented out) so it can be re-enabled
 * by reinstalling the dependency and uncommenting the code.
 *
 * The exported functions are currently stubbed as no-ops so all callers
 * (leaveService.js, passwordResetController.js) continue to work without
 * modification.
 */

// import { env } from '../config/env.js';
// import { logError, logInfo } from '../utils/logger.js';
//
// function isEnabled() {
//   return Boolean(env.whatsapp.enabled);
// }
//
// function toChatId(value) {
//   if (!value) return null;
//   let digits = String(value).replace(/[^\d]/g, '');
//   if (!digits) return null;
//   if (digits.length === 10) {
//     const cc = String(env.smsDefaultCountryCode || '91').replace(/[^\d]/g, '');
//     digits = cc + digits;
//   }
//   return `${digits}@c.us`;
// }
//
// let client = null;
// let initStarted = false;
// let initFailedAt = 0;
//
// async function loadCreate() {
//   const mod = await import('@open-wa/wa-automate');
//   const create = mod.create || mod.default?.create || mod.default;
//   if (typeof create !== 'function') {
//     throw new Error('@open-wa/wa-automate export not found');
//   }
//   return create;
// }
//
// async function initClient() {
//   initStarted = true;
//   try {
//     const create = await loadCreate();
//     client = await create({
//       session: env.whatsapp.sessionName,
//       headless: true,
//       disableSpins: true,
//       ...(env.whatsapp.executablePath ? { executablePath: env.whatsapp.executablePath } : {}),
//     });
//     logInfo('whatsapp:connected', { session: env.whatsapp.sessionName });
//   } catch (error) {
//     client = null;
//     initFailedAt = Date.now();
//     initStarted = false;
//     logError('whatsapp:init_failed', { error: error.message });
//   }
// }
//
// function ensureClient() {
//   if (!isEnabled() || initStarted || client) return;
//   if (initFailedAt && Date.now() - initFailedAt < 60_000) return;
//   initClient();
// }
//
// export async function sendWhatsAppText({ to, message }) {
//   if (!isEnabled()) {
//     return { delivered: false, skipped: true, reason: 'disabled' };
//   }
//   const chatId = toChatId(to);
//   if (!chatId) {
//     return { delivered: false, error: 'invalid_phone' };
//   }
//   ensureClient();
//   if (!client) {
//     return { delivered: false, skipped: true, reason: 'not_ready' };
//   }
//   try {
//     await client.sendText(chatId, message);
//     logInfo('whatsapp:sent', { to: chatId });
//     return { delivered: true };
//   } catch (error) {
//     logError('whatsapp:send_failed', { to: chatId, error: error.message });
//     return { delivered: false, error: error.message };
//   }
// }
//
// export function isWhatsAppEnabled() {
//   return isEnabled();
// }

export async function sendWhatsAppText() {
  return { delivered: false, skipped: true, reason: 'disabled' };
}

export function isWhatsAppEnabled() {
  return false;
}
