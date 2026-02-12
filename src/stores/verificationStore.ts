import { randomBytes } from 'crypto';
import { getCollection } from '../db';

export type VerificationRecord = {
  _id?: string;
  id: string;
  userId: string;
  email: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
};

const collectionName = 'verification_tokens';

const ensureIndexes = async () => {
  const collection = await getCollection<VerificationRecord>(collectionName);
  if (!collection) {
    return;
  }

  await collection.createIndex({ token: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};

const generateToken = () => randomBytes(20).toString('hex');

const createToken = async ({
  userId,
  email,
  ttlMinutes = 60,
}: {
  userId: string;
  email: string;
  ttlMinutes?: number;
}) => {
  const collection = await getCollection<VerificationRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const token = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMinutes * 60 * 1000);

  const record: VerificationRecord = {
    id: `verify_${randomBytes(8).toString('hex')}`,
    userId,
    email,
    token,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
  };

  await collection.insertOne(record);
  return { token, record };
};

const consumeToken = async (token: string) => {
  const collection = await getCollection<VerificationRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const now = new Date();
  const record = await collection.findOne({ token, usedAt: null, expiresAt: { $gt: now.toISOString() } });
  if (!record) {
    return null;
  }

  await collection.updateOne({ _id: record._id }, { $set: { usedAt: now.toISOString() } });
  return record;
};

export default {
  ensureIndexes,
  createToken,
  consumeToken,
};
