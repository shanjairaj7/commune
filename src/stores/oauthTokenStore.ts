import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { getCollection } from '../db';
import logger from '../utils/logger';

export interface OAuthToken {
  id: string;            // internal ID
  tokenHash: string;     // HMAC of the access token — never stored plain text
  tokenPrefix: string;   // First 20 chars — fast lookup index
  agentEmail: string;
  agentId: string;
  orgId: string;
  clientId: string;
  scope: string;
  expiresAt: Date;       // 1 hour from creation (TTL index auto-deletes)
  revokedAt?: string;
  createdAt: string;
}

const COLLECTION = 'oauth_tokens';
const TOKEN_TTL_MS = 60 * 60 * 1000;  // 1 hour
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

export class OAuthTokenStore {
  /**
   * Issue a new access token. Returns the plain-text token (for sending to the integrator).
   * Token is hashed before storage.
   */
  static async create(data: {
    agentEmail: string;
    agentId: string;
    orgId: string;
    clientId: string;
    scope?: string;
  }): Promise<{ token: string; record: OAuthToken }> {
    const collection = await getCollection<OAuthToken>(COLLECTION);
    if (!collection) throw new Error('Database not available');

    const plainToken = 'comm_oauth_' + randomBytes(32).toString('hex');
    const tokenHash = hashToken(plainToken);
    const tokenPrefix = plainToken.substring(0, 20); // "comm_oauth_" + 9 chars
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const record: OAuthToken = {
      id: 'oauthtoken_' + randomBytes(8).toString('hex'),
      tokenHash,
      tokenPrefix,
      agentEmail: data.agentEmail,
      agentId: data.agentId,
      orgId: data.orgId,
      clientId: data.clientId,
      scope: data.scope || 'identity',
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    await collection.insertOne(record);
    return { token: plainToken, record };
  }

  /**
   * Validate an access token. Returns the record if valid and not revoked/expired, null otherwise.
   */
  static async validate(plainToken: string): Promise<OAuthToken | null> {
    const collection = await getCollection<OAuthToken>(COLLECTION);
    if (!collection) return null;

    const prefix = plainToken.substring(0, 20);
    const record = await collection.findOne({
      tokenPrefix: prefix,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    });

    if (!record) return null;
    if (!verifyToken(plainToken, record.tokenHash)) return null;
    return record;
  }

  /**
   * Revoke a specific token (agent or integrator initiated).
   */
  static async revoke(plainToken: string): Promise<boolean> {
    const collection = await getCollection<OAuthToken>(COLLECTION);
    if (!collection) return false;

    const prefix = plainToken.substring(0, 20);
    const record = await collection.findOne({ tokenPrefix: prefix });
    if (!record) return false;
    if (!verifyToken(plainToken, record.tokenHash)) return false;

    const result = await collection.updateOne(
      { tokenPrefix: prefix },
      { $set: { revokedAt: new Date().toISOString() } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Revoke all active tokens for a given agent + client pair.
   * Used when Commune suspends an agent or the integrator disconnects an agent.
   */
  static async revokeAllForAgent(agentId: string, clientId?: string): Promise<number> {
    const collection = await getCollection<OAuthToken>(COLLECTION);
    if (!collection) return 0;

    const filter: Record<string, unknown> = {
      agentId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    };
    if (clientId) filter.clientId = clientId;

    const result = await collection.updateMany(filter, {
      $set: { revokedAt: new Date().toISOString() },
    });
    logger.info('OAuth tokens revoked for agent', { agentId, clientId, count: result.modifiedCount });
    return result.modifiedCount;
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<OAuthToken>(COLLECTION);
    if (!collection) return;
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ tokenPrefix: 1 });
    await collection.createIndex({ agentId: 1, clientId: 1 });
    await collection.createIndex({ clientId: 1 });
  }
}
