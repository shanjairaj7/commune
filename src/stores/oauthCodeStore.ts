import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { getCollection } from '../db';
import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

export interface OAuthCode {
  id: string;            // internal ID
  requestId: string;     // "otpreq_" + 16-byte hex — returned to integrator
  codeHash: string;      // HMAC of the 6-digit OTP — never stored in plain text
  agentEmail: string;    // The Commune email the code was sent to
  agentId: string;       // Resolved agent identity ID
  orgId: string;         // Agent's org ID
  clientId: string;      // The OAuth client (integrator) that requested this
  used: boolean;         // Single-use enforcement
  expiresAt: Date;       // 10 minutes from creation (TTL index auto-deletes)
  createdAt: string;
  ipAddress?: string;
}

const COLLECTION = 'oauth_codes';
const CODE_TTL_MS = 10 * 60 * 1000;             // 10 minutes
const HMAC_SECRET = process.env.API_KEY_HMAC_SECRET;

// Rate limit: max 3 OTP sends per email per 15 minutes (Redis-backed)
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

function hashCode(code: string): string {
  if (!HMAC_SECRET) throw new Error('API_KEY_HMAC_SECRET not configured');
  return createHmac('sha256', HMAC_SECRET).update(code).digest('hex');
}

function verifyCode(code: string, storedHash: string): boolean {
  if (!HMAC_SECRET) return false;
  try {
    const expected = hashCode(code);
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export class OAuthCodeStore {
  /**
   * Check if this email has hit the rate limit for OTP sends.
   * Uses Redis when available, MongoDB fallback otherwise.
   * Returns true if rate-limited (caller should reject the request).
   */
  static async isRateLimited(agentEmail: string, clientId: string): Promise<boolean> {
    const redis = getRedisClient();
    const key = `oauth:sendrate:${agentEmail}:${clientId}`;

    if (redis) {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.pexpire(key, RATE_LIMIT_WINDOW_MS);
      }
      return current > RATE_LIMIT_MAX;
    }

    // MongoDB fallback: count sends in the window
    const collection = await getCollection<OAuthCode>(COLLECTION);
    if (!collection) return false;
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
    const count = await collection.countDocuments({
      agentEmail,
      clientId,
      createdAt: { $gte: since.toISOString() },
    });
    return count >= RATE_LIMIT_MAX;
  }

  /**
   * Create a new OTP code record. Returns the plain-text 6-digit code (for sending in email).
   * The code is hashed before storage — never stored in plain text.
   */
  static async create(data: {
    agentEmail: string;
    agentId: string;
    orgId: string;
    clientId: string;
    ipAddress?: string;
  }): Promise<{ requestId: string; plainCode: string }> {
    const collection = await getCollection<OAuthCode>(COLLECTION);
    if (!collection) throw new Error('Database not available');

    // Generate a cryptographically random 6-digit OTP (padded, not truly random 0-999999
    // but using proper randomness — bias is negligible for OTP purposes)
    const rawBytes = randomBytes(3);
    const num = (rawBytes[0] << 16 | rawBytes[1] << 8 | rawBytes[2]) % 1_000_000;
    const plainCode = num.toString().padStart(6, '0');

    const requestId = 'otpreq_' + randomBytes(16).toString('hex');
    const codeHash = hashCode(plainCode);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    const record: OAuthCode = {
      id: 'oauthcode_' + randomBytes(8).toString('hex'),
      requestId,
      codeHash,
      agentEmail: data.agentEmail,
      agentId: data.agentId,
      orgId: data.orgId,
      clientId: data.clientId,
      used: false,
      expiresAt,
      createdAt: new Date().toISOString(),
      ipAddress: data.ipAddress,
    };

    await collection.insertOne(record);
    logger.info('OAuth OTP created', {
      requestId,
      agentEmail: data.agentEmail,
      clientId: data.clientId,
      expiresAt: expiresAt.toISOString(),
    });
    return { requestId, plainCode };
  }

  /**
   * Verify and consume an OTP.
   * Returns the code record on success, null if not found / expired / already used / wrong code.
   * Atomically marks the code as used on success (single-use enforcement).
   */
  static async verifyAndConsume(
    requestId: string,
    plainCode: string,
    clientId: string
  ): Promise<OAuthCode | null> {
    const collection = await getCollection<OAuthCode>(COLLECTION);
    if (!collection) return null;

    // Find the pending code — must match requestId + clientId + not yet used + not expired
    const record = await collection.findOne({
      requestId,
      clientId,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      logger.warn('OAuth OTP not found or expired', { requestId, clientId });
      return null;
    }

    // Verify the OTP (constant-time comparison via HMAC)
    if (!verifyCode(plainCode, record.codeHash)) {
      logger.warn('OAuth OTP verification failed — wrong code', { requestId, agentEmail: record.agentEmail });
      return null;
    }

    // Atomically mark as used — findOneAndUpdate with used:false guard prevents double-use
    const updated = await collection.findOneAndUpdate(
      { requestId, used: false },
      { $set: { used: true } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      // Race condition: another request consumed the code first
      logger.warn('OAuth OTP double-use attempt detected', { requestId });
      return null;
    }

    return updated;
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<OAuthCode>(COLLECTION);
    if (!collection) return;
    // TTL index — MongoDB auto-deletes expired codes
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ requestId: 1 }, { unique: true });
    await collection.createIndex({ agentEmail: 1, clientId: 1, createdAt: -1 });
    await collection.createIndex({ clientId: 1 });
  }
}
