import crypto from 'crypto';
import logger from '../utils/logger';
import { connect } from '../db';

/**
 * Token guard - prevents changing critical tokens after they're set
 * Similar to encryption key guard but for thread tokens and webhook tokens
 */

interface TokenLockEntry {
  token_type: string;
  token_fingerprint: string;
  created_at: Date;
  locked_at: Date;
}

export class TokenGuard {
  private static instance: TokenGuard;
  private readonly collection = 'token_locks';

  static getInstance(): TokenGuard {
    if (!TokenGuard.instance) {
      TokenGuard.instance = new TokenGuard();
    }
    return TokenGuard.instance;
  }

  /**
   * Get database instance
   */
  private async getDb() {
    const db = await connect();
    if (!db) {
      throw new Error('Database connection failed - make sure MONGO_URL is set');
    }
    return db;
  }

  /**
   * Generate a secure random token
   */
  static generateSecureToken(length: number = 64): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Get fingerprint of a token for comparison
   */
  static getTokenFingerprint(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  /**
   * Lock a token type with its fingerprint
   */
  async lockToken(tokenType: string, token: string): Promise<void> {
    const fingerprint = TokenGuard.getTokenFingerprint(token);
    const db = await this.getDb();
    
    try {
      await db.collection(this.collection).insertOne({
        token_type: tokenType,
        token_fingerprint: fingerprint,
        created_at: new Date(),
        locked_at: new Date()
      } as TokenLockEntry);
      
      logger.info(`Token locked: ${tokenType} with fingerprint ${fingerprint}`);
    } catch (error: any) {
      if (error.code === 11000) {
        // Token already locked - verify fingerprint matches
        const existing = await db.collection(this.collection).findOne({ token_type: tokenType });
        if (existing && existing.token_fingerprint !== fingerprint) {
          const errorMsg = `FATAL: Token ${tokenType} fingerprint mismatch! Expected ${existing.token_fingerprint}, got ${fingerprint}`;
          logger.error(errorMsg);
          throw new Error(errorMsg);
        }
        logger.info(`Token ${tokenType} already locked with matching fingerprint`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Verify a token matches the locked fingerprint
   */
  async verifyToken(tokenType: string, token: string): Promise<boolean> {
    const fingerprint = TokenGuard.getTokenFingerprint(token);
    const db = await this.getDb();
    const lock = await db.collection(this.collection).findOne({ token_type: tokenType });
    
    if (!lock) {
      logger.warn(`Token ${tokenType} not found in locks - allowing first-time setup`);
      return true;
    }
    
    return lock.token_fingerprint === fingerprint;
  }

  /**
   * Check if token is locked
   */
  async isTokenLocked(tokenType: string): Promise<boolean> {
    const db = await this.getDb();
    const lock = await db.collection(this.collection).findOne({ token_type: tokenType });
    return !!lock;
  }

  /**
   * Get all locked tokens (for admin/audit)
   */
  async getLockedTokens(): Promise<TokenLockEntry[]> {
    const db = await this.getDb();
    const results = await db.collection(this.collection).find({}).toArray();
    return results as unknown as TokenLockEntry[];
  }

  /**
   * Validate all critical tokens at startup
   */
  async validateStartupTokens(): Promise<void> {
    const criticalTokens = [
      { type: 'THREAD_TOKEN_SECRET', envVar: process.env.THREAD_TOKEN_SECRET },
      { type: 'INTERNAL_WEBHOOK_TOKEN', envVar: process.env.INTERNAL_WEBHOOK_TOKEN },
      { type: 'UNSUBSCRIBE_SECRET', envVar: process.env.UNSUBSCRIBE_SECRET }
    ];

    for (const { type, envVar } of criticalTokens) {
      if (!envVar) {
        logger.warn(`Token ${type} not set - will use fallback derivation`);
        continue;
      }

      const isValid = await this.verifyToken(type, envVar);
      if (!isValid) {
        const errorMsg = `FATAL: Token ${type} fingerprint mismatch! Possible token change detected.`;
        logger.error(errorMsg);
        
        // In production, exit on token mismatch
        if (process.env.NODE_ENV === 'production' && !process.env.TOKEN_UNSAFE_SKIP_GUARDS) {
          process.exit(1);
        } else {
          logger.warn(`WARNING: Continuing with mismatched token ${type} in non-production mode`);
        }
      }
    }

    logger.info('Token validation completed');
  }

  /**
   * Ensure indexes for token locks collection
   */
  async ensureIndexes(): Promise<void> {
    const db = await this.getDb();
    await db.collection(this.collection).createIndex(
      { token_type: 1 }, 
      { unique: true }
    );
    await db.collection(this.collection).createIndex(
      { token_fingerprint: 1 }
    );
  }
}

export default TokenGuard.getInstance();
