import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { getCollection } from '../db';
import logger from '../utils/logger';

export interface OAuthRefreshToken {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  agentEmail: string;
  agentId: string;
  orgId: string;
  clientId: string;
  scope: string;
  expiresAt: Date;       // 30 days (TTL index auto-deletes)
  revokedAt?: string;
  replacedByToken?: string; // set on rotation — links old → new token
  createdAt: string;
}

const COLLECTION = 'oauth_refresh_tokens';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HMAC_SECRET = process.env.API_KEY_HMAC_SECRET;

function hashToken(token: string): string {
  if (!HMAC_SECRET) throw new Error('API_KEY_HMAC_SECRET not configured');
  return createHmac('sha256', HMAC_SECRET).update(token).digest('hex');
}

function verifyToken(token: string, storedHash: string): boolean {
  if (!HMAC_SECRET) return false;
  try {
    const expected = hashToken(token);
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export class OAuthRefreshTokenStore {
  static async create(data: {
    agentEmail: string;
    agentId: string;
    orgId: string;
    clientId: string;
    scope?: string;
  }): Promise<string> {
    const collection = await getCollection<OAuthRefreshToken>(COLLECTION);
    if (!collection) throw new Error('Database not available');

    const plainToken = 'comm_refresh_' + randomBytes(32).toString('hex');
    const tokenHash = hashToken(plainToken);
    const tokenPrefix = plainToken.substring(0, 25); // "comm_refresh_" + 12 chars

    const record: OAuthRefreshToken = {
      id: 'oauthrt_' + randomBytes(8).toString('hex'),
      tokenHash,
      tokenPrefix,
      agentEmail: data.agentEmail,
      agentId: data.agentId,
      orgId: data.orgId,
      clientId: data.clientId,
      scope: data.scope || 'identity',
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      createdAt: new Date().toISOString(),
    };

    await collection.insertOne(record);
    return plainToken;
  }

  /**
   * Validate a refresh token.
   * Returns the record if valid and active, null otherwise.
   */
  static async validate(
    plainToken: string,
    clientId: string
  ): Promise<OAuthRefreshToken | null> {
    const collection = await getCollection<OAuthRefreshToken>(COLLECTION);
    if (!collection) return null;

    const prefix = plainToken.substring(0, 25);
    const record = await collection.findOne({
      tokenPrefix: prefix,
      clientId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    });

    if (!record) return null;
    if (!verifyToken(plainToken, record.tokenHash)) return null;
    return record;
  }

  /**
   * Rotate a refresh token: mark old one as used, issue a new one.
   * Returns the new plain-text token.
   */
  static async rotate(
    oldPlainToken: string,
    clientId: string
  ): Promise<{ newToken: string; record: OAuthRefreshToken } | null> {
    const old = await OAuthRefreshTokenStore.validate(oldPlainToken, clientId);
    if (!old) return null;

    // Issue new token first (so we don't leave a gap if creation fails)
    const newPlainToken = await OAuthRefreshTokenStore.create({
      agentEmail: old.agentEmail,
      agentId: old.agentId,
      orgId: old.orgId,
      clientId: old.clientId,
      scope: old.scope,
    });

    // Atomically revoke the old token and link to the new one
    const collection = await getCollection<OAuthRefreshToken>(COLLECTION);
    if (collection) {
      await collection.updateOne(
        { tokenPrefix: oldPlainToken.substring(0, 25) },
        {
          $set: {
            revokedAt: new Date().toISOString(),
            replacedByToken: newPlainToken.substring(0, 25),
          },
        }
      );
    }

    // Fetch the newly created record
    const newPrefix = newPlainToken.substring(0, 25);
    const newRecord = await collection?.findOne({ tokenPrefix: newPrefix }) ?? null;
    logger.info('OAuth refresh token rotated', { agentId: old.agentId, clientId });
    return newRecord ? { newToken: newPlainToken, record: newRecord } : null;
  }

  static async revokeAllForAgent(agentId: string, clientId?: string): Promise<void> {
    const collection = await getCollection<OAuthRefreshToken>(COLLECTION);
    if (!collection) return;
    const filter: Record<string, unknown> = {
      agentId,
      revokedAt: { $exists: false },
    };
    if (clientId) filter.clientId = clientId;
    await collection.updateMany(filter, { $set: { revokedAt: new Date().toISOString() } });
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<OAuthRefreshToken>(COLLECTION);
    if (!collection) return;
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ tokenPrefix: 1 });
    await collection.createIndex({ agentId: 1, clientId: 1 });
    await collection.createIndex({ clientId: 1 });
  }
}
