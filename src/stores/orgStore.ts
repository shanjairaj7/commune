import { randomUUID } from 'crypto';
import { getCollection } from '../db';

export type OrgRecord = {
  _id?: string;
  id: string;
  name: string;
  createdAt: string;
};

const collectionName = 'orgs';

const ensureIndexes = async () => {
  const collection = await getCollection<OrgRecord>(collectionName);
  if (!collection) {
    return;
  }

  await collection.createIndex({ id: 1 }, { unique: true });
  await collection.createIndex({ name: 1 }, { unique: true });
};

const createOrg = async ({ name }: { name: string }) => {
  const collection = await getCollection<OrgRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const createdAt = new Date().toISOString();
  const record: OrgRecord = {
    id: `org_${randomUUID()}`,
    name,
    createdAt,
  };

  await collection.insertOne(record);
  return record;
};

const getOrgById = async (id: string) => {
  const collection = await getCollection<OrgRecord>(collectionName);
  if (!collection) {
    return null;
  }

  return collection.findOne({ id });
};

const getOrgByName = async (name: string) => {
  const collection = await getCollection<OrgRecord>(collectionName);
  if (!collection) {
    return null;
  }

  return collection.findOne({ name });
};

export default {
  ensureIndexes,
  createOrg,
  getOrgById,
  getOrgByName,
};
