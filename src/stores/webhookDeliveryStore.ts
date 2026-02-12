import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { WebhookDelivery, WebhookDeliveryAttempt, WebhookDeliveryStatus } from '../types';
import { encryptJsonPayload, decryptJsonPayload, encryptSecretField, decryptSecretField } from '../lib/encryption';

const COLLECTION = 'webhook_deliveries';
const DEAD_LETTER_RETENTION_DAYS = 30;

const ensureIndexes = async () => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return;

  await col.createIndex({ delivery_id: 1 }, { unique: true });
  // Retry worker: find retrying deliveries ready for next attempt
  await col.createIndex({ status: 1, next_retry_at: 1 });
  // Org-level queries
  await col.createIndex({ org_id: 1, created_at: -1 });
  // Inbox-level queries
  await col.createIndex({ inbox_id: 1, status: 1, created_at: -1 });
  // Message correlation
  await col.createIndex({ message_id: 1 });
  // Endpoint health queries
  await col.createIndex({ endpoint: 1, created_at: -1 });
  // Auto-expire dead letters after retention period
  await col.createIndex(
    { dead_at: 1 },
    { expireAfterSeconds: DEAD_LETTER_RETENTION_DAYS * 24 * 60 * 60, partialFilterExpression: { dead_at: { $type: 'string' } } }
  );
};

