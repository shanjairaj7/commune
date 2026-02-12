export type DeletionScope = 'organization' | 'inbox' | 'messages';

export type DeletionStatus = 'pending' | 'confirmed' | 'executing' | 'completed' | 'expired' | 'failed';

export interface DeletionPreview {
  messages: number;
  attachments: number;
  domains: number;
  inboxes: number;
  webhook_deliveries: number;
  delivery_events: number;
  blocked_spam: number;
  thread_metadata: number;
  dmarc_reports: number;
  alerts: number;
  suppressions: number;
  spam_reports: number;
  audit_logs: number;
  users: number;
  api_keys: number;
  sessions: number;
  verification_tokens: number;
}

export interface DeletionRequest {
  _id?: string;
  id: string;
  org_id: string;
  scope: DeletionScope;
  /** Only required when scope is 'inbox' */
  inbox_id?: string;
  /** Only for scope 'messages' — delete messages created before this ISO date */
  before?: string;
  status: DeletionStatus;
  preview: DeletionPreview;
  deleted_counts?: Partial<DeletionPreview>;
  /** HMAC-signed confirmation token */
  confirmation_token_hash: string;
  /** When the confirmation token expires */
  confirm_by: string;
  requested_at: string;
  confirmed_at?: string;
  completed_at?: string;
  error?: string;
  /** Who requested: API key ID or user ID */
  requested_by: string;
}
