import messageStore from '../../stores/messageStore';
import suppressionStore from '../../stores/suppressionStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import domainStore from '../../stores/domainStore';
import securityStore from '../../stores/securityStore';
import SendingHealthService from '../sendingHealthService';
import metricsCacheService from '../metricsCacheService';
import { normalizeRecipient } from './helpers';
import logger from '../../utils/logger';
import {
  buildOrphanEventData,
  extractComplaintType,
  getWebhookEventData,
  mapBounceType,
  mapWebhookEventType,
  resolveWebhookEmailId,
  shouldUpdateSentStatus,
} from '../deliveryEventUtils';

const SOFT_BOUNCE_THRESHOLD = Number(process.env.SOFT_BOUNCE_THRESHOLD || 3);
const SOFT_BOUNCE_SUPPRESSION_DAYS = Number(process.env.SOFT_BOUNCE_SUPPRESSION_DAYS || 7);

// Helper: extract recipient from Resend webhook event data (preferred) or stored message
const extractRecipientFromEvent = (eventData: Record<string, any>, message: any): string => {
  // Resend webhook data.to is an array of recipient email addresses
  if (Array.isArray(eventData?.to) && eventData.to.length > 0) {
    return eventData.to[0];
  }
  // Fallback to stored message participants
  const toParticipant = message?.participants?.find((p: any) => p.role === 'to');
  return toParticipant?.identity || '';
};

const inferInboxIdForOrphanEvent = async (
  eventData: Record<string, any>,
  domainId?: string
): Promise<string | undefined> => {
  if (!domainId) return undefined;
  const fromRecipient = normalizeRecipient(eventData?.from);
  const localPart = fromRecipient?.localPartBase;
  if (!localPart) return undefined;
  try {
    const inbox = await domainStore.getInboxByLocalPart(domainId, localPart);
    return inbox?.id;
  } catch {
    return undefined;
  }
};

// New event handlers for delivery events
const handleDeliveryEvent = async (event: any, domainId?: string) => {
  const eventType = String(event?.type || '');
  const mappedType = mapWebhookEventType(eventType);
  if (!mappedType) {
    logger.debug('Unhandled event type', { eventType });
    return;
  }

  const data = getWebhookEventData(event);
  const resendEmailId = resolveWebhookEmailId(data);
  if (!resendEmailId) {
    logger.debug('Missing email_id in delivery event', { eventType, dataKeys: Object.keys(data || {}) });
    return;
  }

  const message = await messageStore.getMessageByResendId(resendEmailId);

  if (!message) {
    const orphanInboxId = await inferInboxIdForOrphanEvent(data, domainId);
    await deliveryEventStore.storeEvent({
      message_id: resendEmailId,
      event_type: mappedType,
      event_data: buildOrphanEventData(data, resendEmailId, 'message_not_found'),
      inbox_id: orphanInboxId,
      domain_id: domainId,
    });
    logger.debug('Stored orphan delivery event', { eventType, resendEmailId, orphanInboxId, domainId });
    return;
  }

  const inboxId = message.metadata?.inbox_id || undefined;
  const messageId = message.message_id;
  const eventCreatedAt = event?.created_at || data.created_at || new Date().toISOString();

  switch (eventType) {
    case 'email.sent':
      // Confirm sent status without downgrading terminal delivery outcomes.
      if (shouldUpdateSentStatus(message?.metadata?.delivery_status)) {
        await messageStore.updateDeliveryStatus(messageId, 'sent', { sent_at: eventCreatedAt }, inboxId);
      }
      await deliveryEventStore.storeEvent({
        message_id: messageId,
        event_type: 'sent' as const,
        event_data: data,
        inbox_id: inboxId,
        domain_id: domainId
      });
      logger.debug('Sent event recorded', { messageId });
      break;
    case 'email.delivered':
      await handleEmailDelivered(eventCreatedAt, data, message, domainId, inboxId);
      break;
    case 'email.bounced':
      await handleEmailBounced(eventCreatedAt, data, message, domainId, inboxId);
      break;
    case 'email.complained':
      await handleEmailComplained(eventCreatedAt, data, message, domainId, inboxId);
      break;
    case 'email.failed':
      await handleEmailFailed(eventCreatedAt, data, message, domainId, inboxId);
      break;
    case 'email.delivery_delayed':
      await handleDeliveryDelayed(data, message, domainId, inboxId);
      break;
    case 'email.suppressed':
      await handleEmailSuppressed(eventCreatedAt, data, message, domainId, inboxId);
      break;
    default:
      logger.debug('Unhandled event type', { eventType });
      return;
  }

  if (inboxId) {
    metricsCacheService.clearInboxCache(inboxId);
  }
};

const handleEmailDelivered = async (eventCreatedAt: string, data: Record<string, any>, message: any, domainId?: string, inboxId?: string) => {
  const messageId = message.message_id;
  
  await messageStore.updateDeliveryStatus(
    messageId,
    'delivered',
    { delivered_at: eventCreatedAt },
    inboxId
  );
  
  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'delivered' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId
  });

  // Successful delivery resets soft bounce tracking
  const recipient = extractRecipientFromEvent(data, message);
  if (recipient) {
    await securityStore.resetSoftBounce(recipient);
  }

  logger.debug('Delivery event recorded: delivered', { messageId });
};

