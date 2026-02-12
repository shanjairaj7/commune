# Commune Public API (v1)

REST API for Commune email infrastructure. Manage domains, inboxes, threads, messages, and attachments programmatically.

**Base URL:** `https://your-server.example.com/v1`

---

## Authentication

All requests require an API key in the `Authorization` header:

```
Authorization: Bearer comm_your_api_key_here
```

API keys are scoped with permissions. The default `read` + `write` permissions grant full access. Fine-grained scopes are available:

| Scope | Grants |
|-------|--------|
| `domains:read` | List/get domains and DNS records |
| `domains:write` | Create domains, trigger verification |
| `inboxes:read` | List/get inboxes |
| `inboxes:write` | Create, update, delete inboxes |
| `threads:read` | List threads, get thread messages |
| `messages:read` | List messages |
| `messages:write` | Send emails |
| `attachments:read` | Get attachment metadata and URLs |
| `attachments:write` | Upload attachments |

---

## Quickstart

Get from zero to sending emails in 2 API calls — no domain setup needed:

```bash
API_KEY="comm_..."
BASE="https://your-server.example.com/v1"

# 1. Create an inbox (domain auto-assigned)
# Save the returned "id" and "domain_id" from the response
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"local_part":"support"}' \
  $BASE/inboxes

# 2. Send an email (use the inboxId from step 1)
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"user@example.com","subject":"Hello","text":"Hi there!","inboxId":"{inbox_id}"}' \
  $BASE/messages/send
```

> **Important:** You must specify where to send from — provide `inboxId` (recommended), or a `from` address that matches one of your inboxes. The `domainId` is automatically inferred from the inbox.

For more control, you can also manage custom domains, set webhooks, and browse threads with pagination — see the full reference below.

---

## Response Format

All responses return JSON. Successful responses wrap data in a `data` field:

```json
{
  "data": { ... }
}
```

List endpoints return an array in `data`:

```json
{
  "data": [ ... ]
}
```

Paginated endpoints (threads) include pagination fields:

```json
{
  "data": [ ... ],
  "next_cursor": "eyJsYXN0...",
  "has_more": true
}
```

Errors return an `error` field:

