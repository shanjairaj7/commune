import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message, Artifact } from '@a2a-js/sdk';
import { CommuneUser } from './userBuilder';
import messageStore from '../stores/messageStore';
import domainStore from '../stores/domainStore';
import deliveryEventStore from '../stores/deliveryEventStore';
import emailService from '../services/email';
import { getOutboundEmailQueue } from '../workers/outboundEmailWorker';
import type { EmailSearchFilter } from '../types/search';
import crypto from 'crypto';
import logger from '../utils/logger';

// ── Types for parsed skill input ────────────────────────────────────────────

interface SendEmailInput {
  to: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  thread_id?: string;
  inbox_id?: string;
  domain_id?: string;
  from?: string;
}

interface ReadThreadInput {
  thread_id: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

interface SearchInboxInput {
  query: string;
  inbox_id?: string;
  domain_id?: string;
  limit?: number;
}

interface ListThreadsInput {
  inbox_id?: string;
  domain_id?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

interface DeliveryStatusInput {
  inbox_id?: string;
  domain_id?: string;
  message_id?: string;
  days?: number;
}

interface CreateInboxInput {
  local_part: string;
  domain_id?: string;
  display_name?: string;
}

interface ListInboxesInput {
  domain_id?: string;
}

// ── Skill routing ───────────────────────────────────────────────────────────

type SkillId =
  | 'send_email'
  | 'read_thread'
  | 'search_inbox'
  | 'list_threads'
  | 'get_delivery_status'
  | 'create_inbox'
  | 'list_inboxes';

/**
 * Extract the skill ID and structured input from an A2A message.
 *
 * The A2A protocol sends messages as Parts. We support two patterns:
 *   1. DataPart with { skill, ...params } (structured, preferred by agent frameworks)
 *   2. TextPart with natural language (we try to parse JSON, else infer skill)
 */
function parseSkillRequest(message: Message): { skill: SkillId; input: Record<string, unknown> } | null {
  for (const part of message.parts) {
    // DataPart — structured JSON input
    if (part.kind === 'data' && part.data) {
      const data = part.data as Record<string, unknown>;
      const skill = data.skill as SkillId | undefined;
      if (skill) {
        const { skill: _, ...input } = data;
        return { skill, input };
      }
      // If no explicit skill field, try to infer from the data shape
      if (data.to) return { skill: 'send_email', input: data };
      if (data.thread_id && !data.query) return { skill: 'read_thread', input: data };
      if (data.query) return { skill: 'search_inbox', input: data };
      if (data.local_part) return { skill: 'create_inbox', input: data };
    }

    // TextPart — try JSON first, then fall back to text inference
    if (part.kind === 'text' && part.text) {
      try {
        const parsed = JSON.parse(part.text);
        if (typeof parsed === 'object' && parsed !== null) {
          const skill = parsed.skill as SkillId | undefined;
          if (skill) {
            const { skill: _, ...input } = parsed;
            return { skill, input };
          }
        }
      } catch {
        // Not JSON — that's fine, we can try to handle it as natural language later
        // For now, return null and let the executor report what skills are available
      }
    }
  }
  return null;
}

// ── Skill implementations ───────────────────────────────────────────────────

async function executeSendEmail(input: SendEmailInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.to) throw new Error('Missing required field: to');
  if (!input.html && !input.text) throw new Error('Missing required field: html or text');

  const preGeneratedId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const preGeneratedThreadId = input.thread_id || `thread_${crypto.randomUUID()}`;

  const payload = {
    channel: 'email' as const,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    cc: input.cc,
    bcc: input.bcc,
    reply_to: input.reply_to,
    thread_id: input.thread_id,
    inboxId: input.inbox_id,
    domainId: input.domain_id,
    from: input.from,
    _messageId: preGeneratedId,
  };

  const queue = getOutboundEmailQueue();
  if (queue) {
    const jitterMs = Math.floor(Math.random() * 2000);
    await queue.add('send', { payload: { ...payload, orgId, thread_id: preGeneratedThreadId } }, { delay: jitterMs });
    return { id: preGeneratedId, thread_id: preGeneratedThreadId, status: 'queued' };
  }

  // Fallback to synchronous send (no BullMQ queue available)
  await emailService.sendEmail({ ...payload, orgId } as any);
  return { id: preGeneratedId, thread_id: preGeneratedThreadId, status: 'sent' };
}

async function executeReadThread(input: ReadThreadInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.thread_id) throw new Error('Missing required field: thread_id');
  const messages = await messageStore.getMessagesByThread(
    input.thread_id,
    Math.min(input.limit || 50, 1000),
    input.order || 'asc',
    orgId,
  );
  return { thread_id: input.thread_id, messages, message_count: messages.length };
}

