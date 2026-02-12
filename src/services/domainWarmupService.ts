import { getRedisClient, isRedisAvailable } from '../lib/redis';
import { getCollection } from '../db';
import domainStore from '../stores/domainStore';
import logger from '../utils/logger';

export interface WarmupStatus {
  in_warmup: boolean;
  domain_age_days: number;
  warmup_day: number;
  daily_limit: number;
  sent_today: number;
  remaining_today: number;
  graduated: boolean;
  next_milestone: { day: number; limit: number } | null;
}

class DomainWarmupService {
  private static instance: DomainWarmupService;

  // Standard 14-day warmup schedule used by major ESPs
  private readonly WARMUP_SCHEDULE: Array<{ maxDay: number; dailyLimit: number }> = [
    { maxDay: 2, dailyLimit: 50 },
    { maxDay: 4, dailyLimit: 100 },
    { maxDay: 6, dailyLimit: 250 },
    { maxDay: 8, dailyLimit: 500 },
    { maxDay: 10, dailyLimit: 1000 },
    { maxDay: 12, dailyLimit: 2500 },
    { maxDay: 14, dailyLimit: 5000 },
  ];

  private readonly GRADUATION_DAY = 15;

  private constructor() {}

  public static getInstance(): DomainWarmupService {
    if (!DomainWarmupService.instance) {
      DomainWarmupService.instance = new DomainWarmupService();
    }
    return DomainWarmupService.instance;
  }

  async getWarmupStatus(domainId: string): Promise<WarmupStatus> {
    const domain = await domainStore.getDomain(domainId);

    // If domain not found or no createdAt, treat as graduated (don't block existing domains)
    if (!domain || !domain.createdAt) {
      return {
        in_warmup: false,
        domain_age_days: 999,
        warmup_day: this.GRADUATION_DAY,
        daily_limit: Infinity,
        sent_today: 0,
        remaining_today: Infinity,
        graduated: true,
        next_milestone: null,
      };
    }

    const createdAt = new Date(domain.createdAt);
    const now = new Date();
    const ageMs = now.getTime() - createdAt.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000)) + 1; // Day 1 = first day

    if (ageDays >= this.GRADUATION_DAY) {
      return {
        in_warmup: false,
        domain_age_days: ageDays,
        warmup_day: ageDays,
        daily_limit: Infinity,
        sent_today: 0,
        remaining_today: Infinity,
        graduated: true,
        next_milestone: null,
      };
    }

    // Find current schedule tier
    const currentTier = this.WARMUP_SCHEDULE.find(tier => ageDays <= tier.maxDay);
    const dailyLimit = currentTier?.dailyLimit || this.WARMUP_SCHEDULE[this.WARMUP_SCHEDULE.length - 1].dailyLimit;

    // Find next milestone
    const currentTierIndex = this.WARMUP_SCHEDULE.findIndex(tier => ageDays <= tier.maxDay);
    const nextTier = currentTierIndex >= 0 && currentTierIndex < this.WARMUP_SCHEDULE.length - 1
      ? this.WARMUP_SCHEDULE[currentTierIndex + 1]
      : null;

    const sentToday = await this.getDomainSendCount(domainId);

    return {
      in_warmup: true,
      domain_age_days: ageDays,
      warmup_day: ageDays,
      daily_limit: dailyLimit,
      sent_today: sentToday,
      remaining_today: Math.max(0, dailyLimit - sentToday),
      graduated: false,
      next_milestone: nextTier
        ? { day: (currentTier?.maxDay || 0) + 1, limit: nextTier.dailyLimit }
        : { day: this.GRADUATION_DAY, limit: Infinity },
    };
  }

  async recordDomainSend(domainId: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const key = `warmup:${domainId}:${today}`;

    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        await redis.incr(key);
        // Auto-expire after 48h (covers timezone edge cases)
        await redis.expire(key, 48 * 60 * 60);
        return;
      }
    } catch (err) {
      logger.warn('Warmup Redis error, falling back to MongoDB', { error: err });
    }

    // MongoDB fallback
    try {
      const collection = await getCollection('domain_warmup_counters');
      if (collection) {
        await collection.updateOne(
          { domain_id: domainId, date: today },
          {
            $inc: { count: 1 },
            $set: { updated_at: new Date() },
            $setOnInsert: { domain_id: domainId, date: today, created_at: new Date() },
          },
          { upsert: true }
        );
      }
    } catch (err) {
      logger.error('Warmup MongoDB counter error', { error: err });
    }
  }

  async getDomainSendCount(domainId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const key = `warmup:${domainId}:${today}`;

    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const count = await redis.get(key);
        return parseInt(count || '0', 10);
      }
    } catch (err) {
      // fall through to MongoDB
    }

    // MongoDB fallback
    try {
      const collection = await getCollection('domain_warmup_counters');
      if (collection) {
        const doc = await collection.findOne({ domain_id: domainId, date: today });
        return (doc as any)?.count || 0;
      }
    } catch (err) {
      logger.error('Warmup MongoDB read error', { error: err });
    }

    return 0;
  }

  async isWarmupBypassed(domainId: string): Promise<boolean> {
    try {
      const collection = await getCollection('domain_warmup');
      if (!collection) return false;
      const doc = await collection.findOne({ domain_id: domainId, bypassed: true });
      return !!doc;
    } catch {
      return false;
    }
  }

  async bypassWarmup(domainId: string, reason: string): Promise<void> {
    const collection = await getCollection('domain_warmup');
    if (!collection) return;
    await collection.updateOne(
      { domain_id: domainId },
      { $set: { bypassed: true, bypassed_at: new Date(), reason } },
      { upsert: true }
    );
  }

  async ensureIndexes(): Promise<void> {
    try {
      const warmupCollection = await getCollection('domain_warmup');
      if (warmupCollection) {
        await warmupCollection.createIndex({ domain_id: 1 }, { unique: true });
      }

      const warmupCounters = await getCollection('domain_warmup_counters');
      if (warmupCounters) {
        await warmupCounters.createIndex({ domain_id: 1, date: 1 }, { unique: true });
        // Auto-cleanup old counters after 30 days
        await warmupCounters.createIndex(
          { created_at: 1 },
          { expireAfterSeconds: 30 * 24 * 60 * 60 }
        );
      }
    } catch (err) {
      logger.error('Failed to ensure warmup indexes', { error: err });
    }
  }
}

export default DomainWarmupService;
