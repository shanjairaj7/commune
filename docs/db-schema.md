# Database Schema (MongoDB)

This schema matches unified message model and SDK contract. Collections are
channel-agnostic and use `thread_id` as the thread key for both email and Slack.

---

## Collection: domains

```
{
  id: "string",                 // Resend domain id
  name: "string",
  status: "string",
  region: "string",
  records: [ ... ],             // DNS records from Resend
  createdAt: "ISO-8601",
  webhook: {
    id: "string",
    endpoint: "string",
    events: ["email.received", "email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed", "email.delivery_delayed"],
    secret: "whsec_..."
  }
}
```

Indexes:
- `id` (unique)

---

## Collection: messages

```
{
  _id: "uuid",
  channel: "email" | "slack",
  message_id: "string",               // email Message-ID or Slack ts
  thread_id: "string",          // email References root / In-Reply-To / Message-ID
  direction: "inbound" | "outbound",
  created_at: "ISO-8601",
  participants: [
    { role: "sender" | "to" | "cc" | "bcc" | "mentioned" | "participant",
      identity: "string" }
  ],
  content: "string",
  content_html: "string | null",
  attachments: ["attachment_id", "..."],
  metadata: {
    created_at: "ISO-8601",
    subject: "string",
    in_reply_to: "string | null",
    references: ["<msgid>", ...],
    slack_channel_id: "string | null",
    slack_thread_ts: "string | null",
    is_private: true | false,
    domain_id: "string | null",
    inbox_id: "string | null",
    inbox_address: "string | null",
    message_id: "string | null",
    delivery_status: "sent" | "delivered" | "bounced" | "failed" | "complained",
    delivery_data: {
      sent_at: "ISO-8601",
      delivered_at: "ISO-8601",
      bounced_at: "ISO-8601",
      failed_at: "ISO-8601",
      complained_at: "ISO-8601",
      bounce_reason: "string",
      bounce_type: "hard" | "soft",
      failure_reason: "string",
      last_attempt: "ISO-8601"
    }
  }
}
```

Indexes:
- `{ thread_id: 1, created_at: -1 }`
- `{ channel: 1, message_id: 1 }` (unique)
- `{ participants.identity: 1, created_at: -1 }`
- `{ "metadata.delivery_status": 1, created_at: -1 }`
- `{ "metadata.inbox_id": 1, "metadata.delivery_status": 1 }`

---

## Collection: suppressions

```
{
  _id: "uuid",
  email: "string",
  reason: "bounce" | "complaint" | "manual" | "spam_trap",
  type: "hard" | "soft" | "spam" | "permanent",
  source: "inbox" | "domain" | "global",
  inbox_id: "string",
  created_at: "ISO-8601",
  expires_at: "ISO-8601",
  message_id: "string",
  metadata: {
    bounce_reason: "string",
    complaint_type: "string",
    original_subject: "string"
  }
}
```

Indexes:
- `{ email: 1 }` (unique)
- `{ inbox_id: 1, source: 1 }`
- `{ created_at: 1 }`
- `{ expires_at: 1 }` (TTL)

---

## Collection: delivery_events

```
{
  _id: "uuid",
  message_id: "string",
  event_type: "sent" | "delivered" | "bounced" | "complained" | "failed" | "delivery_delayed",
  event_data: "object",
  processed_at: "ISO-8601",
  inbox_id: "string",
  domain_id: "string",
  org_id: "string"
}
```

Indexes:
- `{ message_id: 1, event_type: 1 }`
- `{ inbox_id: 1, processed_at: -1 }`
- `{ processed_at: 1 }` (TTL: 90 days)

---

## Collection: attachments

```
{
  attachment_id: "uuid",
  message_id: "string",
  filename: "string",
  mime_type: "string",
  size: number,
  content_base64: "string | null",
  source: "email" | "slack",
  source_url: "string | null"
}
```

Indexes:
- `{ attachment_id: 1 }` (unique)
- `{ message_id: 1 }`

---

## Collection: inbox_metrics (Optional - for aggregated metrics)

```
{
  _id: "uuid",
  inbox_id: "string",
  domain_id: "string",
  date: "string",                    // YYYY-MM-DD for daily aggregation
  metrics: {
    sent: number,
    delivered: number,
    bounced: number,
    complained: number,
    failed: number,
    delivery_rate: number,
    bounce_rate: number,
    complaint_rate: number
  },
  updated_at: "ISO-8601"
}
```

Indexes:
- `{ inbox_id: 1, date: -1 }`
- `{ domain_id: 1, date: -1 }`