async function executeSearchInbox(input: SearchInboxInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.query) throw new Error('Missing required field: query');
  if (!input.inbox_id && !input.domain_id) {
    throw new Error('At least one filter required: inbox_id or domain_id');
  }

  // Try vector search first
  let vectorResults: any[] | null = null;
  try {
    if (process.env.QDRANT_URL && process.env.AZURE_OPENAI_EMBEDDING_API_KEY) {
      const { SearchService } = await import('../services/searchService');
      const searchService = SearchService.getInstance();
      const filter: EmailSearchFilter = {
        organizationId: orgId,
        channel: 'email',
        inboxIds: input.inbox_id ? [input.inbox_id] : undefined,
        domainId: input.domain_id,
      };
      const results = await searchService.search(orgId, input.query, filter, {
        limit: input.limit || 20,
        minScore: 0.15,
      });
      if (results && results.length > 0) {
        vectorResults = results.map((r) => ({
          thread_id: r.metadata.threadId,
          subject: 'subject' in r.metadata ? r.metadata.subject : undefined,
          score: r.score,
          inbox_id: 'inboxId' in r.metadata ? r.metadata.inboxId : undefined,
          participants: r.metadata.participants,
        }));
      }
    }
  } catch {
    // Vector search unavailable, fall through to regex
  }

  if (vectorResults) {
    return { results: vectorResults, search_type: 'vector', count: vectorResults.length };
  }

  // Fallback to regex search
  const results = await messageStore.searchThreads({
    query: input.query,
    inboxId: input.inbox_id,
    domainId: input.domain_id,
    orgId,
    limit: input.limit || 20,
  });
  return { results, search_type: 'regex', count: results.length };
}

async function executeListThreads(input: ListThreadsInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.inbox_id && !input.domain_id) {
    throw new Error('At least one filter required: inbox_id or domain_id');
  }
  const result = await messageStore.listThreads({
    inboxId: input.inbox_id,
    domainId: input.domain_id,
    limit: Math.min(input.limit || 20, 100),
    cursor: input.cursor,
    order: input.order || 'desc',
    orgId,
  });
  return { threads: result.threads, next_cursor: result.next_cursor, has_more: result.next_cursor !== null };
}

async function executeDeliveryStatus(input: DeliveryStatusInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.inbox_id && !input.domain_id && !input.message_id) {
    throw new Error('At least one filter required: inbox_id, domain_id, or message_id');
  }

  const result: Record<string, unknown> = {};

  // Get metrics if inbox or domain filter provided
  if (input.inbox_id || input.domain_id) {
    const days = Math.min(input.days || 7, 90);
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const metrics = await messageStore.getInboxDeliveryMetrics(
      input.inbox_id,
      startDate,
      endDate,
      input.domain_id,
    );
    result.metrics = {
      ...metrics,
      period: { start: startDate.toISOString(), end: endDate.toISOString(), days },
      delivery_rate: metrics.sent > 0 ? `${((metrics.delivered / metrics.sent) * 100).toFixed(1)}%` : 'N/A',
      bounce_rate: metrics.sent > 0 ? `${((metrics.bounced / metrics.sent) * 100).toFixed(1)}%` : 'N/A',
    };
  }

  // Get recent events
  const events = await deliveryEventStore.getEvents({
    inboxId: input.inbox_id,
    domainId: input.domain_id,
    messageId: input.message_id,
    limit: 20,
  });
  result.events = events;

  return result;
}

