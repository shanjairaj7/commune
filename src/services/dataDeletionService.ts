import crypto from 'crypto';
import { getCollection } from '../db';
import type { DeletionScope, DeletionPreview, DeletionRequest } from '../types';
import logger from '../utils/logger';
import deletionRequestStore from '../stores/deletionRequestStore';

const CONFIRMATION_TOKEN_SECRET = process.env.JWT_SECRET || '';
const CONFIRMATION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// ── Token helpers ──────────────────────────────────────────────────────

const generateConfirmationToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

const hashToken = (token: string): string => {
  return crypto
    .createHmac('sha256', CONFIRMATION_TOKEN_SECRET)
    .update(token)
    .digest('hex');
};

const verifyToken = (token: string, storedHash: string): boolean => {
  const computed = hashToken(token);
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
};

// ── Inbox ID resolution ────────────────────────────────────────────────

/**
 * Get all inbox IDs belonging to an organization.
 * Needed because delivery_events, suppressions, alerts are keyed by inbox_id.
 */
const getOrgInboxIds = async (orgId: string): Promise<string[]> => {
  const domains = await getCollection('domains');
  if (!domains) return [];

  const orgDomains = await domains.find({ orgId }).toArray();
  const inboxIds: string[] = [];
  for (const domain of orgDomains) {
    if (Array.isArray((domain as any).inboxes)) {
      for (const inbox of (domain as any).inboxes) {
        if (inbox.id) inboxIds.push(inbox.id);
      }
    }
  }
  return inboxIds;
};

/**
 * Get all user IDs belonging to an organization.
 */
const getOrgUserIds = async (orgId: string): Promise<string[]> => {
  const users = await getCollection('users');
  if (!users) return [];
  const docs = await users.find({ orgId }, { projection: { id: 1 } }).toArray();
  return docs.map((d: any) => d.id);
};

/**
 * Get all message IDs for a given filter (for cascading attachment deletion).
 */
const getMessageIds = async (filter: Record<string, any>): Promise<string[]> => {
  const messages = await getCollection('messages');
  if (!messages) return [];
  const docs = await messages.find(filter, { projection: { message_id: 1 } }).toArray();
  return docs.map((d: any) => d.message_id);
};

// ── Preview (count what will be deleted) ───────────────────────────────

const previewOrganization = async (orgId: string): Promise<DeletionPreview> => {
  const inboxIds = await getOrgInboxIds(orgId);
  const userIds = await getOrgUserIds(orgId);

  const counts = await Promise.all([
    countDocs('messages', { orgId }),
    countDocs('attachments', { message_id: { $in: await getMessageIds({ orgId }) } }),
    countDocs('domains', { orgId: orgId }),
    countInboxes(orgId),
    countDocs('webhook_deliveries', { org_id: orgId }),
    inboxIds.length > 0 ? countDocs('delivery_events', { inbox_id: { $in: inboxIds } }) : 0,
    countDocs('blocked_spam_emails', { org_id: orgId }),
    countDocs('thread_metadata', { orgId }),
    countDocs('dmarc_reports', { org_id: orgId }),
    inboxIds.length > 0 ? countDocs('calculated_alerts', { inbox_id: { $in: inboxIds } }) : 0,
    inboxIds.length > 0 ? countDocs('suppressions', { inbox_id: { $in: inboxIds } }) : 0,
    countDocs('spam_reports', { reporter_org_id: orgId }),
    countDocs('audit_logs', { orgId }),
    countDocs('users', { orgId }),
    countDocs('api_keys', { orgId }),
    countDocs('sessions', userIds.length > 0 ? { userId: { $in: userIds } } : { _impossible: true }),
    countDocs('email_verification_tokens', userIds.length > 0 ? { userId: { $in: userIds } } : { _impossible: true }),
  ]);

  return {
    messages: counts[0],
    attachments: counts[1],
    domains: counts[2],
    inboxes: counts[3],
    webhook_deliveries: counts[4],
    delivery_events: counts[5] as number,
    blocked_spam: counts[6],
    thread_metadata: counts[7],
    dmarc_reports: counts[8],
    alerts: counts[9] as number,
    suppressions: counts[10] as number,
    spam_reports: counts[11],
    audit_logs: counts[12],
    users: counts[13],
    api_keys: counts[14],
    sessions: counts[15],
    verification_tokens: counts[16],
  };
};

