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
  return doc;
};

const getInboxEvents = async (
  inboxId: string,
  eventType?: string,
  limit = 100
) => {
  const collection = await getCollection<DeliveryEvent>('delivery_events');
  if (!collection) {
    return [];
  }
  
  const filter: any = { inbox_id: inboxId };
  if (eventType) {
    filter.event_type = eventType;
  }
  
  return collection.find(filter)
    .sort({ processed_at: -1 })
    .limit(limit)
    .toArray();
};

export default {
  ensureIndexes,
  storeEvent,
  getInboxEvents
};
