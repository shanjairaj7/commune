import { Router, json } from 'express';
import domainService from '../../services/domainService';
import domainStore from '../../stores/domainStore';
import suppressionStore from '../../stores/suppressionStore';
import messageStore from '../../stores/messageStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import monitoringService from '../../services/monitoringService';
import alertService from '../../services/alertService';
import metricsCacheService from '../../services/metricsCacheService';
import metricsScheduler from '../../services/metricsScheduler';
import { domainLimiter } from '../../middleware/rateLimiter';
import logger from '../../utils/logger';
import { OrganizationService } from '../../services/organizationService';
import { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } from '../../config/freeTierConfig';
import type { DomainEntry } from '../../types';

const router = Router();

const stripWebhookFromDomain = (
  domain?: DomainEntry | null
): Omit<DomainEntry, 'webhook'> | null => {
  if (!domain) {
    return null;
  }

  const { webhook, ...rest } = domain;
  return rest;
};

router.post('/domains', domainLimiter, json(), async (req, res) => {
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Block free tier from creating domains
    if (org.tier === 'free') {
      logger.warn('Free tier attempted domain creation', { orgId, orgName: org.name });
      return res.status(403).json({ 
        error: 'Free tier cannot create custom domains. Use shared default domain instead.' 
      });
    }

    const { name, region, capabilities } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: 'Missing domain name' });
    }

    const { data, entry, webhook, error } = await domainService.createDomain({
      name,
      region,
      capabilities,
      orgId,
    });

    if (error) {
      logger.warn('Domain creation failed', { orgId, domainName: name, error });
      return res.status(400).json({ error });
    }

    if (!data) {
      logger.error('Resend did not return domain data', { orgId, domainName: name });
      return res.status(502).json({ error: 'Resend did not return domain data' });
    }

    logger.info('Domain created successfully', { orgId, domainName: name, tier: org.tier });
    return res.json({ data, entry, webhook });
  } catch (err) {
    logger.error('Domain creation exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to create domain' });
  }
});

router.get('/domains', async (req, res) => {
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const org = await OrganizationService.getOrganization(orgId);
  if (!org) {
    return res.status(404).json({ error: 'Organization not found' });
  }

  const domainEntries = await domainStore.listDomains(orgId || undefined);
  const data = domainEntries.map((domain) => stripWebhookFromDomain(domain));

  if (org.tier === 'free') {
    let storedDefault = await domainStore.getDomain(DEFAULT_DOMAIN_ID);
    if (!storedDefault) {
      storedDefault = await domainStore.upsertDomain({
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: 'verified',
        createdAt: new Date().toISOString(),
        inboxes: [],
      });
    }
    const defaultDomain = storedDefault || {
      id: DEFAULT_DOMAIN_ID,
      name: DEFAULT_DOMAIN_NAME,
      status: 'verified',
    };
    const merged = [
      stripWebhookFromDomain(defaultDomain),
      ...data.filter((domain) => domain?.id !== DEFAULT_DOMAIN_ID),
    ];
    return res.json({ data: merged });
  }

  return res.json({ data });
});

router.get('/domains/:domainId', async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const stored = stripWebhookFromDomain(await domainStore.getDomain(domainId));
  if (orgId && stored?.orgId && stored.orgId !== orgId) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  const { data, error } = await domainService.getDomain(domainId);
  if (error) {
    return res.status(400).json({ error });
  }

  return res.json({ data, entry: stored });
});

router.post('/domains/:domainId/verify', async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const stored = await domainStore.getDomain(domainId);
  if (orgId && stored?.orgId && stored.orgId !== orgId) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  const { data, error } = await domainService.verifyDomain(domainId);
  if (error) {
    return res.status(400).json({ error });
  }

  await domainService.refreshDomainRecords(domainId);
  return res.json({ data });
});

router.get('/domains/:domainId/records', async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const stored = await domainStore.getDomain(domainId);
  if (orgId && stored?.orgId && stored.orgId !== orgId) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  const { data, error } = await domainService.getDomain(domainId);
  if (error) {
    return res.status(400).json({ error });
  }

  if (!data) {
    return res.status(404).json({ error: 'Domain not found' });
  }

  return res.json({ data: data.records || [] });
});

router.get('/domains/:domainId/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const stored = await domainStore.getDomain(domainId);
  if (orgId && stored?.orgId && stored.orgId !== orgId) {
    return res.status(404).json({ error: 'Domain not found' });
  }
  const { data, error } = await domainService.getDomain(domainId);
  if (error) {
    return res.status(400).json({ error });
  }

  if (!data) {
    return res.status(404).json({ error: 'Domain not found' });
  }

  return res.json({ data });
});

// Helper function to get date range from period
const getDateRange = (period: string) => {
  const endDate = new Date();
  const startDate = new Date();
  
  switch (period) {
    case '1d':
      startDate.setDate(startDate.getDate() - 1);
      break;
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      break;
    case '90d':
      startDate.setDate(startDate.getDate() - 90);
      break;
    default:
      startDate.setDate(startDate.getDate() - 7);
  }
  
  return { startDate, endDate };
};

