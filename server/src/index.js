import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { csrfProtection } from './middleware/csrf.js';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import helpRoutes from './routes/helpRoutes.js';
import salaryRoutes from './routes/salaryRoutes.js';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(requestContextMiddleware);
app.use(cookieParser());
app.use(
  cors({
    origin: env.clientOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 10_000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.get('/api/health', async (req, res) => {
  const checks = {
    api: 'ok',
    mongo: 'unknown',
  };

  try {
    if (mongoose.connection.readyState !== 1) {
      checks.mongo = 'disconnected';
      return res.status(503).json({
        status: 'degraded',
        checks,
        timestamp: new Date().toISOString(),
      });
    }

    await mongoose.connection.db.admin().command({ ping: 1 });
    checks.mongo = 'ok';
  } catch {
    checks.mongo = 'error';
    return res.status(503).json({
      status: 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  }

  res.json({
    status: 'ok',
    checks,
    timestamp: new Date().toISOString(),
    metricsHook: process.env.METRICS_ENDPOINT ?? null,
  });
});

app.use('/api', csrfProtection);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/salary', salaryRoutes);

app.use(errorHandler);

export async function startServer() {
  if (mongoose.connection.readyState === 0) {
    await connectDatabase();
  }
  return new Promise((resolve) => {
    const server = app.listen(env.port, () => {
      console.log(`Server listening on http://localhost:${env.port}`);
      resolve(server);
    });
  });
}

// Skip local listen in tests and on AWS Lambda (handler uses the exported app).
if (process.env.NODE_ENV !== 'test' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
