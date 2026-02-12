import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { SuppressionEntry } from '../types';

const ensureIndexes = async () => {
  const suppressions = await getCollection<SuppressionEntry>('suppressions');
  if (suppressions) {
    await suppressions.createIndex({ email: 1 }, { unique: true });
    await suppressions.createIndex({ inbox_id: 1, source: 1 });
    await suppressions.createIndex({ created_at: 1 });
    await suppressions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  }
};

const addSuppression = async (suppression: Omit<SuppressionEntry, '_id'>) => {
  const collection = await getCollection<SuppressionEntry>('suppressions');
  if (!collection) {
    return null;
  }

  const normalizedEmail = suppression.email.toLowerCase();

  // Never downgrade a permanent/hard suppression to a soft/temporary one.
  // A hard bounce means the address doesn't exist — a subsequent soft bounce
  // shouldn't un-suppress it after 7 days.
  if (suppression.type === 'soft' || suppression.expires_at) {
    const existing = await collection.findOne({ email: normalizedEmail });
    if (existing && existing.type === 'hard' && existing.reason === 'bounce') {
      return existing;
    }
  }
  
  const doc = {
    ...suppression,
    email: normalizedEmail,
    _id: randomUUID(),
    created_at: new Date().toISOString()
  };
  
  await collection.updateOne(
    { email: normalizedEmail },
    { $set: doc },
    { upsert: true }
  );
  
  return doc;
};

const isSuppressed = async (email: string, inboxId?: string) => {
  const collection = await getCollection<SuppressionEntry>('suppressions');
  if (!collection) {
    return false;
  }
  
  const normalizedEmail = email.toLowerCase();
  
  // Check for global suppression first
  const globalSuppression = await collection.findOne({
    email: normalizedEmail,
    source: 'global',
    $or: [
      { expires_at: { $exists: false } },
      { expires_at: { $gt: new Date().toISOString() } }
    ]
  });
  
  if (globalSuppression) return true;
  
  // Check inbox-level suppression
  if (inboxId) {
    const inboxSuppression = await collection.findOne({
      email: normalizedEmail,
      inbox_id: inboxId,
      source: 'inbox',
      $or: [
        { expires_at: { $exists: false } },
        { expires_at: { $gt: new Date().toISOString() } }
      ]
    });
    
    if (inboxSuppression) return true;
  }
  
  // Check domain-level suppression
  const domain = email.split('@')[1];
  if (domain) {
    const domainSuppression = await collection.findOne({
      email: { $regex: `@${domain}$` },
      source: 'domain',
      $or: [
        { expires_at: { $exists: false } },
        { expires_at: { $gt: new Date().toISOString() } }
      ]
    });
    
    if (domainSuppression) return true;
  }
  
  return false;
};

const getInboxSuppressions = async (inboxId: string) => {
  const collection = await getCollection<SuppressionEntry>('suppressions');
  if (!collection) {
    return [];
  }
  
  return collection.find({
    inbox_id: inboxId,
    source: 'inbox'
  }).sort({ created_at: -1 }).toArray();
};

const getDomainSuppressions = async (domainId: string) => {
  const collection = await getCollection<SuppressionEntry>('suppressions');
  if (!collection) {
    return [];
  }
  
  return collection.find({
    inbox_id: domainId,
    source: 'domain'
  }).sort({ created_at: -1 }).toArray();
};

export default {
  ensureIndexes,
  addSuppression,
  isSuppressed,
  getInboxSuppressions,
  getDomainSuppressions
};
