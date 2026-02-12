import { getCollection } from '../db';

export interface ThreadMetadataEntry {
  _id?: string;
  thread_id: string;
  orgId: string;
  tags: string[];
  status: 'open' | 'needs_reply' | 'waiting' | 'closed';
  assigned_to?: string | null;
  updated_at: string;
}

const COLLECTION = 'thread_metadata';

const ensureIndexes = async () => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (col) {
    await col.createIndex({ thread_id: 1, orgId: 1 }, { unique: true });
    await col.createIndex({ orgId: 1, status: 1 });
    await col.createIndex({ orgId: 1, tags: 1 });
    await col.createIndex({ orgId: 1, assigned_to: 1 });
  }
};

const get = async (threadId: string, orgId: string): Promise<ThreadMetadataEntry | null> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return null;
  return col.findOne({ thread_id: threadId, orgId });
};

const upsert = async (
  threadId: string,
  orgId: string,
  updates: Partial<Pick<ThreadMetadataEntry, 'tags' | 'status' | 'assigned_to'>>,
): Promise<ThreadMetadataEntry | null> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return null;

  const setDoc: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.status !== undefined) setDoc.status = updates.status;
  if (updates.assigned_to !== undefined) setDoc.assigned_to = updates.assigned_to;
  if (updates.tags !== undefined) setDoc.tags = updates.tags;

  const result = await col.findOneAndUpdate(
    { thread_id: threadId, orgId },
    {
      $set: setDoc,
      $setOnInsert: {
        thread_id: threadId,
        orgId,
        ...(updates.tags === undefined ? { tags: [] } : {}),
        ...(updates.status === undefined ? { status: 'open' } : {}),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return result || null;
};

const addTags = async (threadId: string, orgId: string, tags: string[]): Promise<ThreadMetadataEntry | null> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return null;

  const result = await col.findOneAndUpdate(
    { thread_id: threadId, orgId },
    {
      $addToSet: { tags: { $each: tags } },
      $set: { updated_at: new Date().toISOString() },
      $setOnInsert: {
        thread_id: threadId,
        orgId,
        status: 'open',
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return result || null;
};

const removeTags = async (threadId: string, orgId: string, tags: string[]): Promise<ThreadMetadataEntry | null> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return null;

  const result = await col.findOneAndUpdate(
    { thread_id: threadId, orgId },
    {
      $pullAll: { tags },
      $set: { updated_at: new Date().toISOString() },
    },
    { returnDocument: 'after' },
  );

  return result || null;
};

const listByStatus = async (
  orgId: string,
  status: string,
  limit = 50,
): Promise<ThreadMetadataEntry[]> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return [];
  return col.find({ orgId, status } as any).sort({ updated_at: -1 }).limit(limit).toArray();
};

const listByTag = async (
  orgId: string,
  tag: string,
  limit = 50,
): Promise<ThreadMetadataEntry[]> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return [];
  return col.find({ orgId, tags: tag }).sort({ updated_at: -1 }).limit(limit).toArray();
};

const listByAssignee = async (
  orgId: string,
  assignee: string,
  limit = 50,
): Promise<ThreadMetadataEntry[]> => {
  const col = await getCollection<ThreadMetadataEntry>(COLLECTION);
  if (!col) return [];
  return col.find({ orgId, assigned_to: assignee }).sort({ updated_at: -1 }).limit(limit).toArray();
};

export default {
  ensureIndexes,
  get,
  upsert,
  addTags,
  removeTags,
  listByStatus,
  listByTag,
  listByAssignee,
};
