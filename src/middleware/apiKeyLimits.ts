import { Request, Response, NextFunction } from 'express';
import { getRedisClient, isRedisAvailable } from '../lib/redis';
import logger from '../utils/logger';

interface KeyLimitedRequest extends Request {
  apiKey?: {
    orgId?: string;
    id?: string;
    limits?: {
      maxInboxes?: number;
      maxEmailsPerDay?: number;
    };
  };
}

// In-memory fallback
const memoryKeyCounts = new Map<string, { count: number; resetAt: number }>();

/**
 * Middleware that enforces per-API-key daily email send limits.
 */
export const enforceApiKeyEmailLimit = async (req: KeyLimitedRequest, res: Response, next: NextFunction) => {
  const apiKey = req.apiKey;
  if (!apiKey?.id || !apiKey.limits?.maxEmailsPerDay) return next();

  const limit = apiKey.limits.maxEmailsPerDay;
  const key = `rl:apikey:day:${apiKey.id}`;
  const now = Date.now();
  let currentCount = 0;

  try {
    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      currentCount = await redis.incr(key);
      if (currentCount === 1) {
        await redis.expire(key, 86400);
      }
    } else {
      throw new Error('Redis unavailable');
    }
  } catch {
    const entry = memoryKeyCounts.get(key);
    if (entry && entry.resetAt > now) {
      entry.count++;
      currentCount = entry.count;
    } else {
      memoryKeyCounts.set(key, { count: 1, resetAt: now + 86400000 });
      currentCount = 1;
    }
  }

  if (currentCount > limit) {
    logger.warn('API key daily email limit exceeded', {
      apiKeyId: apiKey.id,
      currentCount,
      limit,
    });

    return res.status(429).json({
      error: 'API key daily email send limit exceeded',
      current_count: currentCount,
      daily_limit: limit,
    });
  }

  return next();
};

/**
 * Middleware that enforces per-API-key inbox creation limits.
 * Counts total inboxes created by this API key (stored in Redis or memory).
 */
export const enforceApiKeyInboxLimit = async (req: KeyLimitedRequest, res: Response, next: NextFunction) => {
  const apiKey = req.apiKey;
  if (!apiKey?.id || !apiKey.limits?.maxInboxes) return next();

  const limit = apiKey.limits.maxInboxes;
  const key = `rl:apikey:inboxes:${apiKey.id}`;
  let currentCount = 0;

  try {
    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      currentCount = await redis.incr(key);
      // No TTL — inbox count is cumulative
    } else {
      throw new Error('Redis unavailable');
    }
  } catch {
    const entry = memoryKeyCounts.get(key);
    if (entry) {
      entry.count++;
      currentCount = entry.count;
    } else {
      memoryKeyCounts.set(key, { count: 1, resetAt: Infinity });
      currentCount = 1;
    }
  }

  if (currentCount > limit) {
    logger.warn('API key inbox creation limit exceeded', {
      apiKeyId: apiKey.id,
      currentCount,
      limit,
    });

    return res.status(429).json({
      error: 'API key inbox creation limit exceeded',
      current_count: currentCount - 1,
      max_inboxes: limit,
    });
  }

  return next();
};
