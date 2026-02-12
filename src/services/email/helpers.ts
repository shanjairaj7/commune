import domainStore from '../../stores/domainStore';
import domainService from '../domainService';
import resendHttp from '../resendHttp';
import { decodeThreadToken } from '../../lib/threadToken';
import type { DomainEntry } from '../../types';
import logger from '../../utils/logger';

const normalizeRecipient = (value: unknown) => {
  const addr = extractEmailAddress(value);
  if (!addr) {
    return null;
  }
  const [localPartRaw, domainRaw] = addr.split('@');
  const localPart = (localPartRaw || '').trim().toLowerCase();
  const domain = (domainRaw || '').trim().toLowerCase();
  if (!localPart || !domain) {
    return null;
  }
  return {
    raw: addr,
    normalized: `${localPart}@${domain}`,
    localPart,
    localPartBase: localPart.split('+')[0],
    domain,
  };
};

const extractEmailAddress = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  const candidate = (match ? match[1] : trimmed).trim();
  if (!candidate.includes('@')) {
    return null;
  }
  return candidate;
};

const extractThreadTag = (localPart?: string | null) => {
  if (!localPart) {
    return null;
  }
  const plusIndex = localPart.indexOf('+');
  if (plusIndex === -1) {
    return null;
  }
  const tag = localPart.slice(plusIndex + 1);
  if (!tag) {
    return null;
  }

  // New short tokens: "t" + 12 hex chars (e.g. "t1a2b3c4d5e6")
  if (/^t[0-9a-f]{12}$/.test(tag)) {
    const threadId = decodeThreadToken(tag);
    return threadId; // null if not in cache
  }

  // Legacy opaque routing tokens: "r.<base64>.<sig>" or "r-<base64>-<sig>"
  if (tag.startsWith('r.') || tag.startsWith('r-')) {
    const threadId = decodeThreadToken(tag);
    return threadId; // null if invalid/tampered
  }

  // Legacy support: raw thread_/conv_ prefixes (backwards compat)
  if (tag.startsWith('thread_') || tag.startsWith('conv_')) {
    return tag;
  }

  return null;
};

const inferDomainFromPayload = async (
  body: string,
  domainIdFromQuery?: string
): Promise<{ domainId: string | null; domainEntry: DomainEntry | null; threadTag: string | null; rawRoutingToken: string | null }> => {
  if (domainIdFromQuery) {
    const entry = await domainStore.getDomain(domainIdFromQuery);
    return { domainId: domainIdFromQuery, domainEntry: entry, threadTag: null, rawRoutingToken: null };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { domainId: null, domainEntry: null, threadTag: null, rawRoutingToken: null };
  }

  const eventType = String(parsed?.type || '');
  const toList = Array.isArray(parsed?.data?.to) ? parsed.data.to : [];
  const fromValue = parsed?.data?.from;
  const parsedRecipients = toList
    .map((recipient: unknown) => normalizeRecipient(recipient))
    .filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeRecipient>>>;
  // Extract thread tag from plus-addressed recipients.
  // For short tokens (t+12hex), decodeThreadToken uses in-memory cache.
  // If cache miss, we'll do a DB lookup later in handleInboundWebhook.
  let inboundThreadTag =
    parsedRecipients
      .map((recipient) => extractThreadTag(recipient.localPart))
      .find(Boolean) || null;

  // If no thread tag resolved but there's a short token in the address,
  // extract the raw token for DB fallback lookup later.
  let rawRoutingToken: string | null = null;
  if (!inboundThreadTag) {
    for (const r of parsedRecipients) {
      const plusIdx = r.localPart.indexOf('+');
      if (plusIdx !== -1) {
        const tag = r.localPart.slice(plusIdx + 1);
        if (/^t[0-9a-f]{12}$/.test(tag)) {
          rawRoutingToken = tag;
          break;
        }
      }
    }
  }

  const fromRecipient = fromValue ? normalizeRecipient(fromValue) : null;
  const toDomain = parsedRecipients[0]?.domain || null;

  // For inbound emails (email.received), the domain is the recipient (to).
  // For outbound events (email.sent/delivered/etc), the domain is the sender (from).
  const primaryDomain =
    eventType === 'email.received'
      ? toDomain
      : fromRecipient?.domain || toDomain;

  if (!primaryDomain) {
    return { domainId: domainIdFromQuery || null, domainEntry: null, threadTag: inboundThreadTag, rawRoutingToken };
  }

  const domainEntry = await domainStore.getDomainByName(primaryDomain);
  return { domainId: domainEntry?.id || null, domainEntry, threadTag: inboundThreadTag, rawRoutingToken };
};

