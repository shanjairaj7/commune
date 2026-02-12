import { Router } from 'express';
import webhookDeliveryStore from '../../stores/webhookDeliveryStore';
import webhookDeliveryService from '../../services/webhookDeliveryService';
import type { WebhookDeliveryStatus } from '../../types';
import { requirePermission } from '../../middleware/permissions';

const router = Router();

/**
 * GET /v1/webhooks/deliveries
 * List webhook deliveries with filters.
 */
router.get('/deliveries', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const orgId = req.apiKey?.orgId || req.orgId;
    const { inbox_id, status, endpoint, limit, offset } = req.query;

    const result = await webhookDeliveryStore.listDeliveries({
      org_id: orgId,
      inbox_id: inbox_id as string,
      status: status as WebhookDeliveryStatus,
      endpoint: endpoint as string,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });

    return res.json({
      deliveries: result.deliveries.map(d => ({
        delivery_id: d.delivery_id,
        inbox_id: d.inbox_id,
        message_id: d.message_id,
        endpoint: d.endpoint,
        status: d.status,
        attempt_count: d.attempt_count,
        max_attempts: d.max_attempts,
        created_at: d.created_at,
        delivered_at: d.delivered_at,
        dead_at: d.dead_at,
        last_error: d.last_error,
        last_status_code: d.last_status_code,
        delivery_latency_ms: d.delivery_latency_ms,
        next_retry_at: d.next_retry_at,
      })),
      total: result.total,
    });
  } catch (err: any) {
    console.error('❌ List webhook deliveries error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/webhooks/deliveries/:deliveryId
 * Get full delivery detail including all attempts.
 */
router.get('/deliveries/:deliveryId', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const { deliveryId } = req.params;
    const delivery = await webhookDeliveryStore.getDelivery(deliveryId);

    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    // Verify org access
    const orgId = req.apiKey?.orgId || req.orgId;
    if (orgId && delivery.org_id && delivery.org_id !== orgId) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    return res.json({
      delivery: {
        delivery_id: delivery.delivery_id,
        inbox_id: delivery.inbox_id,
        message_id: delivery.message_id,
        endpoint: delivery.endpoint,
        payload_hash: delivery.payload_hash,
        status: delivery.status,
        attempts: delivery.attempts,
        attempt_count: delivery.attempt_count,
        max_attempts: delivery.max_attempts,
        created_at: delivery.created_at,
        delivered_at: delivery.delivered_at,
        dead_at: delivery.dead_at,
        last_error: delivery.last_error,
        last_status_code: delivery.last_status_code,
        delivery_latency_ms: delivery.delivery_latency_ms,
        next_retry_at: delivery.next_retry_at,
      },
    });
  } catch (err: any) {
    console.error('❌ Get webhook delivery error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/webhooks/deliveries/:deliveryId/retry
 * Manually retry a dead or failed delivery.
 */
router.post('/deliveries/:deliveryId/retry', requirePermission('messages:write'), async (req: any, res) => {
  try {
    const { deliveryId } = req.params;

    // Verify the delivery exists and belongs to this org
    const delivery = await webhookDeliveryStore.getDelivery(deliveryId);
    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const orgId = req.apiKey?.orgId || req.orgId;
    if (orgId && delivery.org_id && delivery.org_id !== orgId) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const result = await webhookDeliveryService.retryDelivery(deliveryId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({ ok: true, message: 'Delivery queued for retry' });
  } catch (err: any) {
    console.error('❌ Retry webhook delivery error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/webhooks/health
 * Get per-endpoint webhook delivery health stats for the org.
 */
router.get('/health', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const orgId = req.apiKey?.orgId || req.orgId;
    if (!orgId) {
      return res.status(400).json({ error: 'Organization context required' });
    }

    const [health, counts] = await Promise.all([
      webhookDeliveryStore.getEndpointHealth(orgId),
      webhookDeliveryStore.getDeliveryCounts(orgId),
    ]);

    return res.json({
      endpoints: health,
      totals: counts,
    });
  } catch (err: any) {
    console.error('❌ Webhook health error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
