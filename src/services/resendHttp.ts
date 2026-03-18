const RESEND_API_BASE = 'https://api.resend.com';

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  throw new Error('RESEND_API_KEY is not set');
}

type ResendResponse<T> = {
  data: T | null;
  error: { message?: string; [key: string]: unknown } | null;
};

export type WebhookPayload = {
  object?: 'webhook';
  id: string;
  signing_secret?: string;
  secret?: string;
  webhook_secret?: string;
  endpoint?: string;
  events?: string[];
  status?: string;
  created_at?: string;
};

const request = async <T>(method: string, path: string, body?: unknown): Promise<ResendResponse<T>> => {
  const response = await fetch(`${RESEND_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await response.json().catch(() => ({}))) as T;

  if (!response.ok) {
    return {
      data: null,
      error: (json as { message?: string }) || { message: 'Resend API error' },
    };
  }

  return { data: json, error: null };
};

const createWebhook = async ({ endpoint, events }: { endpoint: string; events: string[] }) => {
  return request<WebhookPayload>('POST', '/webhooks', { endpoint, events });
};

const listWebhooks = async () => {
  return request<Record<string, unknown>>('GET', '/webhooks');
};

const getReceivedEmail = async (emailId: string) => {
  return request<Record<string, unknown>>('GET', `/emails/receiving/${emailId}`);
};

const listReceivedAttachments = async (emailId: string) => {
  return request<Record<string, unknown>>('GET', `/emails/receiving/${emailId}/attachments`);
};

export default {
  createWebhook,
  listWebhooks,
  getReceivedEmail,
  listReceivedAttachments,
};