```json
{
  "error": "Domain not found"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request — check parameters |
| `401` | Invalid or expired API key |
| `403` | Insufficient permissions |
| `404` | Resource not found |
| `429` | Rate limited — slow down |
| `500` | Server error |

---

## Domains

Domains are custom email domains you own. Register one, add DNS records, verify it, then create inboxes under it.

### List Domains

```
GET /v1/domains
```

**Permissions:** `domains:read`

**Response:**

```json
{
  "data": [
    {
      "id": "d1a2b3c4-5678-9012-abcd-ef0123456789",
      "name": "example.com",
      "status": "verified",
      "region": "us-east-1",
      "records": [
        {
          "record": "DKIM",
          "name": "resend._domainkey.example",
          "type": "TXT",
          "value": "p=MIGfMA0...",
          "status": "verified",
          "ttl": "Auto"
        }
      ],
      "inboxes": [
        {
          "id": "2475ba65-...",
          "localPart": "support",
          "address": "support@example.com"
        }
      ]
    }
  ]
}
```

### Create Domain

```
POST /v1/domains
```

**Permissions:** `domains:write`

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Domain name (e.g. `"example.com"`) |
| `region` | `string` | No | AWS SES region: `"us-east-1"` (default) or `"eu-west-1"` |

```json
{
  "name": "example.com",
  "region": "us-east-1"
}
```

**Response:** `201 Created`

```json
{
  "data": {
    "id": "d1a2b3c4-...",
    "name": "example.com",
    "status": "not_started",
    "region": "us-east-1"
  }
}
```

### Get Domain

```
GET /v1/domains/:domain_id
```

**Permissions:** `domains:read`

**Response:** Same shape as a single item from List Domains.

### Verify Domain

```
POST /v1/domains/:domain_id/verify
```

**Permissions:** `domains:write`

Triggers DNS verification. Call this after adding the required records at your registrar. Use Get Domain Records to see what's needed.

**Response:**

```json
{
  "data": {
    "id": "d1a2b3c4-...",
    "status": "verified"
  }
}
```

### Get Domain Records

```
GET /v1/domains/:domain_id/records
```

**Permissions:** `domains:read`

Returns DNS records that must be added at your registrar for verification.

**Response:**

```json
{
  "data": [
    {
      "record": "SPF",
      "name": "send.example",
      "type": "MX",
      "value": "feedback-smtp.us-east-1.amazonses.com",
      "priority": 10,
      "status": "pending",
      "ttl": "Auto"
    },
    {
      "record": "SPF",
      "name": "send.example",
      "type": "TXT",
      "value": "v=spf1 include:amazonses.com ~all",
      "status": "pending",
      "ttl": "Auto"
    },
    {
      "record": "Receiving",
      "name": "example",
      "type": "MX",
      "value": "inbound-smtp.us-east-1.amazonaws.com",
      "priority": 10,
      "status": "pending",
      "ttl": "Auto"
    }
  ]
}
```

### Typical Domain Setup Flow

1. `POST /v1/domains` — create the domain
2. `GET /v1/domains/:id/records` — get DNS records to configure
3. Add records at your registrar (GoDaddy, Cloudflare, Namecheap, etc.)
4. `POST /v1/domains/:id/verify` — trigger verification
5. `GET /v1/domains/:id` — check status is `"verified"`

---

## Inboxes

Inboxes are mailboxes that receive and send email. The simplest way to create one is `POST /v1/inboxes` — the domain is auto-assigned.

### Create Inbox (simplified)

```
POST /v1/inboxes
```

**Permissions:** `inboxes:write`

Create an inbox with auto-domain resolution. No domain setup required — Commune assigns your inbox to an available domain automatically.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `local_part` | `string` | Yes | Part before `@` (e.g. `"support"`) |
| `domain_id` | `string` | No | Explicit domain. Auto-resolved if omitted. |
| `name` | `string` | No | Display name |
| `webhook` | `object` | No | Webhook config |

```json
{
  "local_part": "support"
}
```

**Response:** `201 Created`

```json
{
  "data": {
    "id": "0c9517a1-...",
    "localPart": "support",
    "address": "support@agents.example.com",
    "createdAt": "2025-03-15T08:26:31.238Z",
    "domain_id": "d1a2b3c4-...",
    "domain_name": "agents.example.com"
  }
}
```

### List All Inboxes

```
GET /v1/inboxes
```

**Permissions:** `inboxes:read`

Lists all inboxes across all domains for your organization.

### List Inboxes (by domain)

```
GET /v1/domains/:domain_id/inboxes
```

**Permissions:** `inboxes:read`

**Response:**

```json
{
  "data": [
    {
      "id": "2475ba65-...",
      "localPart": "support",
      "address": "support@example.com",
      "webhook": {
        "endpoint": "https://your-app.com/webhook",
        "events": ["email.received"]
      },
      "status": null,
      "createdAt": "2025-02-04T08:06:20.382Z"
    }
  ]
}
```

### Create Inbox

```
POST /v1/domains/:domain_id/inboxes
```

**Permissions:** `inboxes:write`

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `local_part` | `string` | Yes | Part before `@` (e.g. `"support"`) |
| `name` | `string` | No | Display name (e.g. `"Customer Support"`) |
| `webhook` | `object` | No | `{"endpoint": "https://...", "events": ["email.received"]}` |

```json
{
  "local_part": "support",
  "name": "Customer Support",
  "webhook": {
    "endpoint": "https://your-app.com/webhook",
    "events": ["email.received"]
  }
}
```

**Response:** `201 Created`

```json
{
  "data": {
    "id": "2475ba65-...",
    "localPart": "support",
    "address": "support@example.com"
  }
}
```

### Get Inbox

```
GET /v1/domains/:domain_id/inboxes/:inbox_id
```

**Permissions:** `inboxes:read`

### Update Inbox

```
PUT /v1/domains/:domain_id/inboxes/:inbox_id
```

**Permissions:** `inboxes:write`

Partial update — only provided fields are changed.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `local_part` | `string` | New local part |
| `webhook` | `object` | New webhook config |
| `status` | `string` | New status |

### Delete Inbox

```
DELETE /v1/domains/:domain_id/inboxes/:inbox_id
```

**Permissions:** `inboxes:write`

**Response:**

```json
{
  "data": { "ok": true }
}
```

---

## Threads

Threads are email conversations — groups of related messages sharing a subject/reply chain. The API uses **cursor-based pagination** for efficiently browsing large mailboxes.

### List Threads

```
GET /v1/threads?inbox_id={inbox_id}&limit=20
```

**Permissions:** `threads:read`

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inbox_id` | `string` | Yes* | — | Filter by inbox |
| `domain_id` | `string` | Yes* | — | Filter by domain |
| `limit` | `integer` | No | `20` | Results per page (1–100) |
| `cursor` | `string` | No | — | Cursor from previous `next_cursor` |
| `order` | `string` | No | `desc` | `"desc"` (newest first) or `"asc"` |

