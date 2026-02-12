import crypto from 'crypto';
import logger from '../utils/logger';

// Use a separate secret for unsubscribe tokens.
// Falls back to a derivation of JWT_SECRET if UNSUBSCRIBE_SECRET not set.
const deriveUnsubscribeSecret = (): string => {
  if (process.env.UNSUBSCRIBE_SECRET) return process.env.UNSUBSCRIBE_SECRET;

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('FATAL: Neither UNSUBSCRIBE_SECRET nor JWT_SECRET is set. Unsubscribe tokens will be insecure.');
      process.exit(1);
    }
    logger.warn('JWT_SECRET not set — using development-only unsubscribe secret. Do NOT use in production.');
    return crypto.randomBytes(32).toString('hex');
  }

  return crypto.createHash('sha256')
    .update(jwtSecret)
    .update('unsubscribe')
    .digest('hex');
};

const UNSUBSCRIBE_SECRET = deriveUnsubscribeSecret();

export interface UnsubscribePayload {
  orgId: string;
  recipient: string;     // the email address being unsubscribed
  inboxId?: string;       // optional: inbox-level unsubscribe
}

/**
 * Generate an HMAC-signed unsubscribe token.
 * The token contains the payload (base64url) + signature.
 * Tokens do NOT expire — users must always be able to unsubscribe from old emails.
 */
export const generateUnsubscribeToken = (payload: UnsubscribePayload): string => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const signature = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(data)
    .digest('base64url');

  return `${data}.${signature}`;
};

/**
 * Verify an unsubscribe token and extract the payload.
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns null if the token is invalid or tampered.
 */
export const verifyUnsubscribeToken = (token: string): UnsubscribePayload | null => {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, signature] = parts;

  const expectedSig = crypto
    .createHmac('sha256', UNSUBSCRIBE_SECRET)
    .update(data)
    .digest('base64url');

  // Timing-safe comparison — prevent timing side-channel attacks
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);

  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

/**
 * Build the full unsubscribe URL for email headers.
 * Returns empty string if PUBLIC_API_BASE_URL is not configured.
 */
export const buildUnsubscribeUrl = (payload: UnsubscribePayload): string => {
  const baseUrl = process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_WEBHOOK_BASE_URL || '';
  if (!baseUrl) return '';

  const token = generateUnsubscribeToken(payload);
  return `${baseUrl.replace(/\/$/, '')}/unsubscribe?token=${token}`;
};
