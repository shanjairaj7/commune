import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { DeletionRequest, DeletionStatus } from '../types';

const COLLECTION = 'deletion_requests';

const ensureIndexes = async () => {
  const col = await getCollection<DeletionRequest>(COLLECTION);
  if (!col) return;

  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ org_id: 1, status: 1, requested_at: -1 });
  // Auto-expire completed/expired requests after 90 days
  await col.createIndex({ completed_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
};

const create = async (request: Omit<DeletionRequest, '_id' | 'id'>): Promise<DeletionRequest> => {
  const col = await getCollection<DeletionRequest>(COLLECTION);
  if (!col) throw new Error('Database unavailable');

  const doc: DeletionRequest = {
    ...request,
    _id: randomUUID(),
    id: `del_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
  };

  await col.insertOne(doc as any);
  return doc;
};

const getById = async (id: string): Promise<DeletionRequest | null> => {
  const col = await getCollection<DeletionRequest>(COLLECTION);
  if (!col) return null;
  return col.findOne({ id }) as unknown as DeletionRequest | null;
};

const getActiveForOrg = async (orgId: string): Promise<DeletionRequest | null> => {
  const col = await getCollection<DeletionRequest>(COLLECTION);
  if (!col) return null;
  return col.findOne({
    org_id: orgId,
    status: { $in: ['pending', 'confirmed', 'executing'] },
  }) as unknown as DeletionRequest | null;
};

const updateStatus = async (
  id: string,
  status: DeletionStatus,
  extra?: Partial<DeletionRequest>
): Promise<boolean> => {
  const col = await getCollection<DeletionRequest>(COLLECTION);
  if (!col) return false;

  const result = await col.updateOne(
    { id },
    { $set: { status, ...extra } }
  );
  return result.modifiedCount > 0;
};

export default {
  ensureIndexes,
  create,
  getById,
  getActiveForOrg,
  updateStatus,
};