async function executeCreateInbox(input: CreateInboxInput, orgId: string): Promise<Record<string, unknown>> {
  if (!input.local_part) throw new Error('Missing required field: local_part');

  let domainId = input.domain_id;
  let domainName: string | undefined;

  if (!domainId) {
    // Auto-resolve domain for org
    const domains = await domainStore.listDomains(orgId);
    if (domains.length > 0 && domains[0].name) {
      domainId = domains[0].id;
      domainName = domains[0].name;
    } else {
      // Use default shared domain
      const { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } = await import('../config/freeTierConfig');
      domainId = DEFAULT_DOMAIN_ID;
      domainName = DEFAULT_DOMAIN_NAME;
    }
  } else {
    const domain = await domainStore.getDomain(domainId);
    if (!domain) throw new Error('Domain not found');
    domainName = domain.name;
  }

  const inboxId = `inbox_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const inbox = await domainStore.upsertInbox({
    domainId,
    inbox: {
      id: inboxId,
      localPart: input.local_part,
      displayName: input.display_name || undefined,
      createdAt: new Date().toISOString(),
    },
    orgId,
  });

  if (!inbox) throw new Error('Failed to create inbox');

  return {
    id: inbox.id,
    email: `${input.local_part}@${domainName}`,
    local_part: input.local_part,
    domain_id: domainId,
    display_name: input.display_name || null,
  };
}

async function executeListInboxes(input: ListInboxesInput, orgId: string): Promise<Record<string, unknown>> {
  if (input.domain_id) {
    const inboxes = await domainStore.listInboxes(input.domain_id, orgId);
    return { inboxes, count: inboxes.length };
  }

  // List inboxes across all org domains
  const domains = await domainStore.listDomains(orgId);
  const allInboxes: any[] = [];
  for (const domain of domains) {
    const inboxes = await domainStore.listInboxes(domain.id, orgId);
    for (const inbox of inboxes) {
      allInboxes.push({ ...inbox, domain_id: domain.id, domain_name: domain.name });
    }
  }

  // Also check default domain
  const { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } = await import('../config/freeTierConfig');
  const defaultInboxes = await domainStore.listInboxes(DEFAULT_DOMAIN_ID, orgId);
  for (const inbox of defaultInboxes) {
    allInboxes.push({ ...inbox, domain_id: DEFAULT_DOMAIN_ID, domain_name: DEFAULT_DOMAIN_NAME });
  }

  return { inboxes: allInboxes, count: allInboxes.length };
}

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * CommuneAgentExecutor implements the A2A AgentExecutor interface.
 *
 * It routes incoming A2A messages to the appropriate Commune email operation
 * and publishes task lifecycle events back through the event bus.
 */
export class CommuneAgentExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const user = requestContext.context?.user;

    // Extract org context from authenticated user
    const orgId = user instanceof CommuneUser ? user.orgId : null;
    if (!orgId) {
      this.publishError(eventBus, taskId, contextId, 'Authentication required. Provide a Commune API key via Authorization: Bearer comm_xxx header.');
      return;
    }

    // Parse the skill request from the message
    const parsed = parseSkillRequest(userMessage);
    if (!parsed) {
      this.publishError(
        eventBus,
        taskId,
        contextId,
        'Could not determine the requested skill. Send a DataPart with { "skill": "<skill_id>", ...params } or a JSON TextPart. ' +
        'Available skills: send_email, read_thread, search_inbox, list_threads, get_delivery_status, create_inbox, list_inboxes.',
      );
      return;
    }

    const { skill, input } = parsed;

    // Publish working status
    eventBus.publish({
      kind: 'status-update',
      taskId,
      status: { state: 'working' as const, timestamp: new Date().toISOString() },
      final: false,
    } as any);

    try {
      let result: Record<string, unknown>;

      switch (skill) {
        case 'send_email':
          result = await executeSendEmail(input as unknown as SendEmailInput, orgId);
          break;
        case 'read_thread':
          result = await executeReadThread(input as unknown as ReadThreadInput, orgId);
          break;
        case 'search_inbox':
          result = await executeSearchInbox(input as unknown as SearchInboxInput, orgId);
          break;
        case 'list_threads':
          result = await executeListThreads(input as unknown as ListThreadsInput, orgId);
          break;
        case 'get_delivery_status':
          result = await executeDeliveryStatus(input as unknown as DeliveryStatusInput, orgId);
          break;
        case 'create_inbox':
          result = await executeCreateInbox(input as unknown as CreateInboxInput, orgId);
          break;
        case 'list_inboxes':
          result = await executeListInboxes(input as unknown as ListInboxesInput, orgId);
          break;
        default:
          this.publishError(eventBus, taskId, contextId, `Unknown skill: ${skill}`);
          return;
      }

      // Publish the result as an artifact
      const artifact: Artifact = {
        artifactId: `artifact_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        parts: [{ kind: 'data', data: { skill, ...result } }],
      };

      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        artifact,
      } as any);

      // Publish completed status
      eventBus.publish({
        kind: 'status-update',
        taskId,
        status: {
          state: 'completed' as const,
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            parts: [{ kind: 'text', text: `${skill} completed successfully.` }],
          },
        },
        final: true,
      } as any);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error('A2A skill execution failed', { skill, orgId, error: errorMessage });
      this.publishError(eventBus, taskId, contextId, `${skill} failed: ${errorMessage}`);
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      status: {
        state: 'canceled' as const,
        timestamp: new Date().toISOString(),
        message: { role: 'agent', parts: [{ kind: 'text', text: 'Task canceled.' }] },
      },
      final: true,
    } as any);
    eventBus.finished();
  }

  private publishError(eventBus: ExecutionEventBus, taskId: string, contextId: string, message: string): void {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      status: {
        state: 'failed' as const,
        timestamp: new Date().toISOString(),
        message: { role: 'agent', parts: [{ kind: 'text', text: message }] },
      },
      final: true,
    } as any);
    eventBus.finished();
  }
}