const previewInbox = async (orgId: string, inboxId: string): Promise<DeletionPreview> => {
  const messageIds = await getMessageIds({ 'metadata.inbox_id': inboxId, orgId });

  const counts = await Promise.all([
    countDocs('messages', { 'metadata.inbox_id': inboxId, orgId }),
    messageIds.length > 0 ? countDocs('attachments', { message_id: { $in: messageIds } }) : 0,
    countDocs('webhook_deliveries', { inbox_id: inboxId }),
    countDocs('delivery_events', { inbox_id: inboxId }),
    countDocs('calculated_alerts', { inbox_id: inboxId }),
    countDocs('suppressions', { inbox_id: inboxId }),
  ]);

  return emptyPreview({
    messages: counts[0],
    attachments: counts[1] as number,
    inboxes: 1,
    webhook_deliveries: counts[2],
    delivery_events: counts[3],
    alerts: counts[4],
    suppressions: counts[5],
  });
};

const previewMessages = async (orgId: string, before?: string): Promise<DeletionPreview> => {
  const filter: Record<string, any> = { orgId };
  if (before) filter.created_at = { $lt: before };

  const messageIds = await getMessageIds(filter);
  const msgCount = messageIds.length;
  const attCount = msgCount > 0
    ? await countDocs('attachments', { message_id: { $in: messageIds } })
    : 0;

  return emptyPreview({
    messages: msgCount,
    attachments: attCount,
  });
};

// ── Execute deletion ──────────────────────────────────────────────────

const executeOrganization = async (orgId: string): Promise<Partial<DeletionPreview>> => {
  const inboxIds = await getOrgInboxIds(orgId);
  const userIds = await getOrgUserIds(orgId);
  const messageIds = await getMessageIds({ orgId });

  const deleted: Partial<DeletionPreview> = {};

  // 1. Attachments (cascade from messages)
  if (messageIds.length > 0) {
    deleted.attachments = await deleteDocs('attachments', { message_id: { $in: messageIds } });
  }

  // 2. Messages
  deleted.messages = await deleteDocs('messages', { orgId });

  // 3. Delivery events (by inbox)
  if (inboxIds.length > 0) {
    deleted.delivery_events = await deleteDocs('delivery_events', { inbox_id: { $in: inboxIds } });
    deleted.alerts = await deleteDocs('calculated_alerts', { inbox_id: { $in: inboxIds } });
    deleted.suppressions = await deleteDocs('suppressions', { inbox_id: { $in: inboxIds } });
  }

  // 4. Webhook deliveries
  deleted.webhook_deliveries = await deleteDocs('webhook_deliveries', { org_id: orgId });

  // 5. Blocked spam
  deleted.blocked_spam = await deleteDocs('blocked_spam_emails', { org_id: orgId });

  // 6. Thread metadata
  deleted.thread_metadata = await deleteDocs('thread_metadata', { orgId });

  // 7. DMARC reports
  deleted.dmarc_reports = await deleteDocs('dmarc_reports', { org_id: orgId });

  // 8. Spam reports
  deleted.spam_reports = await deleteDocs('spam_reports', { reporter_org_id: orgId });

  // 9. Domains (only org-owned — skip shared domains that have no orgId)
  deleted.domains = await deleteDocs('domains', { orgId });
  deleted.inboxes = inboxIds.length; // Inboxes are embedded in domains, deleted with them

  // 10. Sessions (by user)
  if (userIds.length > 0) {
    deleted.sessions = await deleteDocs('sessions', { userId: { $in: userIds } });
    deleted.verification_tokens = await deleteDocs('email_verification_tokens', { userId: { $in: userIds } });
  }

  // 11. API keys
  deleted.api_keys = await deleteDocs('api_keys', { orgId });

  // 12. Audit logs — log the deletion FIRST, then purge
  logger.info('Organization data deletion completed', { orgId, deleted });
  deleted.audit_logs = await deleteDocs('audit_logs', { orgId });

  // 13. Users
  deleted.users = await deleteDocs('users', { orgId });

  // 14. Organization itself — last
  await deleteDocs('organizations', { id: orgId });

  return deleted;
};