*At least one of `inbox_id` or `domain_id` is required.

**Response:**

```json
{
  "data": [
    {
      "thread_id": "thread_e3e16434-7c93-442c-b498-8a073e41bf3b",
      "subject": "Order not received",
      "last_message_at": "2025-03-15T14:30:00.000Z",
      "first_message_at": "2025-03-10T09:15:00.000Z",
      "message_count": 4,
      "snippet": "Hi, I placed order #4521 five days ago and still...",
      "last_direction": "inbound",
      "inbox_id": "2475ba65-...",
      "domain_id": "d1a2b3c4-...",
      "has_attachments": false
    }
  ],
  "next_cursor": "eyJsYXN0X21lc3NhZ2VfYXQiOi...",
  "has_more": true
}
```

**Pagination:** Pass `next_cursor` as `cursor` to get the next page. When `has_more` is `false`, you've reached the end.

```bash
# Page 1
curl "$BASE/threads?inbox_id=i_xyz&limit=10"

# Page 2 (use next_cursor from page 1)
curl "$BASE/threads?inbox_id=i_xyz&limit=10&cursor=eyJsYXN0..."
```

### Get Thread Messages

```
GET /v1/threads/:thread_id/messages
```

**Permissions:** `threads:read`

Returns all messages in a thread, oldest first by default.

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | `integer` | No | `50` | Max messages (1–1000) |
| `order` | `string` | No | `asc` | `"asc"` (chronological) or `"desc"` |

**Response:**

```json
{
  "data": [
    {
      "message_id": "msg_abc123",
      "thread_id": "thread_e3e16434-...",
      "channel": "email",
      "direction": "inbound",
      "participants": [
        { "role": "sender", "identity": "customer@gmail.com" },
        { "role": "to", "identity": "support@example.com" }
      ],
      "content": "Hi, I placed order #4521 five days ago and haven't received it yet.",
      "content_html": "<p>Hi, I placed order #4521...</p>",
      "attachments": [],
      "created_at": "2025-03-10T09:15:00.000Z",
      "metadata": {
        "subject": "Order not received",
        "created_at": "2025-03-10T09:15:00.000Z",
        "domain_id": "d1a2b3c4-...",
        "inbox_id": "2475ba65-..."
      }
    }
  ]
}
```

---

## Messages

### Send Email

```
POST /v1/messages/send
```

**Permissions:** `messages:write`

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | `string \| string[]` | Yes | Recipient email(s) |
| `subject` | `string` | Yes | Subject line (max 500 chars) |
| `html` | `string` | No* | HTML body |
| `text` | `string` | No* | Plain text body |
| `from` | `string` | No | Full sender address (e.g. `"support@example.com"`) |
| `inboxId` | `string` | No | Inbox to send from (recommended — domain is auto-resolved) |
| `domainId` | `string` | No | Domain to send from (optional — inferred from `inboxId`) |
| `cc` | `string \| string[]` | No | CC recipients |
| `bcc` | `string \| string[]` | No | BCC recipients |
| `reply_to` | `string` | No | Reply-to address |
| `thread_id` | `string` | No | Reply in existing thread |
| `attachments` | `string[]` | No | Attachment IDs from upload |
| `headers` | `object` | No | Custom email headers (key-value pairs) |

