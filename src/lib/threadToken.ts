import crypto from 'crypto';

// HMAC secret for encoding thread IDs into opaque routing tokens.
// Falls back to a derivation of JWT_SECRET if THREAD_TOKEN_SECRET not set.
const THREAD_TOKEN_SECRET = process.env.THREAD_TOKEN_SECRET ||
  crypto.createHash('sha256')
    .update(process.env.JWT_SECRET || 'commune-default-secret')
    .update('thread-routing')
    .digest('hex');

/**
 * In-memory mapping from short token → thread_id.
 * This is a cache; the primary resolution path for inbound replies is
 * DB lookup by SMTP In-Reply-To/References headers. The plus-address
 * token is a secondary hint.
 *
 * For persistence across restarts, we also store the mapping in MongoDB
 * via messageStore (the message record already has thread_id + routing token).
 */
const tokenToThread = new Map<string, string>();
const threadToToken = new Map<string, string>();

/**
 * Encode a thread_id into a SHORT opaque routing token.
 *
 * The token is a 12-char hex HMAC — deterministic and collision-resistant.
 * Total plus-address: `agent+t12a4b6c8d0e2@domain.com` = well under 64 chars.
 *
 * The token is NOT reversible — we use an in-memory + DB lookup to map
 * it back to the thread_id on inbound. This is fine because:
 *   1. DB-backed SMTP header resolution is the primary threading path
 *   2. The plus-address token is a secondary hint for edge cases
 *
 * Example: agent+t1a2b3c4d5e6@domain.com
 */
export const encodeThreadToken = (threadId: string): string => {
  // Return cached token if we already generated one for this thread
  const cached = threadToToken.get(threadId);
  if (cached) return cached;

  const hmac = crypto
    .createHmac('sha256', THREAD_TOKEN_SECRET)
    .update(threadId)
    .digest('hex')
    .slice(0, 12); // 12 hex chars = 48 bits — enough for uniqueness

  const token = `t${hmac}`;

  // Cache both directions
  tokenToThread.set(token, threadId);
  threadToToken.set(threadId, token);

  return token;
};

/**
 * Decode a short routing token back to a thread_id.
 * Uses the in-memory cache. Returns null if unknown.
 *
 * For inbound emails, the primary resolution is DB-backed SMTP header
 * lookup (In-Reply-To / References). This is a secondary fallback.
 */
export const decodeThreadToken = (token: string): string | null => {
  // New short tokens: "t" + 12 hex chars
  if (token.startsWith('t') && token.length === 13 && /^t[0-9a-f]{12}$/.test(token)) {
    return tokenToThread.get(token) || null;
  }

  // Legacy format v2: "r-base64-sig" (hyphen separator)
  if (token.startsWith('r-')) {
    return decodeLegacyToken(token, '-');
  }

  // Legacy format v1: "r.base64.sig" (dot separator)
  if (token.startsWith('r.')) {
    return decodeLegacyToken(token, '.');
  }

  return null;
};

/**
 * Register a token→thread mapping (called when we learn about a token
 * from an inbound email or from the DB). This populates the in-memory
 * cache so decodeThreadToken can resolve it.
 */
export const registerThreadToken = (token: string, threadId: string): void => {
  tokenToThread.set(token, threadId);
  threadToToken.set(threadId, token);
};

// Decode legacy "r<sep>base64<sep>sig" format tokens
function decodeLegacyToken(token: string, sep: string): string | null {
  const rest = token.slice(2); // skip "r" + sep
  const sepIndex = rest.lastIndexOf(sep);
  if (sepIndex === -1) return null;

  const data = rest.slice(0, sepIndex);
  const sig = rest.slice(sepIndex + 1);

  const expectedSig = crypto
    .createHmac('sha256', THREAD_TOKEN_SECRET)
    .update(data)
    .digest('base64url')
    .slice(0, 8);

  if (sig.length !== expectedSig.length) return null;
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
