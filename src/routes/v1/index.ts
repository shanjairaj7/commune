import { Router } from 'express';
import { apiKeyAuth } from '../../middleware/apiKeyAuth';
import domainRoutes from './domains';
import inboxRoutes from './inboxes';
import threadRoutes from './threads';
import messageRoutes from './messages';
import attachmentRoutes from './attachments';
import dmarcRoutes from './dmarc';
import deliveryMetricsRoutes from './deliveryMetrics';
import searchRoutes from './search';
import webhookDeliveryRoutes from './webhookDeliveries';
import dataDeletionRoutes from './dataDeletion';

const router = Router();

// All v1 routes require API key authentication
router.use(apiKeyAuth);

// Attach apiKey context for permission checks
router.use((req: any, _res, next) => {
  if (!req.apiKey || typeof req.apiKey === 'string') {
    const orgId = req.orgId ?? null;
    req.apiKey = { orgId, source: 'apikey' };
  }
  next();
});

router.use('/domains', domainRoutes);
router.use('/inboxes', inboxRoutes);  // top-level: POST /v1/inboxes, GET /v1/inboxes (auto-resolve domain)
router.use('/domains', inboxRoutes);  // nested: /v1/domains/:domainId/inboxes (explicit domain)
router.use('/threads', threadRoutes);
router.use('/messages', messageRoutes);
router.use('/attachments', attachmentRoutes);
router.use('/dmarc', dmarcRoutes);
router.use('/delivery', deliveryMetricsRoutes);
router.use('/search', searchRoutes);
router.use('/webhooks', webhookDeliveryRoutes);
router.use('/data', dataDeletionRoutes);

export default router;
