# Commune Backend

Open-source email infrastructure for AI agents. Receive, send, and process email programmatically with built-in security, encryption, and deliverability management.

**[Architecture](./ARCHITECTURE.md)** · **[API Reference](./docs/PUBLIC_API.md)** · **[Security](./docs/security/)**

## What This Does

Commune handles the full email lifecycle for AI agent systems:

- **Inbound processing** — Receive email via Resend webhooks with spam detection, prompt injection analysis, attachment scanning, and structured data extraction
- **Outbound sending** — Send email with automatic threading, recipient validation, suppression management, and RFC-compliant headers
- **Delivery tracking** — Bounce, complaint, and delivery event processing with automatic suppression list management
- **Webhook forwarding** — Deliver processed email to your endpoints with HMAC-SHA256 signatures, exponential backoff retry, and circuit breakers
- **Encryption at rest** — AES-256-GCM field-level encryption for all email content, subjects, participants, and attachments
- **Real-time notifications** — WebSocket push to connected dashboard clients

## Prerequisites

- **Node.js** 18+
- **MongoDB** (local or hosted — e.g., MongoDB Atlas)
- **Resend account** with an API key and at least one verified domain
- **Redis** (optional — falls back to in-memory for rate limiting and caching)

## Quick Start

### 1. Clone and install

```bash
cd backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. The minimum required variables:

```bash
# Database
MONGO_URL=mongodb://localhost:27017/commune

# Email provider
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Authentication (generate a strong random string, ≥32 chars)
JWT_SECRET=your-secure-random-string-at-least-32-characters

# Encryption at rest (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
EMAIL_ENCRYPTION_KEY=64-hex-character-key-here

# Public URL for webhook callbacks
PUBLIC_WEBHOOK_BASE_URL=https://your-backend-url.com

# Frontend URL (for email verification links)
FRONTEND_BASE_URL=http://localhost:3000
```

### 3. Run

```bash
# Development (with hot reload via ts-node)
npm run dev

