import dotenv from 'dotenv';

dotenv.config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

export const env = {
  port: Number(process.env.PORT ?? 5000),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/attendance_web'),
  jwtSecret: required('JWT_SECRET', 'local-dev-attendance-secret-change-in-production'),
  /** Short-lived access token (v1 — no refresh-token rotation yet). */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  jwtCookieMaxAgeMs: Number(process.env.JWT_COOKIE_MAX_AGE_MS ?? 2 * 60 * 60 * 1000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@grubpac.com',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'Admin@12345',
  adminPin: process.env.ADMIN_PIN ?? '123456',
  adminName: process.env.ADMIN_NAME ?? 'System Admin',
  /** Window for login/check-in device or IP conflict detection (default 24h). */
  deviceConflictWindowMs: Number(
    process.env.DEVICE_CONFLICT_WINDOW_MS ?? 24 * 60 * 60 * 1000,
  ),
  /** Outbound email (password reset magic links, etc.). SMTP transport via nodemailer. */
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? (bool(process.env.SMTP_SECURE) ? 465 : 587)),
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    /** Pool connections for throughput; safe to leave on. */
    pool: bool(process.env.SMTP_POOL, true),
  },
  emailFrom: {
    address: process.env.EMAIL_FROM ?? 'jha.piyush@grubpac.com',
    name: process.env.EMAIL_FROM_NAME ?? 'Grubpac Attendance',
  },
  /** Lifetime of a password-reset magic link (default 5 minutes). */
  passwordResetExpiresMs: Number(process.env.PASSWORD_RESET_EXPIRES_MS ?? 5 * 60 * 1000),
  defaultOffice: {
    name: process.env.DEFAULT_OFFICE_NAME ?? 'Grubpac Technologies - Jhandewalan Office',
    /** Jhandewalan, New Delhi — not Bangalore (legacy placeholder caused ~1740 km geofence misses). */
    latitude: Number(process.env.DEFAULT_OFFICE_LAT ?? 28.647284),
    longitude: Number(process.env.DEFAULT_OFFICE_LNG ?? 77.202835),
    radiusMeters: Number(process.env.DEFAULT_OFFICE_RADIUS_METERS ?? 100),
    maxAccuracyMeters: Number(process.env.DEFAULT_MAX_ACCURACY_METERS ?? 100),
    officeStartTime: process.env.DEFAULT_OFFICE_START_TIME ?? '09:00',
    officeEndTime: process.env.DEFAULT_OFFICE_END_TIME ?? '17:00',
    graceThresholdTime: process.env.DEFAULT_WARNING_THRESHOLD_TIME ?? '09:00',
    halfDayThresholdTime: process.env.DEFAULT_HALF_DAY_THRESHOLD_TIME ?? '10:00',
    warningsPerQuarter: Number(process.env.DEFAULT_WARNINGS_PER_QUARTER ?? 3),
  },
};
