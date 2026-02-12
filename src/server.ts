import 'dotenv/config';
import express from 'express';
import healthRoutes from './routes/health';
import webhookRoutes from './routes/webhooks';
import domainRoutes from './routes/dashboard/domains';
import inboxRoutes from './routes/dashboard/inboxes';
import messageRoutes from './routes/dashboard/messages';
import authRoutes from './routes/dashboard/auth';
import apiKeyRoutes from './routes/dashboard/apiKeys';
import organizationRoutes from './routes/dashboard/organizations';
import adminRoutes from './routes/dashboard/admin';
import searchRoutes from './routes/dashboard/search';
import spamRoutes from './routes/dashboard/spam';
import attachmentRoutes from './routes/dashboard/attachments';
import v1Routes from './routes/v1/index';
import unsubscribeRoutes from './routes/v1/unsubscribe';
import startup from './startup';
import { combinedAuth } from './middleware/combinedAuth';
import { jwtAuth } from './middleware/jwtAuth';
import { attachApiContext } from './middleware/attachApiContext';
import { errorHandler } from './middleware/errorHandler';
import { auditLog } from './middleware/auditLog';
import { securityHeaders, requestId, extraSecurityHeaders } from './middleware/securityHeaders';
import logger from './utils/logger';
import { getRedisClient } from './lib/redis';
import { validateSecurityConfig } from './boot/securityBootstrap';
import { ensureEncryptionKeyIntegrity } from './lib/encryptionKeyGuard';
import webhookDeliveryService from './services/webhookDeliveryService';
import realtimeService from './services/realtimeService';
import { runAllIndexCreation } from './boot/ensureIndexes';

// ─── Security Bootstrap ────────────────────────────────────────
const securityCheck = validateSecurityConfig();
if (securityCheck.errors.length > 0 && process.env.NODE_ENV === 'production') {
  logger.error('FATAL: Security configuration errors in production', { errors: securityCheck.errors });
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8000;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001').split(',');

app.set('trust proxy', 1);
app.disable('x-powered-by');

logger.info('Email server starting', { port: PORT, nodeEnv: process.env.NODE_ENV, encryptionEnabled: securityCheck.encryptionEnabled });

// ─── CORS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.map((value) => value.trim()).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Upgrade');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// ─── Security Headers & Audit ────────────────────────────────────
app.use(requestId);
app.use(securityHeaders);
app.use(extraSecurityHeaders);
app.use(auditLog);

// ─── Public routes (no auth, no JSON parser) ─────────────────────
app.use(healthRoutes);
app.use('/unsubscribe', unsubscribeRoutes);

// Webhook route mounted BEFORE JSON parser to preserve raw body for Svix verification
app.use('/api/webhooks/resend', webhookRoutes);

// ─── JSON parser for all remaining routes ────────────────────────
app.use(express.json({ limit: '10mb' }));

// ─── Auth routes ─────────────────────────────────────────────────
app.use(authRoutes);
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);

// ─── Organization & API key management ───────────────────────────
app.use('/api/organizations', organizationRoutes);
app.use('/api/api-keys', apiKeyRoutes);

// ─── Dashboard API (JWT or API key auth) ─────────────────────────
app.use('/api', combinedAuth, attachApiContext, domainRoutes);
app.use('/api', combinedAuth, attachApiContext, inboxRoutes);
app.use('/api', combinedAuth, attachApiContext, messageRoutes);
app.use('/api/search', combinedAuth, attachApiContext, searchRoutes);
app.use('/api/attachments', combinedAuth, attachApiContext, attachmentRoutes);
app.use('/api/spam', combinedAuth, attachApiContext, spamRoutes);
app.use('/api/admin', jwtAuth, adminRoutes);

// ─── Public API v1 (API key auth only) ──────────────────────────
app.use('/v1', v1Routes);

// ─── Error handler (must be last) ───────────────────────────────
app.use(errorHandler);

// ─── Start server ───────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  logger.info('Server listening', { port: PORT });

  // Attach WebSocket server for real-time notifications
  realtimeService.attachToServer(httpServer);

  // Encryption key guard — fatal if the key changed unexpectedly
  ensureEncryptionKeyIntegrity()
    .then(() => logger.info('Encryption key guard passed'))
    .catch((err) => {
      logger.error('Encryption key guard failed — shutting down', { error: err?.message || err });
      process.exit(1);
    });

  // Initialize monitoring and metrics scheduler
  startup.initializeMonitoring();

  // Initialize Redis (non-blocking)
  try {
    const redis = getRedisClient();
    if (redis) {
      logger.info('Redis client initialized');
    } else {
      logger.warn('Redis not configured — rate limiting will use in-memory fallback');
    }
  } catch (err) {
    logger.error('Redis initialization failed', { error: err });
  }

  // Run all database index creation in parallel (non-blocking)
  runAllIndexCreation().catch((err) => {
    logger.error('Index creation batch failed', { error: err });
  });

  // Start webhook delivery retry worker
  webhookDeliveryService.startRetryWorker();
  logger.info('Webhook delivery retry worker started');
});
