import { UnifiedMessage } from './messages';

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export interface InboundEmailWebhookPayload {
  domainId: string;
  inboxId?: string;
  inboxAddress?: string;
  event: unknown;
  email: unknown;
  message: UnifiedMessage;
  extractedData?: Record<string, any>;
}
