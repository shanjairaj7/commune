import { randomBytes } from 'crypto';
import { getCollection } from '../db';
import type { AgentIdentity, AgentSignatureNonce } from '../types/auth';

const NONCE_TTL_MS = 120_000; // 2 minutes

export class AgentIdentityStore {
  static async create(data: Omit<AgentIdentity, 'id' | 'createdAt' | 'status'>): Promise<AgentIdentity> {
    const collection = await getCollection<AgentIdentity>('agent_identities');
    if (!collection) throw new Error('Database not available');

    const identity: AgentIdentity = {
      id: 'agt_' + randomBytes(16).toString('hex'),
      ...data,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    await collection.insertOne(identity);
    return identity;
  }

  static async findById(id: string): Promise<AgentIdentity | null> {
    const collection = await getCollection<AgentIdentity>('agent_identities');
    if (!collection) return null;
    return collection.findOne({ id, status: 'active' });
  }

  static async findByOrgId(orgId: string): Promise<AgentIdentity[]> {
    const collection = await getCollection<AgentIdentity>('agent_identities');
    if (!collection) return [];
    return collection.find({ orgId }).toArray();
  }

  static async updateLastUsed(id: string): Promise<void> {
    const collection = await getCollection<AgentIdentity>('agent_identities');
    if (!collection) return;
    await collection.updateOne({ id }, { $set: { lastUsedAt: new Date().toISOString() } });
  }

  static async revoke(id: string): Promise<boolean> {
    const collection = await getCollection<AgentIdentity>('agent_identities');
    if (!collection) return false;
    const result = await collection.updateOne(
      { id, status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date().toISOString() } }
    );
    return result.modifiedCount > 0;
  }

  // Replay protection: insert nonce, fail if already seen
  // Returns false if this (agentId, timestampMs) pair was already used (replay)
  static async claimNonce(agentId: string, timestampMs: number): Promise<boolean> {
    const collection = await getCollection<AgentSignatureNonce>('agent_signature_nonces');
    if (!collection) throw new Error('Database not available');

    try {
      await collection.insertOne({
        _id: `${agentId}:${timestampMs}` as any,
        expiresAt: new Date(Date.now() + NONCE_TTL_MS),
      });
      return true; // nonce is fresh, proceed
    } catch (err: any) {
      if (err.code === 11000) return false; // duplicate key = replay
      throw err;
    }
  }

  // Call once on startup to ensure indexes exist
  static async ensureIndexes(): Promise<void> {
    const identityCol = await getCollection<AgentIdentity>('agent_identities');
    const nonceCol = await getCollection<AgentSignatureNonce>('agent_signature_nonces');

    if (identityCol) {
      await identityCol.createIndex({ id: 1 }, { unique: true });
      await identityCol.createIndex({ orgId: 1 });
    }

    if (nonceCol) {
      await nonceCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
  }
}
