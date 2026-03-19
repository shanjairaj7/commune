import { randomBytes } from 'crypto';
import type { Organization } from '../types';
import { getCollection } from '../db';

// 30s TTL org cache — same TTL as tierResolver so tier and org stay in sync
const orgCache = new Map<string, { org: Organization; expiresAt: number }>();
const orgInFlight = new Map<string, Promise<Organization | null>>();
const ORG_CACHE_TTL_MS = 30 * 1000;

export class OrganizationService {
  static async createOrganization(data: {
    name: string;
    slug: string;
    settings?: Organization['settings'];
  }): Promise<Organization> {
    const collection = await getCollection<Organization>('organizations');
    if (!collection) throw new Error('Database not available');

    const existingOrg = await collection.findOne({ slug: data.slug });
    if (existingOrg) {
      throw new Error('Organization slug already exists');
    }

    const org: Organization = {
      id: randomBytes(16).toString('hex'),
      name: data.name,
      slug: data.slug,
      tier: 'free',
      settings: data.settings || {
        emailVerificationRequired: true,
        maxApiKeys: 10,
        maxUsers: 5
      },
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await collection.insertOne(org);
    return org;
  }

  static async getOrganization(id: string): Promise<Organization | null> {
    const cached = orgCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.org;

    const existing = orgInFlight.get(id);
    if (existing) return existing;

    const promise = (async () => {
      const collection = await getCollection<Organization>('organizations');
      if (!collection) return null;
      const org = await collection.findOne({ id, status: 'active' });
      if (org) orgCache.set(id, { org, expiresAt: Date.now() + ORG_CACHE_TTL_MS });
      return org;
    })();

    orgInFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      orgInFlight.delete(id);
    }
  }

  static async getOrganizationBySlug(slug: string): Promise<Organization | null> {
    const collection = await getCollection<Organization>('organizations');
    if (!collection) return null;
    return collection.findOne({ slug, status: 'active' });
  }

  static async updateOrganization(id: string, updates: Partial<Organization>): Promise<Organization | null> {
    const collection = await getCollection<Organization>('organizations');
    if (!collection) return null;

    const result = await collection.findOneAndUpdate(
      { id },
      {
        $set: {
          ...updates,
          updatedAt: new Date().toISOString()
        }
      },
      { returnDocument: 'after' }
    );

    orgCache.delete(id);
    return result;
  }

  static async listOrganizations(): Promise<Organization[]> {
    const collection = await getCollection<Organization>('organizations');
    if (!collection) return [];
    return collection.find({ status: 'active' }).sort({ createdAt: -1 }).toArray();
  }

  /**
   * Find an existing org by wallet address, or auto-provision one.
   * Used by x402 wallet-based auth — the wallet address is the identity.
   *
   * Uses upsert to prevent race conditions: two simultaneous first-time
   * payments from the same wallet will not create duplicate orgs.
   */
  static async findOrCreateByWallet(walletAddress: string): Promise<Organization> {
    // Normalize: lowercase for EVM (0x...), preserve case for Solana (base58)
    const normalized = walletAddress.startsWith('0x') ? walletAddress.toLowerCase() : walletAddress;

    // Validate format
    const isEvm = /^0x[0-9a-f]{40}$/i.test(walletAddress);
    const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    if (!isEvm && !isSolana) {
      throw new Error(`Invalid wallet address format: ${walletAddress.slice(0, 20)}...`);
    }

    const collection = await getCollection<Organization>('organizations');
    if (!collection) throw new Error('Database not available');

    const existing = await collection.findOne({ walletAddress: normalized, status: 'active' });
    if (existing) return existing;

    // Auto-provision via upsert to prevent duplicate orgs from concurrent requests
    const shortAddr = normalized.slice(0, 10);
    const now = new Date().toISOString();
    const result = await collection.findOneAndUpdate(
      { walletAddress: normalized },
      {
        $setOnInsert: {
          id: randomBytes(16).toString('hex'),
          name: `Wallet ${shortAddr}`,
          slug: `wallet-${shortAddr}-${randomBytes(4).toString('hex')}`,
          tier: 'free',
          walletAddress: normalized,
          settings: {
            emailVerificationRequired: false,
            maxApiKeys: 10,
            maxUsers: 1,
          },
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    if (!result) throw new Error('Failed to provision organization for wallet');
    return result;
  }

  static async deactivateOrganization(id: string): Promise<boolean> {
    const collection = await getCollection<Organization>('organizations');
    if (!collection) return false;

    const result = await collection.updateOne(
      { id },
      { $set: { status: 'inactive', updatedAt: new Date().toISOString() } }
    );

    orgCache.delete(id);
    return result.modifiedCount > 0;
  }
}