const createDelivery = async (params: {
  inbox_id: string;
  org_id?: string;
  message_id: string;
  endpoint: string;
  payload: Record<string, any>;
  payload_hash: string;
  max_attempts: number;
  signature_header: string | null;
  webhook_secret?: string | null;
}): Promise<WebhookDelivery> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) throw new Error('Database unavailable');

  const now = new Date().toISOString();
  const doc: WebhookDelivery = {
    _id: randomUUID(),
    delivery_id: `whd_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    inbox_id: params.inbox_id,
    org_id: params.org_id,
    message_id: params.message_id,
    endpoint: params.endpoint,
    payload: encryptJsonPayload(params.payload) as any,
    payload_hash: params.payload_hash,
    status: 'pending',
    attempts: [],
    attempt_count: 0,
    max_attempts: params.max_attempts,
    next_retry_at: null,
    created_at: now,
    delivered_at: null,
    dead_at: null,
    last_error: null,
    last_status_code: null,
    delivery_latency_ms: null,
    signature_header: params.signature_header,
    webhook_secret: params.webhook_secret ? encryptSecretField(params.webhook_secret) : null,
  };

  await col.insertOne(doc as any);
  return doc;
};

const recordAttempt = async (
  deliveryId: string,
  attempt: WebhookDeliveryAttempt,
  update: {
    status: WebhookDeliveryStatus;
    next_retry_at: string | null;
    delivered_at?: string | null;
    dead_at?: string | null;
    delivery_latency_ms?: number | null;
  }
): Promise<void> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return;

  const setFields: Record<string, any> = {
    status: update.status,
    next_retry_at: update.next_retry_at,
    last_error: attempt.error,
    last_status_code: attempt.status_code,
    attempt_count: attempt.attempt,
  };

  if (update.delivered_at !== undefined) setFields.delivered_at = update.delivered_at;
  if (update.dead_at !== undefined) setFields.dead_at = update.dead_at;
  if (update.delivery_latency_ms !== undefined) setFields.delivery_latency_ms = update.delivery_latency_ms;

  await col.updateOne(
    { delivery_id: deliveryId },
    {
      $set: setFields,
      $push: { attempts: attempt as any },
    }
  );
};

/**
 * Atomically claim a batch of deliveries ready for retry.
 * Uses findOneAndUpdate to prevent duplicate processing across instances.
 */
const claimRetryBatch = async (batchSize: number): Promise<WebhookDelivery[]> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return [];

  const now = new Date().toISOString();
  const claimed: WebhookDelivery[] = [];

  for (let i = 0; i < batchSize; i++) {
    const result = await col.findOneAndUpdate(
      {
        status: 'retrying',
        next_retry_at: { $lte: now },
      },
      {
        $set: { status: 'pending' as WebhookDeliveryStatus, next_retry_at: null },
      },
      {
        sort: { next_retry_at: 1 },
        returnDocument: 'after',
      }
    );

    if (!result) break;
    claimed.push(decryptDelivery(result as unknown as WebhookDelivery)!);
  }

  return claimed;
};

const decryptDelivery = (doc: WebhookDelivery | null): WebhookDelivery | null => {
  if (!doc) return null;
  return {
    ...doc,
    payload: decryptJsonPayload(doc.payload as any),
    webhook_secret: doc.webhook_secret ? decryptSecretField(doc.webhook_secret) as string : null,
  };
};

const getDelivery = async (deliveryId: string): Promise<WebhookDelivery | null> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ delivery_id: deliveryId });
  return decryptDelivery(doc as unknown as WebhookDelivery);
};

const getDeliveryByMessageId = async (messageId: string): Promise<WebhookDelivery | null> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ message_id: messageId }, { sort: { created_at: -1 } });
  return decryptDelivery(doc as unknown as WebhookDelivery);
};

const listDeliveries = async (params: {
  org_id?: string;
  inbox_id?: string;
  status?: WebhookDeliveryStatus;
  endpoint?: string;
  limit?: number;
  offset?: number;
}): Promise<{ deliveries: WebhookDelivery[]; total: number }> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return { deliveries: [], total: 0 };

  const filter: Record<string, any> = {};
  if (params.org_id) filter.org_id = params.org_id;
  if (params.inbox_id) filter.inbox_id = params.inbox_id;
  if (params.status) filter.status = params.status;
  if (params.endpoint) filter.endpoint = params.endpoint;

  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;

  const [rawDeliveries, total] = await Promise.all([
    col.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);

  const deliveries = (rawDeliveries as unknown as WebhookDelivery[]).map(d => decryptDelivery(d)!).filter(Boolean);
  return { deliveries, total };
};

/**
 * Mark a dead delivery for retry (manual replay).
 */
const requeue = async (deliveryId: string): Promise<boolean> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return false;

  const result = await col.updateOne(
    { delivery_id: deliveryId, status: { $in: ['dead', 'retrying'] } },
    {
      $set: {
        status: 'retrying' as WebhookDeliveryStatus,
        next_retry_at: new Date().toISOString(),
        dead_at: null,
      },
    }
  );

  return result.modifiedCount > 0;
};

/**
 * Get endpoint health stats for an org.
 */
const getEndpointHealth = async (orgId: string): Promise<Array<{
  endpoint: string;
  total: number;
  delivered: number;
  failed: number;
  dead: number;
  success_rate: number;
  avg_latency_ms: number;
}>> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return [];

  // Look at last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const pipeline = [
    { $match: { org_id: orgId, created_at: { $gte: since } } },
    {
      $group: {
        _id: '$endpoint',
        total: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'retrying'] }, 1, 0] } },
        dead: { $sum: { $cond: [{ $eq: ['$status', 'dead'] }, 1, 0] } },
        avg_latency_ms: {
          $avg: {
            $cond: [
              { $ne: ['$delivery_latency_ms', null] },
              '$delivery_latency_ms',
              '$$REMOVE',
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        endpoint: '$_id',
        total: 1,
        delivered: 1,
        failed: 1,
        dead: 1,
        avg_latency_ms: { $ifNull: ['$avg_latency_ms', 0] },
        success_rate: {
          $cond: [
            { $gt: ['$total', 0] },
            { $divide: ['$delivered', '$total'] },
            0,
          ],
        },
      },
    },
  ];

  return col.aggregate(pipeline).toArray() as any;
};

/**
 * Count deliveries by status for an org (for dashboard stats).
 */
const getDeliveryCounts = async (orgId: string): Promise<Record<WebhookDeliveryStatus, number>> => {
  const col = await getCollection<WebhookDelivery>(COLLECTION);
  if (!col) return { pending: 0, delivered: 0, retrying: 0, dead: 0 };

  const pipeline = [
    { $match: { org_id: orgId } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ];

  const results = await col.aggregate(pipeline).toArray();
  const counts: Record<string, number> = { pending: 0, delivered: 0, retrying: 0, dead: 0 };
  for (const r of results) {
    counts[r._id as string] = r.count;
  }
  return counts as Record<WebhookDeliveryStatus, number>;
};

export default {
  ensureIndexes,
  createDelivery,
  recordAttempt,
  claimRetryBatch,
  getDelivery,
  getDeliveryByMessageId,
  listDeliveries,
  requeue,
  getEndpointHealth,
  getDeliveryCounts,
};
