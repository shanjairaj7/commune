import { randomBytes } from 'crypto';
import { getCollection } from '../db';
import { hashToken } from '../utils/tokens';

export type SessionRecord = {
  _id?: string;
  id: string;
  userId: string;
  orgId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

const collectionName = 'sessions';

const ensureIndexes = async () => {
  const collection = await getCollection<SessionRecord>(collectionName);
  if (!collection) {
    return;
  }

  await collection.createIndex({ tokenHash: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};

const generateToken = () => randomBytes(32).toString('hex');

const createSession = async ({
  userId,
  orgId,
  ttlHours = 24 * 30,
}: {
  userId: string;
  orgId: string;
  ttlHours?: number;
}) => {
  const collection = await getCollection<SessionRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const token = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000);

  const record: SessionRecord = {
    id: `sess_${randomBytes(8).toString('hex')}`,
    userId,
    orgId,
    tokenHash: hashToken(token),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  await collection.insertOne(record);
  return { token, record };
};

const getSessionByToken = async (token: string) => {
  const collection = await getCollection<SessionRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const now = new Date().toISOString();
  return collection.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: now } });
};

const revokeSession = async (token: string) => {
  const collection = await getCollection<SessionRecord>(collectionName);
  if (!collection) {
    return null;
  }

  await collection.deleteOne({ tokenHash: hashToken(token) });
  return true;
};

export default {
  ensureIndexes,
  createSession,
  getSessionByToken,
  revokeSession,
};