*At least one of `html` or `text` is required.

> **Sender resolution:** The `from` address is resolved in this order:
> 1. Explicit `from` field if provided
> 2. `inboxId` → looks up the inbox's address (domain is inferred automatically)
> 3. `domainId` alone → uses default local part (`agent@yourdomain.com`)
> 4. Falls back to system default — **will fail if no default is configured**
>
> For reliable sending, always provide `inboxId`, or an explicit `from` address.

**Send a new email:**

```json
{
  "to": "user@example.com",
  "subject": "Order Confirmation",
  "html": "<h1>Thanks!</h1><p>Your order #1234 is confirmed.</p>",
  "inboxId": "2475ba65-..."
}
```

**Reply in a thread:**

```json
{
  "to": "customer@gmail.com",
  "subject": "Re: Order not received",
  "html": "<p>We're checking with shipping and will update within 24h.</p>",
  "thread_id": "thread_e3e16434-...",
  "inboxId": "2475ba65-..."
}
```

**Send with attachments:**

```json
{
  "to": "user@example.com",
  "subject": "Monthly Report",
  "html": "<p>Please see attached.</p>",
  "attachments": ["a1b2c3d4e5f6..."],
  "inboxId": "2475ba65-..."
}
```

**Response:** `200 OK`

```json
{
  "data": {
    "id": "re_abc123...",
    "thread_id": "thread_e3e16434-...",
    "smtp_message_id": "<uuid@yourdomain.com>"
  },
  "validation": {
    "rejected": [
      { "email": "bad@invalid.test", "reason": "No MX records found" }
    ],
    "warnings": [
      { "email": "user@mailinator.com", "reason": "Disposable email domain" }
    ],
    "suppressed": ["bounced@example.com"],
    "duration_ms": 42
  }
}
```

> The `validation` field is only included when there are rejected, warned, or suppressed recipients. If all recipients are valid, only `data` is returned.

### List Messages

```
GET /v1/messages?inbox_id={inbox_id}
```

**Permissions:** `messages:read`