const executeInbox = async (orgId: string, inboxId: string): Promise<Partial<DeletionPreview>> => {
  const messageIds = await getMessageIds({ 'metadata.inbox_id': inboxId, orgId });
  const deleted: Partial<DeletionPreview> = {};

  // 1. Attachments
  if (messageIds.length > 0) {
    deleted.attachments = await deleteDocs('attachments', { message_id: { $in: messageIds } });
  }

  // 2. Messages
  deleted.messages = await deleteDocs('messages', { 'metadata.inbox_id': inboxId, orgId });

  // 3. Delivery events, alerts, suppressions
  deleted.delivery_events = await deleteDocs('delivery_events', { inbox_id: inboxId });
  deleted.alerts = await deleteDocs('calculated_alerts', { inbox_id: inboxId });
  deleted.suppressions = await deleteDocs('suppressions', { inbox_id: inboxId });

  // 4. Webhook deliveries
  deleted.webhook_deliveries = await deleteDocs('webhook_deliveries', { inbox_id: inboxId });

  // 5. Remove the inbox entry from its parent domain document
  const domains = await getCollection('domains');
  if (domains) {
    await domains.updateMany(
      { orgId, 'inboxes.id': inboxId },
      { $pull: { inboxes: { id: inboxId } } as any }
    );
  }
  deleted.inboxes = 1;

  logger.info('Inbox data deletion completed', { orgId, inboxId, deleted });
  return deleted;
};

const executeMessages = async (orgId: string, before?: string): Promise<Partial<DeletionPreview>> => {
  const filter: Record<string, any> = { orgId };
  if (before) filter.created_at = { $lt: before };

  const messageIds = await getMessageIds(filter);
  const deleted: Partial<DeletionPreview> = {};

  if (messageIds.length > 0) {
    deleted.attachments = await deleteDocs('attachments', { message_id: { $in: messageIds } });
  }
  deleted.messages = await deleteDocs('messages', filter);

  logger.info('Message data deletion completed', { orgId, before, deleted });
  return deleted;
};

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create a deletion request with preview counts and a confirmation token.
 * Returns the raw token (for the caller) — only the hash is stored.
 */
const createRequest = async (params: {
  orgId: string;
  scope: DeletionScope;
  inboxId?: string;
  before?: string;
  requestedBy: string;
}): Promise<{ request: DeletionRequest; confirmationToken: string }> => {
  // Check for existing active request
  const existing = await deletionRequestStore.getActiveForOrg(params.orgId);
  if (existing) {
    throw new Error('An active deletion request already exists for this organization. Wait for it to expire or complete.');
  }

  // Validate inbox scope
  if (params.scope === 'inbox' && !params.inboxId) {
    throw new Error('inbox_id is required for inbox-scoped deletion');
  }

  // Generate preview
  let preview: DeletionPreview;
  switch (params.scope) {
    case 'organization':
      preview = await previewOrganization(params.orgId);
      break;
    case 'inbox':
      preview = await previewInbox(params.orgId, params.inboxId!);
      break;
    case 'messages':
      preview = await previewMessages(params.orgId, params.before);
      break;
    default:
      throw new Error(`Invalid scope: ${params.scope}`);
  }

  // Generate confirmation token
  const confirmationToken = generateConfirmationToken();
  const confirmationTokenHash = hashToken(confirmationToken);
  const confirmBy = new Date(Date.now() + CONFIRMATION_EXPIRY_MS).toISOString();

  const request = await deletionRequestStore.create({
    org_id: params.orgId,
    scope: params.scope,
    inbox_id: params.inboxId,
    before: params.before,
    status: 'pending',
    preview,
    confirmation_token_hash: confirmationTokenHash,
    confirm_by: confirmBy,
    requested_at: new Date().toISOString(),
    requested_by: params.requestedBy,
  });

  logger.info('Deletion request created', {
    requestId: request.id,
    orgId: params.orgId,
    scope: params.scope,
    inboxId: params.inboxId,
    totalDocuments: (Object.values(preview) as number[]).reduce((a, b) => a + b, 0),
  });

  return { request, confirmationToken };
};

