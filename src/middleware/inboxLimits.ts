import { Request, Response, NextFunction } from 'express';
import { getOrgTierLimits, TierType } from '../config/rateLimits';
import { OrganizationService } from '../services/organizationService';
import domainStore from '../stores/domainStore';
import { getRedisClient, isRedisAvailable } from '../lib/redis';
import logger from '../utils/logger';

interface LimitedRequest extends Request {
  orgId?: string;
  user?: { orgId?: string };
  apiKey?: { orgId?: string };
}

// In-memory fallback for inbox daily send tracking
const memoryInboxCounts = new Map<string, { count: number; resetAt: number }>();

/**
 * Middleware that enforces per-inbox daily email send limits.
 * Checks both manual per-inbox limits and plan-level defaults.
 */
export const enforceInboxDailyLimit = async (req: LimitedRequest, res: Response, next: NextFunction) => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId;
  if (!orgId) return next();

  // Extract inboxId from body or params
  const inboxId = req.body?.inboxId || req.body?.inbox_id || req.params?.inboxId;
  if (!inboxId) return next();

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) return next();

    const tier = (org.tier || 'free') as TierType;
    const tierLimits = getOrgTierLimits(tier);

    // Enterprise skips inbox limits
    if (tier === 'enterprise') return next();

    // Look up the inbox to check for manual limits
    let inboxLimit = tierLimits.emailsPerInboxPerDay;

    // Try to find inbox-specific manual limits
    try {
      const domains = await domainStore.listDomains(orgId);
      for (const domain of domains) {
        const inbox = domain.inboxes?.find(i => i.id === inboxId);
        if (inbox?.limits?.emailsPerDay) {
          // Manual limit exists — use the LOWER of manual and plan limit
          inboxLimit = Math.min(inbox.limits.emailsPerDay, tierLimits.emailsPerInboxPerDay);
          break;
        }
      }
    } catch {
      // If domain lookup fails, use plan default
    }

    // Check current count
    const key = `rl:inbox:day:${inboxId}`;
    const now = Date.now();
    let currentCount = 0;

    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        currentCount = await redis.incr(key);
        if (currentCount === 1) {
          // Set TTL to end of day (24 hours from now)
          await redis.expire(key, 86400);
        }
      } else {
        throw new Error('Redis unavailable');
      }
    } catch {
      // In-memory fallback
      const entry = memoryInboxCounts.get(key);
      if (entry && entry.resetAt > now) {
        entry.count++;
        currentCount = entry.count;
      } else {
        memoryInboxCounts.set(key, { count: 1, resetAt: now + 86400000 });
        currentCount = 1;
      }
    }

    if (currentCount > inboxLimit) {
      logger.warn('Inbox daily send limit exceeded', {
        orgId,
        inboxId,
        currentCount,
        limit: inboxLimit,
        tier,
      });

      return res.status(429).json({
        error: 'Inbox daily send limit exceeded',
        inbox_id: inboxId,
        current_count: currentCount,
        daily_limit: inboxLimit,
        tier,
      });
    }

    return next();
  } catch (error) {
    logger.error('Inbox limit check failed', { orgId, inboxId, error });
    return next();
  }
};
