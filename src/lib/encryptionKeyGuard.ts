/**
 * Encryption Key Guard
 * 
 * Prevents accidental encryption key changes that would make data irrecoverable.
 * 
 * Three layers of protection:
 * 1. Key Fingerprint Lock — stores SHA-256 fingerprint in MongoDB; blocks startup if key changes
 * 2. Decryption Canary — verifies current key can decrypt a sample encrypted record
 * 3. Dual-Key Rotation — supports EMAIL_ENCRYPTION_KEY_PREVIOUS for safe transitions
 * 
 * To rotate keys safely:
 *   1. Set EMAIL_ENCRYPTION_KEY_PREVIOUS = <current key>
 *   2. Set EMAIL_ENCRYPTION_KEY = <new key>
 *   3. Set ENCRYPTION_KEY_ROTATION = "true"
 *   4. Deploy — server will register new fingerprint and decrypt with fallback
 *   5. Run re-encryption migration (reads with old key, writes with new key)
 *   6. Remove EMAIL_ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_ROTATION
 */
import { getCollection } from '../db';
import { getKeyFingerprint, isEncryptionEnabled, canDecrypt } from './encryption';
import logger from '../utils/logger';

interface KeyLockRecord {
  _id: string;
  key_fingerprint: string;
  registered_at: string;
  last_verified_at: string;
  rotated_from?: string;
}

const LOCK_DOC_ID = 'encryption_key_lock';

/**
 * Verify the encryption key hasn't changed unexpectedly.
 * 
 * - First run: registers the key fingerprint in MongoDB
 * - Subsequent runs: verifies current key matches stored fingerprint
 * - Key rotation: if ENCRYPTION_KEY_ROTATION=true, allows fingerprint update
 * 
 * Returns { ok: true } if safe to proceed, { ok: false, reason } if not.
 */
export const verifyKeyLock = async (): Promise<{ ok: boolean; reason?: string }> => {
  if (!isEncryptionEnabled()) {
    return { ok: true }; // No encryption — nothing to lock
  }

  const fingerprint = getKeyFingerprint();
  if (!fingerprint) {
    return { ok: true };
  }

  const col = await getCollection<KeyLockRecord>('encryption_key_lock');
  if (!col) {
    logger.warn('Cannot verify encryption key lock — DB not ready');
    return { ok: true }; // Fail open if DB isn't ready yet
  }

  const existing = await col.findOne({ _id: LOCK_DOC_ID });

  // First time — register the fingerprint
  if (!existing) {
    await col.insertOne({
      _id: LOCK_DOC_ID,
      key_fingerprint: fingerprint,
      registered_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
    });
    logger.info('Encryption key fingerprint registered', { fingerprint });
    return { ok: true };
  }

  // Key matches — update last_verified_at
  if (existing.key_fingerprint === fingerprint) {
    await col.updateOne(
      { _id: LOCK_DOC_ID },
      { $set: { last_verified_at: new Date().toISOString() } }
    );
    logger.info('Encryption key fingerprint verified', { fingerprint });
    return { ok: true };
  }

  // Key MISMATCH — check if this is an authorized rotation
  const isRotation = process.env.ENCRYPTION_KEY_ROTATION === 'true';
  if (isRotation) {
    const previousKeyExists = !!process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS;
    if (!previousKeyExists) {
      return {
        ok: false,
        reason: 'ENCRYPTION_KEY_ROTATION=true but EMAIL_ENCRYPTION_KEY_PREVIOUS is not set. ' +
                'You must provide the old key to safely rotate.',
      };
    }

    // Authorized rotation — update the fingerprint
    await col.updateOne(
      { _id: LOCK_DOC_ID },
      {
        $set: {
          key_fingerprint: fingerprint,
          last_verified_at: new Date().toISOString(),
          rotated_from: existing.key_fingerprint,
        },
      }
    );
    logger.info('Encryption key rotated', {
      newFingerprint: fingerprint,
      previousFingerprint: existing.key_fingerprint,
    });
    return { ok: true };
  }

  // UNAUTHORIZED key change — BLOCK startup
  return {
    ok: false,
    reason: `ENCRYPTION KEY MISMATCH DETECTED!\n` +
            `  Stored fingerprint: ${existing.key_fingerprint}\n` +
            `  Current fingerprint: ${fingerprint}\n` +
            `  Registered at: ${existing.registered_at}\n\n` +
            `The EMAIL_ENCRYPTION_KEY has changed. This will make all encrypted data IRRECOVERABLE.\n` +
            `If you intend to rotate the key, set these env vars:\n` +
            `  EMAIL_ENCRYPTION_KEY_PREVIOUS=<the old key>\n` +
            `  ENCRYPTION_KEY_ROTATION=true\n\n` +
            `If you accidentally changed the key, restore the original key immediately.`,
  };
};

