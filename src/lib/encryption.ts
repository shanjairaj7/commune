import crypto from 'crypto';
import logger from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32; // 256-bit key

// ─── Primary encryption key ────────────────────────────────────
const ENCRYPTION_KEY_HEX = process.env.EMAIL_ENCRYPTION_KEY;
let encryptionKey: Buffer | null = null;

if (ENCRYPTION_KEY_HEX) {
  if (ENCRYPTION_KEY_HEX.length !== 64) {
    logger.error('EMAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  } else {
    encryptionKey = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
    logger.info('Email encryption at rest enabled (AES-256-GCM)');
  }
} else {
  logger.warn('EMAIL_ENCRYPTION_KEY not set — email content will be stored unencrypted');
}

// ─── Previous encryption key (for safe key rotation) ──────────
// Set EMAIL_ENCRYPTION_KEY_PREVIOUS to the OLD key when rotating.
// Decrypt will try the current key first, then fall back to the previous key.
const PREV_KEY_HEX = process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS;
let previousEncryptionKey: Buffer | null = null;

if (PREV_KEY_HEX) {
  if (PREV_KEY_HEX.length !== 64) {
    logger.error('EMAIL_ENCRYPTION_KEY_PREVIOUS must be exactly 64 hex characters (32 bytes)');
  } else {
    previousEncryptionKey = Buffer.from(PREV_KEY_HEX, 'hex');
    logger.info('Previous encryption key loaded for rotation fallback');
  }
}

export const isEncryptionEnabled = (): boolean => !!encryptionKey;

/**
 * Get a SHA-256 fingerprint of the current encryption key.
 * Used for key lock verification — never logs or stores the actual key.
 */
export const getKeyFingerprint = (): string | null => {
  if (!encryptionKey) return null;
  return crypto.createHash('sha256').update(encryptionKey).digest('hex').substring(0, 16);
};

/**
 * Create a deterministic SHA-256 hash of a value for indexed lookups.
 * Used to enable exact-match queries on encrypted fields (e.g. participant emails)
 * without exposing the plaintext in the database.
 */
export const hashForLookup = (value: string): string => {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
};

/**
 * Generate a new random encryption key (for initial setup).
 * Returns a 64-character hex string.
 */
export const generateEncryptionKey = (): string => {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
};

/**
 * Encrypt a string using AES-256-GCM.
 * Returns a base64 string containing: IV (12B) + ciphertext + authTag (16B)
 * 
 * If encryption is not configured, returns the plaintext unchanged.
 */
export const encrypt = (plaintext: string): string => {
  if (!encryptionKey || !plaintext) {
    return plaintext;
  }
  // Guard against double-encryption
  if (plaintext.startsWith('enc:')) {
    return plaintext;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Pack: IV + ciphertext + authTag
    const packed = Buffer.concat([iv, encrypted, authTag]);
    return `enc:${packed.toString('base64')}`;
  } catch (err) {
    logger.error('Encryption failed', { error: err });
    return plaintext; // Fail open — don't lose the data
  }
};

/**
 * Attempt to decrypt with a specific key buffer.
 * Returns null on failure (does not throw).
 */
const decryptWithKey = (ciphertext: string, key: Buffer): string | null => {
  try {
    const packed = Buffer.from(ciphertext.slice(4), 'base64');
    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
    const encrypted = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
};

export const decrypt = (ciphertext: string): string => {
  if (!encryptionKey || !ciphertext) {
    return ciphertext;
  }

  // If not encrypted (no prefix), return as-is
  if (!ciphertext.startsWith('enc:')) {
    return ciphertext;
  }

  // Try current key first
  const result = decryptWithKey(ciphertext, encryptionKey);
  if (result !== null) return result;

  // Fall back to previous key (for rotation)
  if (previousEncryptionKey) {
    const prevResult = decryptWithKey(ciphertext, previousEncryptionKey);
    if (prevResult !== null) {
      logger.info('Decrypted with previous key (rotation in progress)');
      return prevResult;
    }
  }

  logger.error('Decryption failed with all available keys');
  return ciphertext; // Return raw — better than losing data
};

/**
 * Test if a specific ciphertext can be decrypted with the current key.
 * Used by the startup canary check.
 */
export const canDecrypt = (ciphertext: string): boolean => {
  if (!encryptionKey || !ciphertext || !ciphertext.startsWith('enc:')) return false;
  return decryptWithKey(ciphertext, encryptionKey) !== null;
};

/**
 * Encrypt sensitive fields of a message object before storage.
 * Encrypts: content, content_html, metadata.subject, participants[].identity,
 *           metadata.extracted_data
 *
 * Participant identities (email addresses) are encrypted individually.
 * The original identity is stored in _identity_hash (SHA-256 of lowercased email)
 * to allow exact-match lookups without decryption.
 */
export const encryptMessageFields = (message: any): any => {
  if (!isEncryptionEnabled()) return message;

  const encrypted = { ...message };
  
  if (encrypted.content) {
    encrypted.content = encrypt(encrypted.content);
  }
  if (encrypted.content_html) {
    encrypted.content_html = encrypt(encrypted.content_html);
  }
  if (encrypted.metadata?.subject) {
    encrypted.metadata = {
      ...encrypted.metadata,
      subject: encrypt(encrypted.metadata.subject),
    };
  }

  // Encrypt participant email addresses
  if (Array.isArray(encrypted.participants)) {
    encrypted.participants = encrypted.participants.map((p: any) => {
      if (!p.identity) return p;
      return {
        ...p,
        _identity_hash: hashForLookup(p.identity),
        identity: encrypt(p.identity),
      };
    });
  }

  // Encrypt extracted data (structured extraction results)
  if (encrypted.metadata?.extracted_data) {
    encrypted.metadata = {
      ...encrypted.metadata,
      extracted_data: encrypt(JSON.stringify(encrypted.metadata.extracted_data)),
    };
  }

  encrypted._encrypted = true;
  return encrypted;
};

/**
 * Decrypt sensitive fields of a message object after retrieval.
 */
export const decryptMessageFields = (message: any): any => {
  if (!message || !message._encrypted) return message;

  const decrypted = { ...message };

  if (decrypted.content) {
    decrypted.content = decrypt(decrypted.content);
  }
  if (decrypted.content_html) {
    decrypted.content_html = decrypt(decrypted.content_html);
  }
  if (decrypted.metadata?.subject) {
    decrypted.metadata = {
      ...decrypted.metadata,
      subject: decrypt(decrypted.metadata.subject),
    };
  }

  // Decrypt participant email addresses
  if (Array.isArray(decrypted.participants)) {
    decrypted.participants = decrypted.participants.map((p: any) => {
      if (!p.identity) return p;
      const restored = decrypt(p.identity);
      // Remove the lookup hash from API responses
      const { _identity_hash, ...rest } = p;
      return { ...rest, identity: restored };
    });
  }

  // Decrypt extracted data
  if (decrypted.metadata?.extracted_data && typeof decrypted.metadata.extracted_data === 'string') {
    try {
      const raw = decrypt(decrypted.metadata.extracted_data);
      decrypted.metadata = {
        ...decrypted.metadata,
        extracted_data: JSON.parse(raw),
      };
    } catch {
      // If decryption/parsing fails, leave as-is (could be legacy unencrypted JSON)
    }
  }

  return decrypted;
};

/**
 * Encrypt attachment content_base64 before storage.
 */
export const encryptAttachmentContent = (content: string | null): string | null => {
  if (!content || !isEncryptionEnabled()) return content;
  return encrypt(content);
};

/**
 * Decrypt attachment content_base64 after retrieval.
 */
export const decryptAttachmentContent = (content: string | null): string | null => {
  if (!content) return content;
  return decrypt(content);
};

/**
 * Encrypt a JSON-serializable object (e.g. webhook payload) for at-rest storage.
 * Returns the encrypted string, or the original object if encryption is disabled.
 */
export const encryptJsonPayload = (payload: Record<string, any>): string | Record<string, any> => {
  if (!isEncryptionEnabled()) return payload;
  try {
    return encrypt(JSON.stringify(payload));
  } catch {
    return payload;
  }
};

/**
 * Decrypt a JSON payload that was encrypted with encryptJsonPayload().
 * Handles both encrypted strings and legacy unencrypted objects.
 */
export const decryptJsonPayload = (stored: string | Record<string, any>): Record<string, any> => {
  if (!stored) return {};
  // If it's already an object (unencrypted legacy data), return as-is
  if (typeof stored === 'object') return stored;
  // If it's an encrypted string
  if (typeof stored === 'string' && stored.startsWith('enc:')) {
    try {
      const decrypted = decrypt(stored);
      return JSON.parse(decrypted);
    } catch {
      return {};
    }
  }
  // Plain JSON string (unlikely but safe)
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
};

/**
 * Encrypt a single sensitive string field (e.g. webhook secret) for at-rest storage.
 * Returns the encrypted string, or the original if encryption is disabled.
 */
export const encryptSecretField = (value: string | null | undefined): string | null | undefined => {
  if (!value || !isEncryptionEnabled()) return value;
  // Guard against double-encryption
  if (value.startsWith('enc:')) return value;
  return encrypt(value);
};

/**
 * Decrypt a single sensitive string field.
 * Handles both encrypted and legacy plaintext values.
 */
export const decryptSecretField = (value: string | null | undefined): string | null | undefined => {
  if (!value) return value;
  return decrypt(value);
};
