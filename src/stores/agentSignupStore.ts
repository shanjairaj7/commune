import { randomBytes } from 'crypto';
import { getCollection } from '../db';
import type { AgentSignup } from '../types/auth';

const SIGNUP_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class AgentSignupStore {
  static async create(data: Omit<AgentSignup, 'id' | 'agentSignupToken' | 'status' | 'expiresAt' | 'createdAt'>): Promise<AgentSignup> {
    const collection = await getCollection<AgentSignup>('agent_signups');
    if (!collection) throw new Error('Database not available');

    const signup: AgentSignup = {
      id: randomBytes(16).toString('hex'),
      agentSignupToken: 'agt_signup_' + randomBytes(24).toString('hex'),
      ...data,
      status: 'pending',
      expiresAt: new Date(Date.now() + SIGNUP_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await collection.insertOne(signup);
    return signup;
  }

  static async findByToken(agentSignupToken: string): Promise<AgentSignup | null> {
    const collection = await getCollection<AgentSignup>('agent_signups');
    if (!collection) return null;
    return collection.findOne({
      agentSignupToken,
      status: 'pending',
      expiresAt: { $gt: new Date().toISOString() },
    });
  }

  static async markVerified(id: string): Promise<void> {
    const collection = await getCollection<AgentSignup>('agent_signups');
    if (!collection) throw new Error('Database not available');
    await collection.updateOne({ id }, { $set: { status: 'verified' } });
  }

  static async ensureIndexes(): Promise<void> {
    const collection = await getCollection<AgentSignup>('agent_signups');
    if (!collection) return;
    await collection.createIndex({ agentSignupToken: 1 }, { unique: true });
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Prevent same public key from being registered in two concurrent pending signups
    await collection.createIndex({ publicKey: 1 }, { unique: true, sparse: true });
  }
}
