import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { SecurityStateEntry } from '../types';
import logger from '../utils/logger';

const COLLECTION_NAME = 'security_state';
const SOFT_BOUNCE_TYPE = 'soft_bounce';
const SOFT_BOUNCE_TTL_DAYS = Number(process.env.SOFT_BOUNCE_TTL_DAYS || 30);

const ensureIndexes = async () => {
  try {
    const collection = await getCollection<SecurityStateEntry>(COLLECTION_NAME);
    if (collection) {
      await collection.createIndex({ type: 1, key: 1 }, { unique: true });
      await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
      await collection.createIndex({ type: 1, last_bounce_at: -1 });
    }
  } catch (error) {
    logger.error('Failed to ensure security_state indexes', { error });
  }
};

const incrementSoftBounce = async ({
  email,
  reason,
  inboxId,
}: {
  email: string;
  reason?: string;
  inboxId?: string;
}): Promise<number> => {
  const collection = await getCollection<SecurityStateEntry>(COLLECTION_NAME);
  if (!collection) {
    return 0;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SOFT_BOUNCE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const normalized = email.trim().toLowerCase();

  const result = await collection.findOneAndUpdate(
    { type: SOFT_BOUNCE_TYPE, key: normalized },
    {
      $setOnInsert: {
        _id: randomUUID(),
        type: SOFT_BOUNCE_TYPE,
        key: normalized,
        created_at: now.toISOString(),
        first_bounce_at: now.toISOString(),
      },
      $inc: { consecutive_count: 1 },
      $set: {
        last_bounce_at: now.toISOString(),
        last_reason: reason,
        inbox_id: inboxId,
        updated_at: now.toISOString(),
        expires_at: expiresAt,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  return result?.consecutive_count || 1;
};

const resetSoftBounce = async (email: string): Promise<void> => {
  const collection = await getCollection<SecurityStateEntry>(COLLECTION_NAME);
  if (!collection) {
    return;
  }

  await collection.deleteOne({ type: SOFT_BOUNCE_TYPE, key: email.trim().toLowerCase() });
};

export default {
  ensureIndexes,
  incrementSoftBounce,
  resetSoftBounce,
};
