import type { DeliveryEvent } from '../types';

type AnyRecord = Record<string, any>;

export const getWebhookEventData = (event: unknown): AnyRecord => {
  if (!event || typeof event !== 'object') {
    return {};
  }
  const maybeData = (event as AnyRecord).data;
  if (!maybeData || typeof maybeData !== 'object') {
    return {};
  }
  return maybeData as AnyRecord;
};

export const resolveWebhookEmailId = (data: AnyRecord): string | null => {
  const emailId = typeof data.email_id === 'string' ? data.email_id.trim() : '';
  if (emailId) return emailId;
  const fallback = typeof data.message_id === 'string' ? data.message_id.trim() : '';
  if (fallback) return fallback;
  return null;
};

export const mapWebhookEventType = (eventType: string): DeliveryEvent['event_type'] | null => {
  switch (eventType) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
      return 'complained';
    case 'email.failed':
      return 'failed';
    case 'email.delivery_delayed':
      return 'delivery_delayed';
    case 'email.suppressed':
      return 'suppressed';
    default:
      return null;
  }
};

export const isTerminalDeliveryStatus = (status: unknown): boolean => {
  return status === 'delivered' || status === 'bounced' || status === 'complained' || status === 'failed';
};

export const shouldUpdateSentStatus = (status: unknown): boolean => {
  return !status || status === 'sent';
};

export const mapBounceType = (value: unknown): 'hard' | 'soft' => {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'temporary' || raw === 'transient') {
    return 'soft';
  }
  return 'hard';
};

export const extractComplaintType = (data: AnyRecord): string | null => {
  const complaint = data.complaint;
  if (!complaint || typeof complaint !== 'object') {
    return null;
  }

  const direct =
    typeof complaint.complaintFeedbackType === 'string'
      ? complaint.complaintFeedbackType
      : typeof complaint.feedback_type === 'string'
      ? complaint.feedback_type
      : typeof complaint.type === 'string'
      ? complaint.type
      : null;

  if (!direct) {
    return null;
  }
  const normalized = direct.trim();
  return normalized.length > 0 ? normalized : null;
};

export const buildOrphanEventData = (
  data: AnyRecord,
  lookupEmailId: string | null,
  reason: 'message_not_found' | 'missing_email_id'
): AnyRecord => {
  return {
    ...data,
    orphan: true,
    orphan_reason: reason,
    lookup_email_id: lookupEmailId,
  };
};