// ─── Webhook Secret Resolution ─────────────────────────────────────────────

const SHARED_WEBHOOK_SECRET = process.env.RESEND_SHARED_WEBHOOK_SECRET;

const ensureWebhookSecret = async (domainId: string) => {
  if (SHARED_WEBHOOK_SECRET) {
    return SHARED_WEBHOOK_SECRET;
  }
  
  let stored = await domainStore.getDomain(domainId);
  
  if (stored && stored.webhook && stored.webhook.secret) {
    return stored.webhook.secret;
  }

  await domainService.createInboundWebhook(domainId);
  stored = await domainStore.getDomain(domainId);
  if (stored && stored.webhook && stored.webhook.secret) {
    return stored.webhook.secret;
  }

  const endpoint = process.env.PUBLIC_WEBHOOK_BASE_URL
    ? `${process.env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/webhooks/resend/${domainId}`
    : null;

  if (!endpoint) {
    logger.warn('Webhook secret resolution failed: missing PUBLIC_WEBHOOK_BASE_URL');
    return null;
  }

  const { data, error } = await resendHttp.listWebhooks();
  if (error) {
    logger.warn('Failed to fetch webhooks from Resend');
    return null;
  }

  const webhooks = (data as any).data || data;
  const match = Array.isArray(webhooks)
    ? webhooks.find((item) => item.endpoint === endpoint)
    : null;

  if (!match) {
    return null;
  }

  const secret = match.secret || match.signing_secret || match.webhook_secret || null;

  if (!secret) {
    return null;
  }

  await domainStore.upsertDomain({
    id: domainId,
    webhook: {
      id: match.id,
      endpoint: match.endpoint,
      events: match.events,
      secret,
    },
  });

  return secret as string;
};

// ─── Webhook Idempotency ─────────────────────────────────────────────────────
// Track processed svix-ids to prevent duplicate processing.
// Uses Redis when available, falls back to in-memory LRU.
const processedWebhookIds = new Map<string, number>(); // svix-id → timestamp
const WEBHOOK_DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const WEBHOOK_DEDUP_MAX_SIZE = 10000;

const isWebhookDuplicate = async (svixId: string): Promise<boolean> => {
  // Try Redis first
  try {
    const { getRedisClient } = await import('../../lib/redis');
    const redis = getRedisClient();
    if (redis) {
      const key = `webhook:dedup:${svixId}`;
      const exists = await redis.get(key);
      if (exists) return true;
      await redis.set(key, '1', 'EX', 3600); // 1 hour TTL
      return false;
    }
  } catch {
    // Redis unavailable, fall through to in-memory
  }

  // In-memory fallback
  if (processedWebhookIds.has(svixId)) return true;

  // Evict old entries if at capacity
  if (processedWebhookIds.size >= WEBHOOK_DEDUP_MAX_SIZE) {
    const now = Date.now();
    for (const [id, ts] of processedWebhookIds) {
      if (now - ts > WEBHOOK_DEDUP_TTL_MS) processedWebhookIds.delete(id);
    }
    // If still full, remove oldest
    if (processedWebhookIds.size >= WEBHOOK_DEDUP_MAX_SIZE) {
      const oldest = processedWebhookIds.keys().next().value;
      if (oldest) processedWebhookIds.delete(oldest);
    }
  }

  processedWebhookIds.set(svixId, Date.now());
  return false;
};

export {
  extractEmailAddress,
  normalizeRecipient,
  extractThreadTag,
  inferDomainFromPayload,
  ensureWebhookSecret,
  isWebhookDuplicate,
};
