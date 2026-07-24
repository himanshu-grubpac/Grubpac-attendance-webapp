import { randomBytes, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';

export const CSRF_COOKIE_NAME = 'attendance_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateCsrfToken() {
  return randomBytes(32).toString('hex');
}

export function getCsrfCookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: env.jwtCookieMaxAgeMs,
    path: '/',
  };
}

export function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE_NAME, token, getCsrfCookieOptions());
}

export function clearCsrfCookie(res) {
  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Double-submit CSRF protection for cookie-authenticated mutating requests.
 * Skips safe methods, auth login endpoints (no session yet), and health checks.
 */
export function csrfProtection(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) {
    return next();
  }

  const path = req.path ?? '';
  if (path === '/auth/admin/login' || path === '/auth/user/login') {
    return next();
  }

  const hasSession = Boolean(req.cookies?.attendance_token);
  if (!hasSession) {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({ message: 'Invalid or missing CSRF token.' });
  }

  return next();
}
