import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { getOrgTierLimits, TierType } from '../config/rateLimits';
import { getCollection } from '../db';
import type { Organization } from '../types';
import logger from '../utils/logger';

// In-memory store for rate limiting
// Maps: "orgId:endpoint:window" -> number of requests
const rateLimitStore = new Map<string, Array<{ timestamp: number }>>();

// Cache org tiers in memory to avoid DB lookups on every request.
// TTL: 5 minutes — balance between freshness and performance.
const tierCache = new Map<string, { tier: TierType; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 5 * 60 * 1000;

interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string; role?: string };
  apiKey?: { orgId?: string };
}

// Look up the org's tier from DB with in-memory caching
const getOrgTier = async (req: OrgRequest): Promise<TierType> => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId;
  if (!orgId) return 'free';

  // Check cache
  const cached = tierCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  try {
    const orgs = await getCollection<Organization>('organizations');
    if (orgs) {
      const org = await orgs.findOne({ id: orgId }, { projection: { tier: 1 } });
      const tier: TierType = (org?.tier as TierType) || 'free';
      tierCache.set(orgId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
      return tier;
    }
  } catch (error) {
    logger.warn('Failed to look up org tier, defaulting to free', { orgId, error });
  }

  return 'free';
};

// Custom key generator - uses orgId instead of IP
const orgKeyGenerator = (req: OrgRequest): string => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId || 'anonymous';
  return orgId;
};

// Clean up old timestamps
const cleanOldTimestamps = (key: string, windowMs: number) => {
  const now = Date.now();
  const entries = rateLimitStore.get(key) || [];
  const cleaned = entries.filter((entry) => now - entry.timestamp < windowMs);
  if (cleaned.length === 0) {
    rateLimitStore.delete(key);
  } else {
    rateLimitStore.set(key, cleaned);
  }
};

// Custom store for rate limiting
const createMemoryStore = (windowMs: number, max: number) => ({
  increment: (key: string) => {
    const now = Date.now();
    cleanOldTimestamps(key, windowMs);
    const entries = rateLimitStore.get(key) || [];
    entries.push({ timestamp: now });
    rateLimitStore.set(key, entries);
    return entries.length;
  },
  resetKey: (key: string) => {
    rateLimitStore.delete(key);
  },
  decrement: (key: string) => {
    const entries = rateLimitStore.get(key) || [];
    if (entries.length > 0) {
      entries.pop();
      rateLimitStore.set(key, entries);
    }
  },
});

// Email send rate limiter (most critical)
export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerHour;
  },
  keyGenerator: orgKeyGenerator,
  skip: async (req: any) => {
    // Enterprise tier orgs are not rate-limited for email sending
    const tier = await getOrgTier(req);
    return tier === 'enterprise';
  },
  handler: (req: any, res: Response) => {
    const orgId = orgKeyGenerator(req as OrgRequest);
    res.status(429).json({
      error: 'Rate limit exceeded for email sending',
      retryAfter: req.rateLimit?.resetTime,
      orgId,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Daily email limiter
export const emailDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:daily`,
  skip: async (req: any) => {
    const tier = await getOrgTier(req);
    return tier === 'enterprise';
  },
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Daily email rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Domain creation limiter
export const domainLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).domainsPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:domains`,
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Domain creation rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Inbox creation limiter
export const inboxLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).inboxesPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:inboxes`,
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Inbox creation rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});