const handleEmailBounced = async (eventCreatedAt: string, data: Record<string, any>, message: any, domainId?: string, inboxId?: string) => {
  const messageId = message.message_id;
  // Resend bounce payload type is Permanent/Temporary (Transient supported for backward compatibility).
  const bounceType = mapBounceType(data.bounce?.type);
  const bounceReason = data.bounce?.message || data.bounce?.subType || 'Unknown';
  const bounceDiagnostic = Array.isArray(data.bounce?.diagnosticCode)
    ? data.bounce.diagnosticCode.join('; ')
    : data.bounce?.diagnosticCode || null;
  const recipient = extractRecipientFromEvent(data, message);
  
  await messageStore.updateDeliveryStatus(
    messageId,
    'bounced',
    { 
      bounced_at: eventCreatedAt,
      bounce_reason: bounceReason,
      bounce_type: bounceType,
      bounce_diagnostic: bounceDiagnostic,
      bounce_sub_type: data.bounce?.subType || null,
    },
    inboxId
  );

  if (bounceType === 'hard') {
    await suppressionStore.addSuppression({
      email: recipient,
      reason: 'bounce' as const,
      type: 'hard',
      source: 'inbox' as const,
      inbox_id: inboxId,
      message_id: messageId,
      metadata: {
        bounce_reason: bounceReason,
        bounce_diagnostic: bounceDiagnostic,
        original_subject: message.metadata?.subject
      }
    });
  } else {
    const softBounceCount = await securityStore.incrementSoftBounce({
      email: recipient,
      reason: bounceReason,
      inboxId,
    });

    if (softBounceCount >= SOFT_BOUNCE_THRESHOLD) {
      const expiresAt = new Date(
        Date.now() + SOFT_BOUNCE_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      await suppressionStore.addSuppression({
        email: recipient,
        reason: 'bounce' as const,
        type: 'soft',
        source: 'inbox' as const,
        inbox_id: inboxId,
        message_id: messageId,
        expires_at: expiresAt,
        metadata: {
          bounce_reason: bounceReason,
          original_subject: message.metadata?.subject,
          soft_bounce_count: softBounceCount,
        }
      });
    }
  }
  
  // Record bounce for circuit breaker health tracking
  const orgId = message?.orgId;
  if (orgId) {
    SendingHealthService.getInstance().recordBounce(orgId).catch(() => {});
  }

  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'bounced' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId
  });

  logger.info('Bounce event recorded', { bounceType, messageId, recipient });
};

const handleEmailComplained = async (eventCreatedAt: string, data: Record<string, any>, message: any, domainId?: string, inboxId?: string) => {
  const messageId = message.message_id;
  const recipient = extractRecipientFromEvent(data, message);
  
  await messageStore.updateDeliveryStatus(
    messageId,
    'complained',
    { complained_at: eventCreatedAt },
    inboxId
  );
  
  // Add to suppression list
  await suppressionStore.addSuppression({
    email: recipient,
    reason: 'complaint' as const,
    type: 'spam' as const,
    source: 'inbox' as const,
    inbox_id: inboxId,
    message_id: messageId,
    metadata: {
      complaint_type: extractComplaintType(data) || undefined,
      original_subject: message.metadata?.subject
    }
  });

  // Record complaint for circuit breaker health tracking
  const orgId = message?.orgId;
  if (orgId) {
    SendingHealthService.getInstance().recordComplaint(orgId).catch(() => {});
  }
  
  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'complained' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId
  });

  logger.info('Complaint event recorded', { messageId, recipient });
};

const handleEmailFailed = async (eventCreatedAt: string, data: Record<string, any>, message: any, domainId?: string, inboxId?: string) => {
  const messageId = message.message_id;
  // Resend failed payload: data.failed.reason = "reached_daily_quota" etc.
  const failureReason = data.failed?.reason || 'Unknown';
  
  await messageStore.updateDeliveryStatus(
    messageId,
    'failed',
    { 
      failed_at: eventCreatedAt,
      failure_reason: failureReason
    },
    inboxId
  );
  
  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'failed' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId
  });

  logger.info('Failed event recorded', { messageId, failureReason });
};

const handleDeliveryDelayed = async (data: Record<string, any>, message: any, domainId?: string, inboxId?: string) => {
  const messageId = message.message_id;
  
  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'delivery_delayed' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId
  });

  logger.debug('Delivery delayed event recorded', { messageId });
};

const handleEmailSuppressed = async (
  eventCreatedAt: string,
  data: Record<string, any>,
  message: any,
  domainId?: string,
  inboxId?: string
) => {
  const messageId = message.message_id;
  const suppressionReason =
    data.suppressed?.reason ||
    data.suppressed?.message ||
    data.reason ||
    'suppressed';

  await messageStore.updateDeliveryStatus(
    messageId,
    'failed',
    {
      failed_at: eventCreatedAt,
      failure_reason: 'suppressed',
      suppression_reason: suppressionReason,
    },
    inboxId
  );

  await deliveryEventStore.storeEvent({
    message_id: messageId,
    event_type: 'suppressed' as const,
    event_data: data,
    inbox_id: inboxId,
    domain_id: domainId,
  });

  logger.info('Suppressed event recorded', { messageId, suppressionReason });
};

export { handleDeliveryEvent };
