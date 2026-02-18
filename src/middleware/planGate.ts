import { Request, Response, NextFunction } from 'express';
import { getOrgTierLimits, hasFeature, TierType, TierLimits } from '../config/rateLimits';
import { OrganizationService } from '../services/organizationService';
import domainStore from '../stores/domainStore';
import { DEFAULT_DOMAIN_ID } from '../config/freeTierConfig';
import logger from '../utils/logger';

interface GatedRequest extends Request {
  orgId?: string;
  user?: { orgId?: string };
  apiKey?: { orgId?: string };
}

const getOrgId = (req: GatedRequest): string | null => {
  return req.orgId || req.user?.orgId || req.apiKey?.orgId || null;
};

/**
 * Middleware factory that checks if the org's plan includes a specific feature.
 * Returns 403 with upgrade message if the feature is not available.
 */
export const requireFeature = (feature: keyof TierLimits['features']) => {
  return async (req: GatedRequest, res: Response, next: NextFunction) => {
    const orgId = getOrgId(req);
    if (!orgId) {
      return res.status(401).json({ error: 'Organization not found' });
    }

    try {
      const org = await OrganizationService.getOrganization(orgId);
      if (!org) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      const tier = (org.tier || 'free') as TierType;

      if (!hasFeature(tier, feature)) {
        logger.info('Feature gated', { orgId, feature, tier });
        return res.status(403).json({
          error: `This feature requires a paid plan`,
          feature,
          current_tier: tier,
          required_tier: getMinimumTierForFeature(feature),
          upgrade_url: '/dashboard/billing',
        });
      }

      return next();
    } catch (error) {
      logger.error('Plan gate check failed', { orgId, feature, error });
      return next();
    }
  };
};

/**
 * Middleware that checks if the org has enough attachment storage remaining.
 */
export const requireStorageQuota = (bytesNeeded: number) => {
  return async (req: GatedRequest, res: Response, next: NextFunction) => {
    const orgId = getOrgId(req);
    if (!orgId) return next();

    try {
      const org = await OrganizationService.getOrganization(orgId);
      if (!org) return next();

      const tier = (org.tier || 'free') as TierType;
      const limits = getOrgTierLimits(tier);
      const used = org.attachment_storage_used_bytes || 0;

      if (limits.attachmentStorageBytes !== Infinity && used + bytesNeeded > limits.attachmentStorageBytes) {
        const limitMB = Math.round(limits.attachmentStorageBytes / (1024 * 1024));
        const usedMB = Math.round(used / (1024 * 1024));
        return res.status(413).json({
          error: `Attachment storage limit exceeded`,
          used_mb: usedMB,
          limit_mb: limitMB,
          current_tier: tier,
          upgrade_url: '/dashboard/billing',
        });
      }

      return next();
    } catch (error) {
      logger.error('Storage quota check failed', { orgId, error });
      return next();
    }
  };
};

/**
 * Middleware that checks custom domain count limits per tier.
 */
export const requireDomainQuota = async (req: GatedRequest, res: Response, next: NextFunction) => {
  const orgId = getOrgId(req);
  if (!orgId) return next();

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) return next();

    const tier = (org.tier || 'free') as TierType;
    const limits = getOrgTierLimits(tier);

    if (limits.maxCustomDomains === 0) {
      return res.status(403).json({
        error: 'Custom domains require a paid plan',
        current_tier: tier,
        upgrade_url: '/dashboard/billing',
      });
    }

    return next();
  } catch (error) {
    logger.error('Domain quota check failed', { orgId, error });
    return next();
  }
};

/**
 * Middleware that checks total inbox count against the tier's maxInboxes limit.
 * This is an absolute cap (not a rate limit) — e.g. free tier can only ever have 2 inboxes.
 */
export const requireInboxQuota = async (req: GatedRequest, res: Response, next: NextFunction) => {
  const orgId = getOrgId(req);
  if (!orgId) return next();

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) return next();

    const tier = (org.tier || 'free') as TierType;
    const limits = getOrgTierLimits(tier);

    if (limits.maxInboxes === Infinity) return next();

    // Count total inboxes across all domains for this org
    const orgDomains = await domainStore.listDomains(orgId);
    let totalInboxes = 0;

    for (const domain of orgDomains) {
      const inboxes = await domainStore.listInboxes(domain.id, orgId);
      totalInboxes += inboxes.length;
    }

    // Also count inboxes on the shared default domain (if not already included)
    const orgDomainIds = new Set(orgDomains.map(d => d.id));
    if (!orgDomainIds.has(DEFAULT_DOMAIN_ID)) {
      const defaultInboxes = await domainStore.listInboxes(DEFAULT_DOMAIN_ID, orgId);
      totalInboxes += defaultInboxes.length;
    }

    if (totalInboxes >= limits.maxInboxes) {
      logger.info('Inbox quota reached', { orgId, tier, totalInboxes, limit: limits.maxInboxes });
      return res.status(403).json({
        error: `Inbox limit reached (${totalInboxes}/${limits.maxInboxes}). Upgrade your plan to create more inboxes.`,
        current_count: totalInboxes,
        limit: limits.maxInboxes,
        current_tier: tier,
        upgrade_url: '/dashboard/billing',
      });
    }

    return next();
  } catch (error) {
    logger.error('Inbox quota check failed', { orgId, error });
    return next();
  }
};

function getMinimumTierForFeature(feature: keyof TierLimits['features']): string {
  const tiers: TierType[] = ['free', 'agent_pro', 'business', 'enterprise'];
  for (const tier of tiers) {
    if (hasFeature(tier, feature)) return tier;
  }
  return 'enterprise';
}
