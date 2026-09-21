/**
 * Device-class detection from a user-agent string.
 *
 * Used to render a human-readable device label ("Mobile" / "Tablet" /
 * "Desktop") for audit log rows. The stored device ID is a random per-browser
 * UUID and carries no device information — the user-agent is the only signal,
 * so classification must always be derived per event (never per user: the
 * same account from a phone and a laptop yields different labels).
 *
 * Returns 'mobile' | 'tablet' | 'desktop', or null when there is no
 * user-agent to classify (e.g. system/cron jobs).
 */

const TABLET_PATTERN = /ipad|tablet|kindle|silk|playbook|sm-t\d|nexus\s*[79]/i;
const MOBILE_PATTERN =
  /mobi|iphone|ipod|android.*mobile|windows phone|blackberry|iemobile|opera (mini|mobi)|mobile safari.*mobile/i;

export function getDeviceTypeFromUserAgent(userAgent) {
  if (userAgent === undefined || userAgent === null) return null;
  const ua = String(userAgent).trim();
  if (!ua) return null;
  if (TABLET_PATTERN.test(ua)) return 'tablet';
  // Android without a "mobile" token is a tablet (standard heuristic).
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return 'tablet';
  if (MOBILE_PATTERN.test(ua)) return 'mobile';
  return 'desktop';
}

const DEVICE_TYPE_LABELS = {
  mobile: 'Mobile',
  tablet: 'Tablet',
  desktop: 'Desktop',
};

export function formatDeviceTypeLabel(deviceType) {
  return DEVICE_TYPE_LABELS[deviceType] ?? null;
}

/**
 * "<Name>'s <Type>" label for audit rows. Falls back to the bare type when
 * the actor name is unknown; null when there is nothing to show.
 */
export function formatDeviceOwnerLabel(actorName, deviceType) {
  const label = formatDeviceTypeLabel(deviceType);
  if (!label) return null;
  const name = typeof actorName === 'string' ? actorName.trim() : '';
  if (!name) return label;
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return `${possessive} ${label}`;
}

/**
 * Browser family from a user-agent string. Order matters: Edge, Opera and
 * Samsung browsers all embed Chrome/Safari tokens. Returns display names
 * ('Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Samsung Internet') or
 * null when unrecognized. Hand-rolled: no dependency for a dozen regexes.
 */
export function getBrowserFromUserAgent(userAgent) {
  if (userAgent === undefined || userAgent === null) return null;
  const ua = String(userAgent).trim();
  if (!ua) return null;
  if (/edg(e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser\//i.test(ua)) return 'Samsung Internet';
  if (/firefox\/|fxios\//i.test(ua)) return 'Firefox';
  if (/chrome\/|crios\//i.test(ua)) return 'Chrome';
  if (/safari\//i.test(ua)) return 'Safari';
  return null;
}

/**
 * OS family from a user-agent string. Returns display names ('Windows',
 * 'macOS', 'Android', 'iOS', 'Linux') or null when unrecognized. Note a
 * laptop and a desktop PC are indistinguishable from UA alone — both are
 * the Desktop device class with their real OS shown.
 */
export function getOsFromUserAgent(userAgent) {
  if (userAgent === undefined || userAgent === null) return null;
  const ua = String(userAgent).trim();
  if (!ua) return null;
  if (/windows nt/i.test(ua)) return 'Windows';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod|cpu (iphone )?os/i.test(ua)) return 'iOS';
  if (/mac os x/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return null;
}

/**
 * Full device label: "<Name>'s <Type> — <Browser> / <OS>", degrading
 * gracefully when parts are missing ("<Type>", "<Type> — <Browser>",
 * "<Name>'s <Type>"). Null when nothing classifiable exists.
 */
export function formatDeviceFullLabel(actorName, { deviceType, browser, os } = {}) {
  const base = formatDeviceOwnerLabel(actorName, deviceType);
  if (!base) return null;
  const detail = [browser, os].filter(Boolean).join(' / ');
  return detail ? `${base} — ${detail}` : base;
}
