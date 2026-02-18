import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { DeliveryEvent } from '../types';

const ensureIndexes = async () => {
  const events = await getCollection<DeliveryEvent>('delivery_events');
  if (events) {
    await events.createIndex({ message_id: 1, event_type: 1 });
    await events.createIndex({ inbox_id: 1, processed_at: -1 });
    await events.createIndex({ processed_at: 1 }, { expireAfterSeconds: 7776000 }); // 90 days
  }
};

const storeEvent = async (event: Omit<DeliveryEvent, '_id'>) => {
  const collection = await getCollection<DeliveryEvent>('delivery_events');
  if (!collection) {
    return null;
  }
  
  const doc = {
    ...event,
    _id: randomUUID(),
    processed_at: new Date().toISOString()
  };
  
  await collection.insertOne(doc);

  // Invalidate overview cache for this inbox (fire-and-forget, non-blocking)
  if (doc.inbox_id && doc.domain_id) {
    const { default: overviewCacheService } = await import('../services/overviewCacheService');
    overviewCacheService.invalidateInboxCache(doc.domain_id, doc.inbox_id).catch(() => {});
  }
  
  return doc;
};

const getEvents = async ({
  inboxId,
  domainId,
  messageId,
  eventType,
  limit = 100,
}: {
  inboxId?: string;
  domainId?: string;
  messageId?: string;
  eventType?: string;
  limit?: number;
}) => {
  const collection = await getCollection<DeliveryEvent>('delivery_events');
  if (!collection) {
    return [];
  }
  
  const filter: any = {};
  if (inboxId) {
    filter.inbox_id = inboxId;
  }
  if (domainId) {
    filter.domain_id = domainId;
  }
  if (messageId) {
    filter.message_id = messageId;
  }
  if (eventType) {
    filter.event_type = eventType;
  }
  
  return collection.find(filter)
    .sort({ processed_at: -1 })
    .limit(limit)
    .toArray();
};

const getInboxEvents = async (inboxId: string, eventType?: string, limit = 100) => {
  return getEvents({ inboxId, eventType, limit });
};

export default {
  ensureIndexes,
  storeEvent,
  getInboxEvents,
  getEvents
};
