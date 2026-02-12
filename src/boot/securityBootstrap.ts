/**
 * Security Bootstrap — validates critical environment variables at startup.
 * Prevents the server from running in an insecure configuration.
 */
import crypto from 'crypto';
import logger from '../utils/logger';

const INSECURE_JWT_SECRETS = [
  'fallback-secret-change-in-production',
  'your-super-secret-jwt-key-change-in-production',
  'secret',
  'jwt-secret',
  'changeme',
];

export interface SecurityBootstrapResult {
  encryptionEnabled: boolean;
  warnings: string[];
  errors: string[];
}

export function validateSecurityConfig(): SecurityBootstrapResult {
  const result: SecurityBootstrapResult = {
    encryptionEnabled: false,
    warnings: [],
    errors: [],
  };

  const isProduction = process.env.NODE_ENV === 'production';

  // ─── JWT_SECRET ──────────────────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    const msg = 'JWT_SECRET is not set — authentication tokens cannot be verified securely';
    if (isProduction) {
      result.errors.push(msg);
    } else {
      result.warnings.push(msg);
    }
  } else if (INSECURE_JWT_SECRETS.includes(jwtSecret.toLowerCase())) {
    const msg = 'JWT_SECRET is set to an insecure default value — change it immediately';
    if (isProduction) {
      result.errors.push(msg);
    } else {
      result.warnings.push(msg);
    }
  } else if (jwtSecret.length < 32) {
    result.warnings.push('JWT_SECRET is shorter than 32 characters — consider using a longer secret');
  }

  // ─── EMAIL_ENCRYPTION_KEY ────────────────────────────────────
  const encKey = process.env.EMAIL_ENCRYPTION_KEY;
  if (!encKey) {
    const msg = 'EMAIL_ENCRYPTION_KEY is not set — email content will be stored UNENCRYPTED';
    if (isProduction || process.env.REQUIRE_ENCRYPTION === 'true') {
      result.errors.push(msg);
    } else {
      result.warnings.push(msg);
    }
  } else if (encKey.length !== 64) {
    result.errors.push('EMAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256)');
  } else if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    result.errors.push('EMAIL_ENCRYPTION_KEY must be a valid hex string');
  } else {
    result.encryptionEnabled = true;
  }

  // ─── MONGO_URL ───────────────────────────────────────────────
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) {
    result.errors.push('MONGO_URL is not set — database connection will fail');
  } else if (isProduction && !mongoUrl.startsWith('mongodb+srv://') && !mongoUrl.includes('tls=true') && !mongoUrl.includes('ssl=true')) {
    result.warnings.push('MONGO_URL does not explicitly enable TLS — ensure your MongoDB connection is encrypted in transit');
  }

  // ─── RESEND_API_KEY ──────────────────────────────────────────
  if (!process.env.RESEND_API_KEY) {
    result.warnings.push('RESEND_API_KEY is not set — email sending will fail');
  }

  // ─── Log results ─────────────────────────────────────────────
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      logger.warn(`⚠️  SECURITY: ${w}`);
    }
  }

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      logger.error(`🚨 SECURITY: ${e}`);
    }
  }

  if (result.encryptionEnabled) {
    logger.info('🔒 Email encryption at rest: ENABLED (AES-256-GCM)');
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    logger.info('✅ Security configuration validated — all checks passed');
  }

  return result;
}

/**
 * Generate a cryptographically secure encryption key.
 * Usage: node -e "require('./dist/lib/securityBootstrap').generateEncryptionKey()"
 */
export function generateEncryptionKey(): string {
  const key = crypto.randomBytes(32).toString('hex');
  console.log('\n🔑 Generated EMAIL_ENCRYPTION_KEY:');
  console.log(`   ${key}\n`);
  console.log('   Add this to your .env file:');
  console.log(`   EMAIL_ENCRYPTION_KEY=${key}\n`);
  return key;
}
