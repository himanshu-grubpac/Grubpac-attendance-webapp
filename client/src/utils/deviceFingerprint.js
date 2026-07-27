const STORAGE_KEY = 'attendance.deviceId';

function generateDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Stable per-browser device id (localStorage) plus user agent for audit trails. */
export function getDeviceFingerprint() {
  let deviceId;
  try {
    deviceId = localStorage.getItem(STORAGE_KEY);
    if (!deviceId) {
      deviceId = generateDeviceId();
      localStorage.setItem(STORAGE_KEY, deviceId);
    }
  } catch {
    deviceId = generateDeviceId();
  }

  return {
    deviceId,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };
}