**Query parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inbox_id` | `string` | Yes* | — | Filter by inbox |
| `domain_id` | `string` | Yes* | — | Filter by domain |
| `sender` | `string` | Yes* | — | Filter by sender email |
| `limit` | `integer` | No | `50` | Max results (1–1000) |
| `order` | `string` | No | `desc` | `"asc"` or `"desc"` |
| `before` | `string` | No | — | ISO date — messages before this |
| `after` | `string` | No | — | ISO date — messages after this |

*At least one of `inbox_id`, `domain_id`, or `sender` is required.

**Response:** Same message format as Get Thread Messages.

---

## Attachments

Upload files first, then reference their IDs when sending emails.

### Upload Attachment

```
POST /v1/attachments/upload
```

**Permissions:** `attachments:write`

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | Yes | Base64-encoded file content |
| `filename` | `string` | Yes | Original filename |
| `mime_type` | `string` | Yes | MIME type |

```json
{
  "content": "JVBERi0xLjQKJ...",
  "filename": "invoice.pdf",
  "mime_type": "application/pdf"
}
```

**Response:** `201 Created`

```json
{
  "data": {
    "attachment_id": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
    "filename": "invoice.pdf",
    "mime_type": "application/pdf",
    "size": 45230
  }
}
```

> **Note:** Attachment IDs are 32-character hex strings (not prefixed).

### Get Attachment

```
GET /v1/attachments/:attachment_id
```

**Permissions:** `attachments:read`

Returns metadata (not the file content).

**Response:**

```json
{
  "data": {
    "attachment_id": "a1b2c3d4e5f67890a1b2c3d4e5f67890",
    "filename": "invoice.pdf",
    "mime_type": "application/pdf",
    "size": 45230,
    "storage_type": "cloudinary",
    "source": "email",
    "message_id": ""
  }
}
```

### Get Attachment URL

```
GET /v1/attachments/:attachment_id/url?expires_in=3600
```

**Permissions:** `attachments:read`

Returns a temporary download URL.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `expires_in` | `integer` | `3600` | Seconds until URL expires |

**Response:**

```json
{
  "data": {
    "url": "https://res.cloudinary.com/...",
    "expires_in": 3600,
    "filename": "invoice.pdf",
    "mime_type": "application/pdf",
    "size": 45230
  }
}
```

### Attachment Flow

1. `POST /v1/attachments/upload` — upload the file, get `attachment_id`
2. `POST /v1/messages/send` — pass `attachment_id` in the `attachments` array
3. `GET /v1/attachments/:id/url` — later, get a download link

---

## Rate Limiting

Requests are rate-limited per API key. If you exceed the limit, you'll receive a `429` response:

```json
{
  "error": "Rate limit exceeded"
}
```

Back off and retry after a short delay.

---

## Data Deletion

Two-phase deletion API with safety mechanisms. No data is deleted until you explicitly confirm with a time-limited token.

**Required permission:** `admin` or `data:delete`

### Scopes

| Scope | What it deletes |
|-------|----------------|
| `organization` | Everything — messages, attachments, domains, inboxes, users, API keys, sessions, audit logs, the organization itself |
| `inbox` | All data for a specific inbox — messages, attachments, delivery events, webhook deliveries, suppressions |
| `messages` | Messages and their attachments only, with optional `before` date filter |

### Step 1: Create Deletion Request

```
POST /v1/data/deletion-request
```

```json
{
  "scope": "organization"
}
```

For inbox-scoped deletion:
```json
{
  "scope": "inbox",
  "inbox_id": "inbox_abc123"
}
```

For messages with a date filter:
```json
{
  "scope": "messages",
  "before": "2025-01-01T00:00:00Z"
}
```

**Response (201):**

```json
{
  "id": "del_a1b2c3d4e5f6g7h8i9j0",
  "scope": "organization",
  "status": "pending",
  "preview": {
    "messages": 1423,
    "attachments": 89,
    "domains": 2,
    "inboxes": 5,
    "webhook_deliveries": 312,
    "delivery_events": 1891,
    "blocked_spam": 47,
    "thread_metadata": 203,
    "dmarc_reports": 12,
    "alerts": 3,
    "suppressions": 28,
    "spam_reports": 0,
    "audit_logs": 4521,
    "users": 2,
    "api_keys": 3,
    "sessions": 1,
    "verification_tokens": 0
  },
  "confirmation_token": "a8f2e1d4c7b6...",
  "confirm_by": "2025-06-15T13:00:00.000Z",
  "warning": "This will permanently delete ALL data for your organization including users, API keys, and the organization itself. This action cannot be undone."
}
```

The `preview` shows exactly how many documents will be deleted per collection. The `confirmation_token` expires after 1 hour.

### Step 2: Confirm Deletion

Review the preview. If you're sure, confirm with the token:

```
POST /v1/data/deletion-request/del_a1b2c3d4e5f6g7h8i9j0/confirm
```

```json
{
  "confirmation_token": "a8f2e1d4c7b6..."
}
```

**Response (200):**

```json
{
  "id": "del_a1b2c3d4e5f6g7h8i9j0",
  "scope": "organization",
  "status": "completed",
  "preview": { "..." },
  "deleted_counts": {
    "messages": 1423,
    "attachments": 89,
    "domains": 2,
    "inboxes": 5,
    "webhook_deliveries": 312,
    "delivery_events": 1891,
    "users": 2,
    "api_keys": 3
  },
  "confirmed_at": "2025-06-15T12:05:00.000Z",
  "completed_at": "2025-06-15T12:05:03.000Z"
}
```

### Step 3: Check Status (Optional)

```
GET /v1/data/deletion-request/del_a1b2c3d4e5f6g7h8i9j0
```

### Safety Mechanisms

- **Preview before delete** — exact document counts shown before any data is touched
- **Confirmation token** — HMAC-signed, tied to the specific request, cannot be guessed
- **1-hour expiry** — stale requests automatically expire
- **One active request per org** — no concurrent deletion races
- **Permission gated** — requires `admin` or `data:delete` API key permission
- **Audit logged** — the deletion event is logged before audit logs are purged
