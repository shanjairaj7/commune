import { MongoClient, type Db, type Collection, type Document } from 'mongodb';
import type { Organization, User, ApiKey, EmailVerificationToken, Session } from './types';

const uri = process.env.MONGO_URL;
let client: MongoClient | null = null;
let database: Db | null = null;
let connectingPromise: Promise<Db | null> | null = null;

export const connect = async (): Promise<Db | null> => {
  if (!uri) {
    return null;
  }

  if (database) {
    return database;
  }

  // Prevent race: reuse in-flight connection attempt
  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        client = new MongoClient(uri, {
          serverSelectionTimeoutMS: 15000,
          connectTimeoutMS: 15000,
          retryWrites: true,
          retryReads: true,
        });

        await client.connect();
        database = client.db();
        console.log(`Connected to MongoDB (db: ${database.databaseName}) on attempt ${attempt}`);
        return database;
      } catch (error) {
        console.warn(`Failed to connect to MongoDB (attempt ${attempt}/${maxRetries}):`, error instanceof Error ? error.message : error);
        client = null;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
    connectingPromise = null;
    return null;
  })();

  return connectingPromise;
};

export const getCollection = async <T extends Document = Document>(
  name: string
): Promise<Collection<T> | null> => {
  const db = await connect();
  if (!db) {
    return null;
  }

  return db.collection<T>(name);
};

export const setupCollections = async (db: Db) => {
  await db.createCollection<Organization>('organizations');
  await db.collection('organizations').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { slug: 1 }, unique: true },
    { key: { status: 1 } }
  ]);

  await db.createCollection<User>('users');
  await db.collection('users').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { email: 1 }, unique: true },
    { key: { orgId: 1 } },
    { key: { orgId: 1, email: 1 }, unique: true },
    { key: { status: 1 } },
    { key: { emailVerificationToken: 1 } }
  ]);

  await db.createCollection<ApiKey>('api_keys');
  await db.collection('api_keys').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { keyHash: 1 }, unique: true },
    { key: { keyPrefix: 1 } },
    { key: { orgId: 1 } },
    { key: { status: 1 } },
    { key: { expiresAt: 1 } }
  ]);

  await db.createCollection<EmailVerificationToken>('email_verification_tokens');
  await db.collection('email_verification_tokens').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { token: 1 }, unique: true },
    { key: { userId: 1 } },
    { key: { email: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ]);

  await db.createCollection<Session>('sessions');
  await db.collection('sessions').createIndexes([
    { key: { id: 1 }, unique: true },
    { key: { tokenHash: 1 }, unique: true },
    { key: { userId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 }
  ]);

  await db.collection('domains').createIndex({ orgId: 1 });
};