// GET /api/domains/:domainId/inboxes/:inboxId/suppressions
router.get('/domains/:domainId/inboxes/:inboxId/suppressions', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  const suppressions = await suppressionStore.getInboxSuppressions(inboxId);
  return res.json({ data: suppressions });
});

// POST /api/domains/:domainId/inboxes/:inboxId/suppressions
router.post('/domains/:domainId/inboxes/:inboxId/suppressions', json(), async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { email, reason, type } = req.body;
  const orgId = (req as any).apiKey?.orgId || null;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  await suppressionStore.addSuppression({
    email,
    reason: reason || 'manual',
    type: type || 'permanent',
    source: 'inbox',
    inbox_id: inboxId,
  });
  
  return res.json({ data: { ok: true } });
});

// GET /api/domains/:domainId/inboxes/:inboxId/metrics
router.get('/domains/:domainId/inboxes/:inboxId/metrics', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { period = '7d' } = req.query;
  const orgId = (req as any).apiKey?.orgId || null;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  const { startDate, endDate } = getDateRange(period as string);
  const metrics = await messageStore.getInboxDeliveryMetrics(inboxId, startDate, endDate);
  
  return res.json({ data: { period, metrics } });
});

// GET /api/domains/:domainId/inboxes/:inboxId/events
router.get('/domains/:domainId/inboxes/:inboxId/events', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { eventType, limit = 50 } = req.query;
  const orgId = (req as any).apiKey?.orgId || null;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  const events = await deliveryEventStore.getInboxEvents(
    inboxId,
    eventType as string,
    Number(limit)
  );
  
  return res.json({ data: events });
});

// GET /api/domains/:domainId/inboxes/:inboxId/monitoring/metrics
router.get('/domains/:domainId/inboxes/:inboxId/monitoring/metrics', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { timeWindow = '24h' } = req.query;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, (req as any).apiKey?.orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  try {
    // Get cached metrics for fast response
    const metrics = await metricsCacheService.getCachedMetrics(inboxId, timeWindow as string);
    return res.json({ data: metrics });
  } catch (error) {
    console.error('Error getting metrics:', error);
    return res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// GET /api/domains/:domainId/inboxes/:inboxId/monitoring/alerts
router.get('/domains/:domainId/inboxes/:inboxId/monitoring/alerts', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { timeWindow = '24h' } = req.query;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, (req as any).apiKey?.orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  try {
    // Calculate alerts on-demand
    const alerts = await alertService.calculateAlerts(inboxId, timeWindow as string);
    return res.json({ data: alerts });
  } catch (error) {
    console.error('Error calculating alerts:', error);
    return res.status(500).json({ error: 'Failed to calculate alerts' });
  }
});

// GET /api/domains/:domainId/inboxes/:inboxId/monitoring/dashboard
router.get('/domains/:domainId/inboxes/:inboxId/monitoring/dashboard', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const { timeWindow = '24h' } = req.query;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, (req as any).apiKey?.orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  try {
    // Get all monitoring data in parallel (with cached metrics)
    const [metrics, alerts, suppressions, recentEvents] = await Promise.all([
      metricsCacheService.getCachedMetrics(inboxId, timeWindow as string),
      alertService.calculateAlerts(inboxId, timeWindow as string),
      suppressionStore.getInboxSuppressions(inboxId),
      deliveryEventStore.getInboxEvents(inboxId, undefined, 50)
    ]);
    
    // Generate recommendations based on metrics and alerts
    const recommendations = generateRecommendations(metrics, alerts);
    
    return res.json({
      data: {
        metrics,
        alerts,
        suppressions,
        recent_events: recentEvents,
        recommendations
      }
    });
  } catch (error) {
    console.error('Error getting dashboard data:', error);
    return res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

// Helper function to generate recommendations
const generateRecommendations = (metrics: any, alerts: any[]): string[] => {
  const recommendations: string[] = [];
  
  if (metrics.bounce_rate > 5) {
    recommendations.push('Consider reviewing email list quality and removing invalid addresses');
  }
  
  if (metrics.complaint_rate > 0.1) {
    recommendations.push('Review email content and ensure proper consent mechanisms');
  }
  
  if (metrics.delivery_rate < 90) {
    recommendations.push('Check domain reputation and sender authentication settings');
  }
  
  if (alerts.length > 3) {
    recommendations.push('Multiple alerts detected - consider immediate investigation');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('All metrics look healthy - continue monitoring');
  }
  
  return recommendations;
}

// GET /api/domains/:domainId/inboxes/:inboxId/monitoring/cache/clear
router.post('/domains/:domainId/inboxes/:inboxId/monitoring/cache/clear', async (req, res) => {
  const { domainId, inboxId } = req.params;
  
  // Verify access
  const inbox = await domainStore.getInbox(domainId, inboxId, (req as any).apiKey?.orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }
  
  try {
    metricsCacheService.clearInboxCache(inboxId);
    return res.json({ data: { message: 'Cache cleared successfully' } });
  } catch (error) {
    console.error('Error clearing cache:', error);
    return res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// GET /api/monitoring/cache/stats
router.get('/monitoring/cache/stats', async (req, res) => {
  try {
    const stats = metricsCacheService.getCacheStats();
    return res.json({ data: stats });
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

export default router;
