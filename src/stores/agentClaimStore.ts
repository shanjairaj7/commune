import { randomBytes } from 'crypto';
import { getCollection } from '../db';
import type { AgentClaimToken } from '../types/auth';

const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AgentClaimStore {
  static async create(data: {
    agentId: string;
    orgId: string;
    ownerEmail: string;
    agentName: string;
    agentPurpose: string;
    inboxEmail: string;
  }): Promise<AgentClaimToken> {
    const collection = await getCollection<AgentClaimToken>('agent_claim_tokens');
    if (!collection) throw new Error('Database not available');

    const claimToken: AgentClaimToken = {
      id: randomBytes(16).toString('hex'),
      token: randomBytes(32).toString('hex'),
      ...data,
      status: 'pending',
      expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await collection.insertOne(claimToken);
    return claimToken;
  }

  static async findByToken(token: string): Promise<AgentClaimToken | null> {
    const collection = await getCollection<AgentClaimToken>('agent_claim_tokens');
    if (!collection) return null;
    return collection.findOne({ token, status: 'pending' });
  }

  static async findPendingByAgentId(agentId: string): Promise<AgentClaimToken | null> {
    const collection = await getCollection<AgentClaimToken>('agent_claim_tokens');
    if (!collection) return null;
    return collection.findOne({ agentId, status: 'pending' });
  }

  static async markAccepted(id: string): Promise<boolean> {
    const collection = await getCollection<AgentClaimToken>('agent_claim_tokens');
    if (!collection) return false;
    const result = await collection.updateOne(
      { id, status: 'pending' },
      { $set: { status: 'accepted', acceptedAt: new Date().toISOString() } }
    );
    return result.modifiedCount > 0;
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<AgentClaimToken>('agent_claim_tokens');
    if (collection) {
      await collection.createIndex({ token: 1 }, { unique: true });
      await collection.createIndex({ agentId: 1, status: 1 });
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
  }
}