# Production
npm run build
npm start
```

The server starts on port 8000 (configurable via `PORT`).

### 4. Verify

```bash
curl http://localhost:8000/health
# {"status":"ok"}
```

## API Structure

The backend exposes two API surfaces:

### Dashboard API (`/api/*`)
Used by the frontend dashboard. Authenticated via JWT (Bearer token from `/auth/signin`).

| Endpoint | Purpose |
|----------|---------|
| `POST /auth/signup` | Create org + user, sends verification email |
| `POST /auth/verify` | Verify email with token |
| `POST /auth/signin` | Sign in, returns JWT |
| `POST /api/domains` | Create a domain |
| `POST /api/domains/:id/verify` | Verify domain DNS records |
| `POST /api/domains/:id/inboxes` | Create an inbox on a domain |
| `POST /api/email/send` | Send an email |
| `GET /api/messages` | Query messages |

### Public API (`/v1/*`)
Used by SDKs and external integrations. Authenticated via API key (Bearer token from key creation).

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/messages/send` | Send an email |
| `GET /v1/threads` | List conversation threads |
| `GET /v1/threads/:id/messages` | Get messages in a thread |
| `GET /v1/domains` | List domains |
| `POST /v1/domains/:id/inboxes` | Create an inbox |
| `GET /v1/delivery/metrics` | Delivery statistics |
| `GET /v1/delivery/events` | Delivery event history |
| `GET /v1/search` | Semantic search across messages |

See [docs/PUBLIC_API.md](./docs/PUBLIC_API.md) for the full API reference.

## Domain Setup

1. Create a domain: `POST /api/domains` with `{ "name": "mail.yourdomain.com" }`
2. The response includes DNS records (MX, SPF, DKIM) to add at your DNS provider
3. Verify: `POST /api/domains/:id/verify` — checks DNS propagation
4. Create an inbox: `POST /api/domains/:id/inboxes` with `{ "localPart": "support", "displayName": "Support Agent" }`

Inbound email to `support@mail.yourdomain.com` will now be processed and forwarded to your webhook endpoint.

## Webhook Integration

Configure a webhook on your inbox to receive processed emails:

```bash
POST /api/domains/:domainId/inboxes/:inboxId/webhook
{
  "endpoint": "https://your-app.com/webhooks/email"
}
```

Every inbound email is delivered to your endpoint as a signed POST request with headers:

| Header | Value |
|--------|-------|
| `x-commune-signature` | `v1={HMAC-SHA256(secret, "{timestamp}.{body}")}` |
| `x-commune-timestamp` | Unix milliseconds |
| `x-commune-delivery-id` | Unique delivery ID |
| `x-commune-attempt` | Attempt number (1-8) |

The payload includes the full message, attachments metadata, spam analysis, and prompt injection analysis. See [docs/security/webhook-signatures.md](./docs/security/webhook-signatures.md) for verification examples.

## Structured Data Extraction

Extract structured JSON from emails using AI. Configure a JSON Schema on your inbox:

```bash
PUT /api/domains/:domainId/inboxes/:inboxId/extraction-schema
{
  "name": "invoice_extraction",
  "description": "Extract invoice details from emails",
  "enabled": true,
  "schema": {
    "type": "object",
    "properties": {
      "invoiceNumber": { "type": "string" },
      "amount": { "type": "number" },
      "dueDate": { "type": "string" }
    },
    "required": ["invoiceNumber", "amount"]
  }
}
```

Extracted data appears in the webhook payload under `extractedData` and in the stored message under `metadata.extracted_data`. Extraction is conversation-aware — it uses the full thread context for multi-turn email chains. Requires `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT` in your environment.

## Security

The security architecture is documented in detail in [ARCHITECTURE.md](./ARCHITECTURE.md). Key highlights:

- **Encryption at rest** — AES-256-GCM with per-field encryption, key rotation support, and three-layer key guard (fingerprint lock, decryption canary, startup halt)
- **Inbound threat detection** — 5-layer spam detection, prompt injection analysis (5 signal categories), ClamAV + heuristic attachment scanning
- **Deliverability protection** — Per-org sending health circuit breaker (bounce/complaint rate monitoring), 14-day domain warmup schedule, automatic suppression list management
- **API security** — Bcrypt-hashed API keys, JWT authentication, sliding-window rate limiting (Redis + Lua), audit logging with auto-expiry
- **Transport security** — HSTS, security headers via Helmet, Svix webhook signature verification, HMAC-signed outbound webhooks with timing-safe comparison

See the [docs/security/](./docs/security/) directory for detailed documentation on each security subsystem.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URL` | Yes | MongoDB connection string |
| `RESEND_API_KEY` | Yes | Resend API key |
| `JWT_SECRET` | Yes (prod) | JWT signing secret (≥32 chars) |
| `EMAIL_ENCRYPTION_KEY` | Yes (prod) | 64 hex chars for AES-256-GCM |
| `PUBLIC_WEBHOOK_BASE_URL` | Yes | Public URL for Resend webhook callbacks |
| `FRONTEND_BASE_URL` | Yes | Frontend URL for verification emails |
| `REDIS_URL` | No | Redis for rate limiting (falls back to in-memory) |
| `AZURE_OPENAI_ENDPOINT` | No | Azure OpenAI for structured extraction |
| `AZURE_OPENAI_API_KEY` | No | Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT` | No | Azure OpenAI deployment name |
| `CLOUDINARY_CLOUD_NAME` | No | Cloudinary for attachment storage |
| `CLOUDINARY_API_KEY` | No | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | No | Cloudinary secret |
| `CLAMAV_HOST` | No | ClamAV daemon for attachment scanning |
| `QDRANT_URL` | No | Qdrant for vector search |

See `.env.example` for the complete list with descriptions.

## Build

```bash
npm run build    # Compiles TypeScript to dist/
npm start        # Runs the compiled server
```

## License

Business Source License 1.1 — see [LICENSE.md](./LICENSE.md).
