import rateLimit from 'express-rate-limit';

// NOTE: `max` is a function (evaluated per request), not a static number.
// ESM hoists imports above the `process.env.NODE_ENV = 'test'` assignments
// in e2e/verify harnesses, so a static read here would freeze the production
// limit even under test. The function form reads the env at request time.
// Non-production (dev/test) gets a generous cap: strict brute-force limits
// must only bite in production (staging/Lambda set NODE_ENV=production).
const devBypass = (prodMax) => (req, res) =>
  process.env.NODE_ENV === 'production' ? prodMax : 10_000;

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: devBypass(20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' },
});

export const attendanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: devBypass(15),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attendance requests. Please wait a moment.' },
});

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: devBypass(10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many password reset requests. Please try again later.' },
});

export const leaveDecisionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: devBypass(30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many leave decision attempts. Please try again later.' },
});