/**
 * Confirm and execute a deletion request.
 */
const confirmRequest = async (requestId: string, confirmationToken: string): Promise<DeletionRequest> => {
  const request = await deletionRequestStore.getById(requestId);
  if (!request) {
    throw new Error('Deletion request not found');
  }

  if (request.status !== 'pending') {
    throw new Error(`Deletion request is ${request.status}, cannot confirm`);
  }

  // Check expiry
  if (new Date(request.confirm_by) < new Date()) {
    await deletionRequestStore.updateStatus(requestId, 'expired');
    throw new Error('Confirmation token has expired. Create a new deletion request.');
  }

  // Verify token
  if (!verifyToken(confirmationToken, request.confirmation_token_hash)) {
    throw new Error('Invalid confirmation token');
  }

  // Mark as executing
  await deletionRequestStore.updateStatus(requestId, 'executing', {
    confirmed_at: new Date().toISOString(),
  });

  try {
    let deletedCounts: Partial<DeletionPreview>;

    switch (request.scope) {
      case 'organization':
        deletedCounts = await executeOrganization(request.org_id);
        break;
      case 'inbox':
        deletedCounts = await executeInbox(request.org_id, request.inbox_id!);
        break;
      case 'messages':
        deletedCounts = await executeMessages(request.org_id, request.before);
        break;
      default:
        throw new Error(`Invalid scope: ${request.scope}`);
    }

    await deletionRequestStore.updateStatus(requestId, 'completed', {
      deleted_counts: deletedCounts,
      completed_at: new Date().toISOString(),
    });

    const updated = await deletionRequestStore.getById(requestId);
    return updated!;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Deletion execution failed', { requestId, error: errorMessage });

    await deletionRequestStore.updateStatus(requestId, 'failed', {
      error: errorMessage,
      completed_at: new Date().toISOString(),
    });

    throw new Error(`Deletion failed: ${errorMessage}`);
  }
};

/**
 * Get status of a deletion request.
 */
const getRequest = async (requestId: string, orgId: string): Promise<DeletionRequest | null> => {
  const request = await deletionRequestStore.getById(requestId);
  if (!request || request.org_id !== orgId) return null;
  return request;
};

// ── Helpers ────────────────────────────────────────────────────────────

const countDocs = async (collection: string, filter: Record<string, any>): Promise<number> => {
  const col = await getCollection(collection);
  if (!col) return 0;
  return col.countDocuments(filter);
};

const deleteDocs = async (collection: string, filter: Record<string, any>): Promise<number> => {
  const col = await getCollection(collection);
  if (!col) return 0;
  const result = await col.deleteMany(filter);
  return result.deletedCount;
};

const countInboxes = async (orgId: string): Promise<number> => {
  const domains = await getCollection('domains');
  if (!domains) return 0;
  const orgDomains = await domains.find({ orgId }).toArray();
  let count = 0;
  for (const d of orgDomains) {
    if (Array.isArray((d as any).inboxes)) count += (d as any).inboxes.length;
  }
  return count;
};

const emptyPreview = (overrides: Partial<DeletionPreview> = {}): DeletionPreview => ({
  messages: 0,
  attachments: 0,
  domains: 0,
  inboxes: 0,
  webhook_deliveries: 0,
  delivery_events: 0,
  blocked_spam: 0,
  thread_metadata: 0,
  dmarc_reports: 0,
  alerts: 0,
  suppressions: 0,
  spam_reports: 0,
  audit_logs: 0,
  users: 0,
  api_keys: 0,
  sessions: 0,
  verification_tokens: 0,
  ...overrides,
});

export default {
  createRequest,
  confirmRequest,
  getRequest,
};
