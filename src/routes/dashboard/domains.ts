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
import overviewCacheService from '../../services/overviewCacheService';
import { domainLimiter } from '../../middleware/rateLimiter';
import { getOrgTierLimits, TierType } from '../../config/rateLimits';
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

    // Check tier-based custom domain limits
    const tier = (org.tier || 'free') as TierType;
    const tierLimits = getOrgTierLimits(tier);

    if (tierLimits.maxCustomDomains === 0) {
      logger.warn('Tier does not allow custom domains', { orgId, orgName: org.name, tier });
      return res.status(403).json({ 
        error: 'Your plan does not allow custom domains. Use shared default domain instead.',
        current_tier: tier,
        upgrade_url: '/dashboard/billing',
      });
    }

    // Count existing custom domains for this org
    if (tierLimits.maxCustomDomains !== Infinity) {
      const existingDomains = await domainStore.listDomains(orgId);
      const customDomainCount = existingDomains.filter(d => d.id !== DEFAULT_DOMAIN_ID).length;
      if (customDomainCount >= tierLimits.maxCustomDomains) {
        logger.warn('Custom domain limit reached', { orgId, tier, count: customDomainCount, limit: tierLimits.maxCustomDomains });
        return res.status(403).json({
          error: `Custom domain limit reached (${customDomainCount}/${tierLimits.maxCustomDomains}). Upgrade your plan for more.`,
          current_count: customDomainCount,
          limit: tierLimits.maxCustomDomains,
          current_tier: tier,
          upgrade_url: '/dashboard/billing',
        });
      }
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
    if (storedDefault && storedDefault.name !== DEFAULT_DOMAIN_NAME) {
      storedDefault = await domainStore.upsertDomain({
        ...storedDefault,
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: storedDefault.status || 'verified',
      });
    }
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
    domain_id: domainId,
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
    logger.error('Error getting metrics', { error });
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
    logger.error('Error calculating alerts', { error });
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
    logger.error('Error getting dashboard data', { error });
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
    logger.error('Error clearing cache', { error });
    return res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// ─── Aggregated Overview Endpoint ─────────────────────────────────
// Replaces 3×N per-inbox calls with a single query.
// GET /api/domains/:domainId/overview?timeWindow=24h&inboxId=all
router.get('/domains/:domainId/overview', async (req, res) => {
  const { domainId } = req.params;
  const { timeWindow = '24h', inboxId: inboxFilter = 'all' } = req.query;
  const orgId = (req as any).apiKey?.orgId || null;

  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }

  try {
    // Check Redis cache first (2min TTL)
    const cached = await overviewCacheService.getCachedOverview(
      domainId,
      inboxFilter as string,
      timeWindow as string
    );
    if (cached) {
      return res.json({ data: cached });
    }

    // Cache miss — compute fresh data
    // 1. Resolve inbox IDs in one domain lookup
    const allInboxes = await domainStore.listInboxes(domainId, orgId);
    const inboxList = allInboxes.map((i: any) => ({
      id: i.id, localPart: i.localPart, address: i.address, domainName: i.domainName,
    }));

    if (!allInboxes.length) {
      const emptyData = { metrics: null, alerts: [], events: [], inboxes: [], inbox_count: 0 };
      await overviewCacheService.setCachedOverview(domainId, inboxFilter as string, timeWindow as string, emptyData);
      return res.json({ data: emptyData });
    }

    const targets = inboxFilter === 'all'
      ? allInboxes
      : allInboxes.filter((i: any) => i.id === inboxFilter);

    if (!targets.length) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    const inboxIds = targets.map((i: any) => i.id);

    // 2. Compute time window start
    const startDate = new Date();
    switch (timeWindow) {
      case '1h':  startDate.setHours(startDate.getHours() - 1); break;
      case '7d':  startDate.setDate(startDate.getDate() - 7); break;
      case '30d': startDate.setDate(startDate.getDate() - 30); break;
      default:    startDate.setDate(startDate.getDate() - 1); break; // 24h
    }
    const startISO = startDate.toISOString();

    // 3. Single parallel fan-out: metrics agg + events query (3 DB ops total)
    const { getCollection } = await import('../../db');
    const [messages, deliveryEventsCol] = await Promise.all([
      getCollection('messages'),
      getCollection('delivery_events'),
    ]);

    if (!messages || !deliveryEventsCol) {
      return res.status(500).json({ error: 'Database collections not available' });
    }

    const msgMatch: Record<string, unknown> = {
      'metadata.inbox_id': inboxIds.length === 1 ? inboxIds[0] : { $in: inboxIds },
      created_at: { $gte: startISO },
    };
    const evtMatch: Record<string, unknown> = {
      inbox_id: inboxIds.length === 1 ? inboxIds[0] : { $in: inboxIds },
      processed_at: { $gte: startISO },
    };

    const [msgAgg, evtAgg, recentEvents] = await Promise.all([
      // Metrics from messages collection
      messages.aggregate([
        { $match: msgMatch },
        {
          $group: {
            _id: null,
            sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
            delivered: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] } },
            bounced: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] } },
            complained: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'failed'] }, 1, 0] } },
            suppressed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'suppressed'] }, 1, 0] } },
          },
        },
      ]).toArray(),

      // Event type counts from delivery_events
      deliveryEventsCol.aggregate([
        { $match: evtMatch },
        { $group: { _id: '$event_type', count: { $sum: 1 } } },
      ]).toArray(),

      // Recent events for activity chart + recent events panel
      deliveryEventsCol
        .find(evtMatch)
        .sort({ processed_at: -1 })
        .limit(200)
        .project({ _id: 0, message_id: 1, event_type: 1, processed_at: 1, inbox_id: 1, event_data: 1 })
        .toArray(),
    ]);

    // 4. Build metrics from raw aggregation results
    const raw = msgAgg[0] || { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0 };
    const evtMap: Record<string, number> = {};
    (evtAgg as any[]).forEach((e: any) => { evtMap[e._id] = e.count; });

    const m = {
      sent: Math.max(raw.sent || 0, evtMap['sent'] || 0),
      delivered: Math.max(raw.delivered || 0, evtMap['delivered'] || 0),
      bounced: Math.max(raw.bounced || 0, evtMap['bounced'] || 0),
      complained: Math.max(raw.complained || 0, evtMap['complained'] || 0),
      failed: Math.max(raw.failed || 0, evtMap['failed'] || 0),
      suppressed: Math.max(raw.suppressed || 0, evtMap['suppressed'] || 0),
      orphan_events: evtMap['orphan'] || 0,
    };
    const total = m.sent || 1;
    const metrics = {
      ...m,
      delivery_rate: (m.delivered / total) * 100,
      bounce_rate: (m.bounced / total) * 100,
      complaint_rate: (m.complained / total) * 100,
      failure_rate: (m.failed / total) * 100,
      suppression_rate: (m.suppressed / total) * 100,
      orphan_event_rate: (m.orphan_events / total) * 100,
      time_window: timeWindow,
      calculated_at: new Date().toISOString(),
    };

    // 5. Derive alerts from metrics (pure computation — no extra DB)
    const alerts: any[] = [];
    const thresholds = {
      bounce_rate: { warning: 2, critical: 5 },
      complaint_rate: { warning: 0.05, critical: 0.1 },
      failure_rate: { warning: 5, critical: 10 },
      delivery_rate: { warning: 95, critical: 90 },
    };
    const now = new Date().toISOString();

    const addAlert = (type: string, value: number, threshold: number, severity: 'warning' | 'critical') => {
      alerts.push({ id: `overview-${type}-${now}`, type, severity, value, threshold, time_window: timeWindow, calculated_at: now });
    };
    if (metrics.bounce_rate > thresholds.bounce_rate.critical) addAlert('high_bounce_rate', metrics.bounce_rate, thresholds.bounce_rate.critical, 'critical');
    else if (metrics.bounce_rate > thresholds.bounce_rate.warning) addAlert('high_bounce_rate', metrics.bounce_rate, thresholds.bounce_rate.warning, 'warning');
    if (metrics.complaint_rate > thresholds.complaint_rate.critical) addAlert('high_complaint_rate', metrics.complaint_rate, thresholds.complaint_rate.critical, 'critical');
    else if (metrics.complaint_rate > thresholds.complaint_rate.warning) addAlert('high_complaint_rate', metrics.complaint_rate, thresholds.complaint_rate.warning, 'warning');
    if (metrics.failure_rate > thresholds.failure_rate.critical) addAlert('high_failure_rate', metrics.failure_rate, thresholds.failure_rate.critical, 'critical');
    else if (metrics.failure_rate > thresholds.failure_rate.warning) addAlert('high_failure_rate', metrics.failure_rate, thresholds.failure_rate.warning, 'warning');
    if (metrics.delivery_rate < thresholds.delivery_rate.critical) addAlert('low_delivery_rate', metrics.delivery_rate, thresholds.delivery_rate.critical, 'critical');
    else if (metrics.delivery_rate < thresholds.delivery_rate.warning) addAlert('low_delivery_rate', metrics.delivery_rate, thresholds.delivery_rate.warning, 'warning');

    const responseData = {
      metrics,
      alerts,
      events: recentEvents,
      inboxes: inboxList,
      inbox_count: allInboxes.length,
    };

    // Cache the computed result (2min TTL)
    await overviewCacheService.setCachedOverview(
      domainId,
      inboxFilter as string,
      timeWindow as string,
      responseData
    );

    return res.json({ data: responseData });
  } catch (error) {
    logger.error('Error computing overview', { error, domainId });
    return res.status(500).json({ error: 'Failed to compute overview' });
  }
});

// GET /api/monitoring/cache/stats
router.get('/monitoring/cache/stats', async (req, res) => {
  try {
    const stats = metricsCacheService.getCacheStats();
    return res.json({ data: stats });
  } catch (error) {
    logger.error('Error getting cache stats', { error });
    return res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

export default router;
