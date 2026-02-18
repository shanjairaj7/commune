import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { ApiKey } from '../types';
import { getCollection } from '../db';

export class ApiKeyService {
  private static readonly KEY_PREFIX = 'comm_';
  private static readonly KEY_LENGTH = 32;

  static async generateApiKey(data: {
    orgId: string;
    name: string;
    permissions?: string[];
    expiresIn?: number;
    createdBy: string;
  }): Promise<{ apiKey: string; apiKeyData: ApiKey }> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) throw new Error('Database not available');

    const randomPart = crypto.randomBytes(this.KEY_LENGTH).toString('hex');
    const apiKey = `${this.KEY_PREFIX}${randomPart}`;
    const keyPrefix = apiKey.substring(0, 12);

    const keyHash = await bcrypt.hash(apiKey, 12);

    const expiresAt = data.expiresIn
      ? new Date(Date.now() + data.expiresIn * 1000).toISOString()
      : undefined;

    const apiKeyData: ApiKey = {
      id: crypto.randomBytes(16).toString('hex'),
      orgId: data.orgId,
      name: data.name,
      keyPrefix,
      keyHash,
      permissions: data.permissions || ['read', 'write'],
      status: 'active',
      expiresAt,
      createdBy: data.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await collection.insertOne(apiKeyData);
    return { apiKey, apiKeyData };
  }

  static async validateApiKey(apiKey: string): Promise<{ apiKey: ApiKey; orgId: string } | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const keyPrefix = apiKey.substring(0, 12);

    const potentialKeys = await collection.find({
      keyPrefix,
      status: 'active'
    }).toArray();

    for (const keyRecord of potentialKeys) {
      const isValid = await bcrypt.compare(apiKey, keyRecord.keyHash);
      if (isValid) {
        if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
          await collection.updateOne(
            { id: keyRecord.id },
            { $set: { status: 'expired' } }
          );
          continue;
        }

        await collection.updateOne(
          { id: keyRecord.id },
          { $set: { lastUsedAt: new Date().toISOString() } }
        );

        return { apiKey: keyRecord, orgId: keyRecord.orgId };
      }
    }

    return null;
  }

  static async listApiKeys(orgId: string): Promise<ApiKey[]> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return [];

    return collection.find({ orgId }).sort({ createdAt: -1 }).toArray();
  }

  static async getApiKeyById(id: string): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;
    return collection.findOne({ id });
  }

  static async revokeApiKey(orgId: string, keyId: string): Promise<boolean> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return false;

    const result = await collection.updateOne(
      { id: keyId, orgId },
      { $set: { status: 'inactive', updatedAt: new Date().toISOString() } }
    );

    return result.modifiedCount > 0;
  }

  static async rotateApiKey(orgId: string, keyId: string, createdBy: string): Promise<{ apiKey: string; apiKeyData: ApiKey } | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const existingKey = await collection.findOne({ id: keyId, orgId });
    if (!existingKey) return null;

    const randomPart = crypto.randomBytes(this.KEY_LENGTH).toString('hex');
    const apiKey = `${this.KEY_PREFIX}${randomPart}`;
    const keyPrefix = apiKey.substring(0, 12);
    const keyHash = await bcrypt.hash(apiKey, 12);

    const result = await collection.findOneAndUpdate(
      { id: keyId, orgId },
      {
        $set: {
          keyPrefix,
          keyHash,
          updatedAt: new Date().toISOString()
        }
      },
      { returnDocument: 'after' }
    );

    return result ? { apiKey, apiKeyData: result } : null;
  }

  static async updateApiKey(id: string, updates: Partial<ApiKey>): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const result = await collection.findOneAndUpdate(
      { id },
      { $set: { ...updates, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' }
    );

    return result;
  }

  static async updateApiKeyLimits(
    keyId: string,
    orgId: string,
    limits?: { maxInboxes?: number; maxEmailsPerDay?: number }
  ): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const update: any = limits
      ? { $set: { limits, updatedAt: new Date().toISOString() } }
      : { $unset: { limits: 1 }, $set: { updatedAt: new Date().toISOString() } };

    const result = await collection.findOneAndUpdate(
      { id: keyId, orgId },
      update,
      { returnDocument: 'after' }
    );

    return result;
  }

  static async countApiKeysByOrg(orgId: string): Promise<number> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return 0;
    return collection.countDocuments({ orgId, status: 'active' });
  }
}
