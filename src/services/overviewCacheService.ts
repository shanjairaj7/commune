import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

const CACHE_TTL = 120; // 2 minutes in seconds
const CACHE_PREFIX = 'overview:';

interface OverviewCacheData {
  metrics: any;
  alerts: any[];
  events: any[];
  inboxes: any[];
  inbox_count: number;
}

/**
 * Get cached overview data from Redis
 */
const getCachedOverview = async (
  domainId: string,
  inboxId: string,
  timeWindow: string
): Promise<OverviewCacheData | null> => {
  const redis = getRedisClient();
  if (!redis) return null;

  const key = `${CACHE_PREFIX}${domainId}:${inboxId}:${timeWindow}`;
  try {
    const cached = await redis.get(key);
    if (cached) {
      logger.info('Overview cache hit', { domainId, inboxId, timeWindow });
      return JSON.parse(cached);
    }
    logger.info('Overview cache miss', { domainId, inboxId, timeWindow });
    return null;
  } catch (error) {
    logger.error('Error reading overview cache', { error, key });
    return null;
  }
};

/**
 * Store overview data in Redis with TTL
 */
const setCachedOverview = async (
  domainId: string,
  inboxId: string,
  timeWindow: string,
  data: OverviewCacheData
): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) return;

  const key = `${CACHE_PREFIX}${domainId}:${inboxId}:${timeWindow}`;
  try {
    await redis.setex(key, CACHE_TTL, JSON.stringify(data));
    logger.info('Overview cached', { domainId, inboxId, timeWindow, ttl: CACHE_TTL });
  } catch (error) {
    logger.error('Error writing overview cache', { error, key });
  }
};

/**
 * Invalidate all overview cache entries for a domain
 * Called when new messages/events are inserted
 */
const invalidateDomainCache = async (domainId: string): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const pattern = `${CACHE_PREFIX}${domainId}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info('Invalidated overview cache for domain', { domainId, count: keys.length });
    }
  } catch (error) {
    logger.error('Error invalidating domain cache', { error, domainId });
  }
};

/**
 * Invalidate all overview cache entries for a specific inbox
 * More granular than domain-level invalidation
 */
const invalidateInboxCache = async (domainId: string, inboxId: string): Promise<void> => {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const pattern = `${CACHE_PREFIX}${domainId}:${inboxId}:*`;
    const allPattern = `${CACHE_PREFIX}${domainId}:all:*`;
    
    const [inboxKeys, allKeys] = await Promise.all([
      redis.keys(pattern),
      redis.keys(allPattern),
    ]);
    
    const keysToDelete = [...inboxKeys, ...allKeys];
    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
      logger.info('Invalidated overview cache for inbox', { domainId, inboxId, count: keysToDelete.length });
    }
  } catch (error) {
    logger.error('Error invalidating inbox cache', { error, domainId, inboxId });
  }
};

export default {
  getCachedOverview,
  setCachedOverview,
  invalidateDomainCache,
  invalidateInboxCache,
};
