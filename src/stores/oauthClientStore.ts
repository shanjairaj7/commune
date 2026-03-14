import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { getCollection } from '../db';
import logger from '../utils/logger';

export interface OAuthClient {
  id: string;                    // "oauthclient_" + 16-byte hex
  clientId: string;              // "comm_client_" + 16-byte hex (public identifier)
  clientSecretHash: string;      // HMAC-SHA256 of clientSecret (never stored in plain text)
  clientSecretPrefix: string;    // First 12 chars — fast lookup index
  name: string;                  // "Artisan AI SDR"
  description?: string;
  websiteUrl?: string;
  logoUrl?: string;
  orgId: string;                 // The Commune org that owns this integration
  status: 'active' | 'suspended' | 'revoked';
  verified: boolean;             // Commune has manually verified this integrator
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const COLLECTION = 'oauth_clients';
const HMAC_SECRET = process.env.API_KEY_HMAC_SECRET;

function hashSecret(secret: string): string {
  if (!HMAC_SECRET) throw new Error('API_KEY_HMAC_SECRET not configured');
  return createHmac('sha256', HMAC_SECRET).update(secret).digest('hex');
}

function verifySecret(secret: string, storedHash: string): boolean {
  if (!HMAC_SECRET) return false;
  try {
    const expected = hashSecret(secret);
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export class OAuthClientStore {
  /**
   * Register a new OAuth integrator. Returns the plain-text clientSecret once — never stored.
   */
  static async create(data: {
    name: string;
    description?: string;
    websiteUrl?: string;
    logoUrl?: string;
    orgId: string;
  }): Promise<{ client: OAuthClient; clientSecret: string }> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) throw new Error('Database not available');

    const clientSecret = 'comm_secret_' + randomBytes(32).toString('hex');
    const clientSecretHash = hashSecret(clientSecret);
    const clientSecretPrefix = clientSecret.substring(0, 20); // "comm_secret_" + 8 chars

    const client: OAuthClient = {
      id: 'oauthclient_' + randomBytes(16).toString('hex'),
      clientId: 'comm_client_' + randomBytes(16).toString('hex'),
      clientSecretHash,
      clientSecretPrefix,
      name: data.name.trim(),
      description: data.description?.trim(),
      websiteUrl: data.websiteUrl?.trim(),
      logoUrl: data.logoUrl?.trim(),
      orgId: data.orgId,
      status: 'active',
      verified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await collection.insertOne(client);
    logger.info('OAuth client registered', { clientId: client.clientId, orgId: data.orgId, name: data.name });
    return { client, clientSecret };
  }

  /**
   * Look up a client by clientId and verify the provided secret.
   * Returns the client on success, null if not found or secret mismatch.
   */
  static async validateCredentials(
    clientId: string,
    clientSecret: string
  ): Promise<OAuthClient | null> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) return null;

    const client = await collection.findOne(
      { clientId, status: 'active' },
      { projection: { clientSecretHash: 1, clientId: 1, id: 1, orgId: 1, name: 1, status: 1, verified: 1, createdAt: 1, updatedAt: 1 } }
    );
    if (!client) return null;
    if (!verifySecret(clientSecret, client.clientSecretHash)) return null;
    return client;
  }

  static async findByClientId(clientId: string): Promise<OAuthClient | null> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) return null;
    return collection.findOne({ clientId, status: 'active' });
  }

  static async findByOrgId(orgId: string): Promise<OAuthClient[]> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) return [];
    return collection
      .find({ orgId }, { projection: { clientSecretHash: 0 } })
      .toArray();
  }

  static async revoke(clientId: string, orgId: string): Promise<boolean> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) return false;
    const result = await collection.updateOne(
      { clientId, orgId },
      { $set: { status: 'revoked', updatedAt: new Date().toISOString() } }
    );
    return result.modifiedCount > 0;
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<OAuthClient>(COLLECTION);
    if (!collection) return;
    await collection.createIndex({ clientId: 1 }, { unique: true });
    await collection.createIndex({ orgId: 1 });
    await collection.createIndex({ clientSecretPrefix: 1 });
    await collection.createIndex({ status: 1 });
  }
}
