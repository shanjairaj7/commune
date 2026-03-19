import type { AgentCard } from '@a2a-js/sdk';

const BASE_URL = process.env.BASE_URL || 'https://api.commune.email';

/**
 * Commune's A2A Agent Card.
 *
 * This is the public manifest that tells other agents what Commune can do.
 * Skills are designed for how agents think about email — not CRUD operations.
 */
export const agentCard: AgentCard = {
  name: 'Commune',
  description:
    'Email infrastructure for AI agents. Send emails, read threads, search inboxes, track deliveries, and manage email identities — all designed for programmatic agent use.',
  url: `${BASE_URL}/a2a`,
  version: '1.0.0',
  protocolVersion: '0.3.0',

  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },

  defaultInputModes: ['application/json', 'text/plain'],
  defaultOutputModes: ['application/json', 'text/plain'],

  skills: [
    // ── Tier 1: Core email operations ──────────────────────────────
    {
      id: 'send_email',
      name: 'Send Email',
      description:
        'Compose and send an email. Supports HTML/text body, attachments, CC/BCC, and threading (reply to existing conversations by providing a thread_id). Returns message ID and thread ID for tracking.',
      tags: ['email', 'send', 'compose', 'reply'],
      examples: [
        'Send an email to john@example.com about the meeting tomorrow',
        'Reply to thread_abc123 saying we accept the proposal',
        'Send a follow-up email to the sales thread with the attached contract',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
    {
      id: 'read_thread',
      name: 'Read Thread',
      description:
        'Get all messages in an email conversation thread. Returns the full history: sender, recipients, subject, body, timestamps, and delivery status for each message. Use this to understand context before replying.',
      tags: ['email', 'read', 'thread', 'conversation', 'history'],
      examples: [
        'Read the thread with ID thread_abc123',
        'Get all messages in the conversation about the contract',
        'Show me the email thread I had with jane@example.com',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
    {
      id: 'search_inbox',
      name: 'Search Inbox',
      description:
        'Search across all emails using natural language or keywords. Uses semantic search (meaning-based) with regex fallback. Filter by inbox, domain, or sender. Returns matching threads with relevance scores.',
      tags: ['email', 'search', 'find', 'query', 'lookup'],
      examples: [
        'Find all emails from investors about the Series A',
        'Search for messages mentioning the product launch date',
        'Look up any emails from @stripe.com in the last week',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
    {
      id: 'list_threads',
      name: 'List Threads',
      description:
        'List recent email conversation threads. Returns thread ID, subject, participants, last message timestamp, and message count. Supports cursor pagination and filtering by inbox or domain.',
      tags: ['email', 'list', 'inbox', 'threads', 'recent'],
      examples: [
        'Show me my recent email threads',
        'List all threads in the support inbox',
        'What conversations happened today?',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
    {
      id: 'get_delivery_status',
      name: 'Check Delivery Status',
      description:
        'Check whether emails were successfully delivered, bounced, or failed. Returns delivery metrics (sent, delivered, bounced, complained, failed counts) and recent delivery events with timestamps.',
      tags: ['email', 'delivery', 'status', 'bounce', 'tracking'],
      examples: [
        'Did my email to john@example.com get delivered?',
        'Check delivery metrics for the marketing inbox',
        'Show me any bounced emails from today',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },

    // ── Tier 2: Infrastructure management ──────────────────────────
    {
      id: 'create_inbox',
      name: 'Create Inbox',
      description:
        'Provision a new email address (inbox). Each inbox gets a unique address for sending and receiving. Useful for creating per-campaign or per-agent email identities.',
      tags: ['email', 'inbox', 'create', 'provision', 'identity'],
      examples: [
        'Create a new inbox called outreach on my domain',
        'Set up a support@mydomain.com inbox',
        'Provision an email identity for my sales agent',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
    {
      id: 'list_inboxes',
      name: 'List Inboxes',
      description:
        'List all email inboxes (addresses) available in the organization. Returns inbox ID, email address, display name, and domain info.',
      tags: ['email', 'inbox', 'list', 'addresses'],
      examples: [
        'What email addresses do I have?',
        'List all my inboxes',
        'Show available sending identities',
      ],
      inputModes: ['application/json', 'text/plain'],
      outputModes: ['application/json'],
    },
  ],

  // Auth: existing Commune API key (Bearer comm_xxx)
  security: [{ apiKey: [] }],
  securitySchemes: {
    apiKey: {
      type: 'apiKey',
      in: 'header',
      name: 'Authorization',
      description: 'Commune API key. Format: Bearer comm_xxx...',
    },
  },

  supportsAuthenticatedExtendedCard: false,
};

export function getAgentCard(): AgentCard {
  return agentCard;
}
