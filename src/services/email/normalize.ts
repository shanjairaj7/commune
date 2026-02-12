import type { AttachmentRecord, UnifiedMessage } from '../../types';

const parseReferences = (references?: string | string[]): string[] => {
  if (!references) {
    return [] as string[];
  }

  if (Array.isArray(references)) {
    return references.flatMap(parseReferences);
  }

  const matches = references.match(/<[^>]+>/g);
  if (matches && matches.length) {
    return matches;
  }

  return references.split(' ').filter(Boolean);
};

/**
 * Thread ID resolver that supports DB-backed resolution.
 *
 * Priority:
 *  1. DB lookup — find a stored message whose SMTP Message-ID matches
 *     any of the References or In-Reply-To headers → reuse that thread_id
 *  2. Fallback — use the first References entry, In-Reply-To, or the
 *     message's own Message-ID (original behaviour for first-in-thread)
 */
const buildThreadId = (
  headers: Record<string, string> | undefined,
  messageId: string,
  resolvedThreadId?: string | null,
) => {
  // If the DB resolver already found a matching thread, use it
  if (resolvedThreadId) {
    return resolvedThreadId;
  }

  // Fallback: derive from SMTP headers (original logic)
  const references = parseReferences(headers?.references);
  if (references.length) {
    return references[0];
  }

  if (headers?.['in-reply-to']) {
    return headers['in-reply-to'];
  }

  return messageId;
};

const buildParticipants = (email: Record<string, unknown>) => {
  const participants: UnifiedMessage['participants'] = [];

  if (email.from) {
    participants.push({ role: 'sender', identity: String(email.from) });
  }

  (email.to as string[] | undefined)?.forEach((addr) => {
    participants.push({ role: 'to', identity: addr });
  });

  (email.cc as string[] | undefined)?.forEach((addr) => {
    participants.push({ role: 'cc', identity: addr });
  });

  (email.bcc as string[] | undefined)?.forEach((addr) => {
    participants.push({ role: 'bcc', identity: addr });
  });

  return participants;
};

/**
 * Collect all SMTP Message-IDs from References + In-Reply-To headers
 * that can be used to look up an existing thread in the DB.
 */
const collectSmtpCandidates = (headers: Record<string, string>): string[] => {
  const candidates: string[] = [];
  const refs = parseReferences(headers.references);
  candidates.push(...refs);
  if (headers['in-reply-to']) {
    candidates.push(headers['in-reply-to']);
  }
  // Deduplicate
  return [...new Set(candidates)];
};

const normalizeEmail = ({
  email,
  domainId,
  inboxId,
  inboxAddress,
  attachments,
  resolvedThreadId,
}: {
  email: Record<string, any>;
  domainId: string;
  inboxId?: string | null;
  inboxAddress?: string | null;
  attachments: AttachmentRecord[];
  resolvedThreadId?: string | null;
}) => {
  const messageId = email.message_id as string;
  const headers = (email.headers || {}) as Record<string, string>;
  const references = parseReferences(headers.references);
  const inReplyTo = headers['in-reply-to'] || null;
  const threadId = buildThreadId(headers, messageId, resolvedThreadId);
  const createdAt = email.created_at as string;

  const message: UnifiedMessage = {
    channel: 'email',
    message_id: messageId,
    thread_id: threadId,
    direction: 'inbound',
    participants: buildParticipants(email),
    content: (email.text as string) || '',
    content_html: (email.html as string) || null,
    attachments: attachments.map((att) => att.attachment_id),
    created_at: createdAt,
    metadata: {
      created_at: createdAt,
      subject: (email.subject as string) || '',
      in_reply_to: inReplyTo,
      references,
      domain_id: domainId,
      inbox_id: inboxId || null,
      inbox_address: inboxAddress || null,
      message_id: messageId,
    },
  };

  return { message, thread_id: threadId };
};

export { normalizeEmail, parseReferences, collectSmtpCandidates };
