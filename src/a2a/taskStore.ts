import type { TaskStore } from '@a2a-js/sdk/server';
import type { Task } from '@a2a-js/sdk';
import { connect } from '../db';
import logger from '../utils/logger';

const COLLECTION = 'a2a_tasks';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * MongoDB-backed TaskStore for A2A protocol.
 *
 * Tasks are persisted with a TTL index so they auto-expire after 7 days.
 * The two-method interface (save/load) is all the SDK requires.
 */
export class MongoTaskStore implements TaskStore {
  private initialized = false;

  private async ensureIndex(): Promise<void> {
    if (this.initialized) return;
    try {
      const db = await connect();
      if (!db) throw new Error('MongoDB not connected');
      const col = db.collection(COLLECTION);
      await col.createIndex({ taskId: 1 }, { unique: true });
      await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
      this.initialized = true;
    } catch (err) {
      logger.warn('A2A task index creation failed (non-fatal)', { err });
    }
  }

  async save(task: Task): Promise<void> {
    await this.ensureIndex();
    const db = await connect();
    if (!db) throw new Error('MongoDB not connected');
    const col = db.collection(COLLECTION);
    await col.updateOne(
      { taskId: task.id },
      {
        $set: { task, updatedAt: new Date() },
        $setOnInsert: { taskId: task.id, createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  async load(taskId: string): Promise<Task | undefined> {
    await this.ensureIndex();
    const db = await connect();
    if (!db) return undefined;
    const col = db.collection(COLLECTION);
    const doc = await col.findOne({ taskId });
    return doc?.task as Task | undefined;
  }
}