/**
 * Decryption canary — verify the current key can actually decrypt existing data.
 * Finds one encrypted message and tries to decrypt it.
 * 
 * Returns { ok: true } if decryption works (or no encrypted data exists).
 * Returns { ok: false, reason } if decryption fails.
 */
export const runDecryptionCanary = async (): Promise<{ ok: boolean; reason?: string }> => {
  if (!isEncryptionEnabled()) {
    return { ok: true };
  }

  const messages = await getCollection('messages');
  if (!messages) {
    return { ok: true }; // No DB yet
  }

  // Find one encrypted message to test
  const sample = await messages.findOne(
    { _encrypted: true },
    { projection: { content: 1, _id: 1 } }
  );

  if (!sample) {
    logger.info('Decryption canary: no encrypted messages found — skipping');
    return { ok: true };
  }

  const content = (sample as any).content;
  if (!content || typeof content !== 'string' || !content.startsWith('enc:')) {
    return { ok: true }; // Not actually encrypted
  }

  if (canDecrypt(content)) {
    logger.info('Decryption canary: successfully decrypted sample message');
    return { ok: true };
  }

  return {
    ok: false,
    reason: `DECRYPTION CANARY FAILED!\n` +
            `  The current EMAIL_ENCRYPTION_KEY cannot decrypt existing encrypted data.\n` +
            `  This means the key has been changed and data will be UNREADABLE.\n` +
            `  Sample message ID: ${(sample as any)._id}\n\n` +
            `  Restore the correct key or set EMAIL_ENCRYPTION_KEY_PREVIOUS to the old key.`,
  };
};

/**
 * Master guard — runs all encryption safety checks at startup.
 * Call this BEFORE the server accepts any traffic.
 * 
 * If any check fails and ENCRYPTION_UNSAFE_SKIP_GUARDS is not set, throws an error
 * that will prevent the server from starting.
 */
export const ensureEncryptionKeyIntegrity = async (): Promise<void> => {
  if (!isEncryptionEnabled()) {
    logger.info('Encryption not enabled — key guards skipped');
    return;
  }

  const fingerprint = getKeyFingerprint();
  logger.info('Encryption key guard starting', { keyFingerprint: fingerprint });

  // 1. Verify key fingerprint lock
  const lockResult = await verifyKeyLock();
  if (!lockResult.ok) {
    logger.error('ENCRYPTION KEY LOCK FAILED', { reason: lockResult.reason });
    if (process.env.ENCRYPTION_UNSAFE_SKIP_GUARDS === 'true') {
      logger.warn('ENCRYPTION_UNSAFE_SKIP_GUARDS=true — proceeding despite key lock failure (DANGEROUS)');
    } else {
      throw new Error(`[ENCRYPTION KEY GUARD] ${lockResult.reason}`);
    }
  }

  // 2. Run decryption canary
  const canaryResult = await runDecryptionCanary();
  if (!canaryResult.ok) {
    logger.error('DECRYPTION CANARY FAILED', { reason: canaryResult.reason });
    if (process.env.ENCRYPTION_UNSAFE_SKIP_GUARDS === 'true') {
      logger.warn('ENCRYPTION_UNSAFE_SKIP_GUARDS=true — proceeding despite canary failure (DANGEROUS)');
    } else {
      throw new Error(`[DECRYPTION CANARY] ${canaryResult.reason}`);
    }
  }

  logger.info('Encryption key guard passed — all checks OK', { keyFingerprint: fingerprint });
};
