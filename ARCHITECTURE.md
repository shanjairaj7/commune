# Architecture

This document describes how Commune's backend works at a technical level — how email flows through the system, how data is protected, and how each security layer operates. It is written for engineers auditing the codebase.

## System Overview

Commune is email infrastructure for AI agents. It receives inbound email via Resend webhooks, delivers outbound email via Resend's API, and forwards processed messages to customer endpoints via signed webhooks. The backend is a Node.js/Express server backed by MongoDB (persistent state), Redis (rate limiting, caching), and Qdrant (vector search).

```
                                 ┌──────────────┐
                                 │  Resend API   │
                                 └──────┬───────┘
                                        │
                     ┌──────────────────┼──────────────────┐
                     │ inbound webhook  │  outbound send   │
                     ▼                  │                  ▲
              ┌─────────────┐           │           ┌──────┴──────┐
              │ verifySvix  │           │           │  sendEmail  │
              │ (signature) │           │           │  (lib)      │
              └──────┬──────┘           │           └──────┬──────┘
                     │                  │                  ▲
                     ▼                  │                  │
              ┌─────────────┐           │           ┌──────┴──────┐
              │ Spam        │           │           │ Dashboard   │
              │ Detection   │           │           │ /api routes │
              │ (5 layers)  │           │           │ or /v1 API  │
              └──────┬──────┘           │           └─────────────┘
                     │                  │
                     ▼                  │
              ┌─────────────┐           │
              │ Prompt      │           │
              │ Injection   │           │
              │ Detector    │           │
              └──────┬──────┘           │
                     │                  │
                     ▼                  │
              ┌─────────────┐    ┌──────┴──────┐
              │ Attachment   │    │  MongoDB    │
              │ Scanner     │    │ (encrypted) │
              │ (ClamAV +   │    └──────┬──────┘
              │  heuristic) │           │
              └──────┬──────┘           │
                     │                  │
                     ▼                  ▼
              ┌─────────────┐    ┌─────────────┐
              │ Store msg   │    │ WebSocket   │
              │ (encrypted) │    │ push to     │
              └──────┬──────┘    │ dashboard   │
                     │           └─────────────┘
                     ▼
              ┌─────────────┐
              │ Webhook     │
              │ Delivery    │
              │ (signed,    │
              │  retried)   │
              └─────────────┘
```

---

## Encryption at Rest

All email content is encrypted before it touches the database. The implementation is in `src/lib/encryption.ts`.

**Algorithm:** AES-256-GCM (authenticated encryption)
- 256-bit key from `EMAIL_ENCRYPTION_KEY` (64 hex chars)
- 96-bit random IV per encryption operation (NIST recommended for GCM)
- 128-bit authentication tag (integrity + tamper detection)
- Output format: `enc:<base64(IV ‖ ciphertext ‖ authTag)>`

**What gets encrypted** (in `encryptMessageFields`):
| Field | Why |
|-------|-----|
| `content` | Email body plaintext |
| `content_html` | Email body HTML |
| `metadata.subject` | Subject line |
| `participants[].identity` | Sender/recipient email addresses |
| `metadata.extracted_data` | AI-extracted structured data |
| Attachment `content_base64` | File contents |
| Webhook delivery `payload` | Full webhook payload at rest |
| Domain/inbox `webhook.secret` | Customer webhook signing secrets |

**Indexed lookups on encrypted data:** Participant email addresses need to be queryable (e.g., "find messages from alice@example.com") without decrypting every record. Each participant gets an `_identity_hash` field — a SHA-256 of the lowercased email — stored alongside the encrypted `identity`. Queries filter by hash; decryption only happens on the matching results.

**Double-encryption guard:** The `encrypt()` function checks for the `enc:` prefix before encrypting. If data is already encrypted, it returns it unchanged. This prevents corruption from accidental double-encryption in retry paths.

**Fail-open policy:** If encryption or decryption fails, the original data is returned rather than throwing. This is a deliberate design choice — losing data is worse than storing it unencrypted temporarily. The structured logger records every failure for monitoring.

### Key Rotation

Safe key rotation without downtime is supported via dual-key decryption (`src/lib/encryptionKeyGuard.ts`):

1. Set `EMAIL_ENCRYPTION_KEY_PREVIOUS` to the current key
2. Set `EMAIL_ENCRYPTION_KEY` to the new key
3. Set `ENCRYPTION_KEY_ROTATION=true`
4. Deploy — the server registers the new key fingerprint and decrypts with fallback to the previous key
5. Run re-encryption migration to re-encrypt all data with the new key
6. Remove `EMAIL_ENCRYPTION_KEY_PREVIOUS` and `ENCRYPTION_KEY_ROTATION`

The `decrypt()` function tries the current key first, then falls back to the previous key. This means both old and new data remain readable during the transition.

### Encryption Key Guard

Three layers prevent accidental key loss (`src/lib/encryptionKeyGuard.ts`):

1. **Key Fingerprint Lock** — On first boot, the SHA-256 fingerprint of the encryption key is stored in MongoDB (`encryption_key_lock` collection). On every subsequent boot, the current key's fingerprint is compared. If they don't match and `ENCRYPTION_KEY_ROTATION` isn't set, the server calls `process.exit(1)`. This prevents accidental key changes from silently corrupting data.

2. **Decryption Canary** — The server finds one encrypted message in the database and attempts to decrypt it. If decryption fails, the server refuses to start. This catches cases where the key is syntactically correct but doesn't match the data.

3. **Startup Halt** — Both checks run in `ensureEncryptionKeyIntegrity()`, called from `server.ts` immediately after the server starts listening. If either check fails, the process exits before accepting real traffic. The `ENCRYPTION_UNSAFE_SKIP_GUARDS=true` escape hatch exists for emergency recovery scenarios only.

---

## Authentication

Two authentication paths serve different consumers (`src/middleware/`):

### JWT Authentication (Dashboard)
- Used by the frontend dashboard (`/api/*` routes)
- `combinedAuth` middleware in `src/middleware/combinedAuth.ts`
- Tokens issued on login, verified against `JWT_SECRET`
- User record fetched from MongoDB on every request to check status/permissions
- No insecure fallback — if `JWT_SECRET` is unset, JWT auth rejects all tokens

### API Key Authentication (SDK/Public API)
- Used by SDKs and external integrations (`/v1/*` routes)
- `apiKeyAuth` middleware in `src/middleware/apiKeyAuth.ts`
- Keys are stored as bcrypt hashes — the plaintext key is shown once at creation and never stored
- Key prefix (first 8 chars) stored for identification in logs without exposing the full key
- Scoped permissions: keys can be restricted to specific operations (send, read, admin)
- `lastUsedAt` updated on each request for auditing

### Security Bootstrap
Before the server starts, `src/boot/securityBootstrap.ts` validates:
- `JWT_SECRET` exists and isn't in the known-insecure list (e.g., "changeme", "secret")
- `JWT_SECRET` is at least 32 characters
- `EMAIL_ENCRYPTION_KEY` is exactly 64 hex characters
- `MONGO_URL` is set and uses TLS in production
- `RESEND_API_KEY` is set

In production (`NODE_ENV=production`), missing critical secrets cause the server to exit immediately.

---

## Inbound Email Flow

When an email arrives, the full processing pipeline in `src/services/email/inboundWebhook.ts`:

### 1. Webhook Verification
Resend signs inbound webhooks using Svix. The raw HTTP body is verified against the domain's webhook secret using `src/lib/verifySvix.ts` (Svix SDK). The webhook route is mounted *before* the Express JSON parser to preserve the raw body for signature verification.

### 2. Idempotency
Each webhook carries a `svix-id`. Before processing, we check if this ID has been seen:
- **Redis** (primary): `SET webhook:dedup:{svix-id} 1 EX 3600`
- **In-memory LRU** (fallback): Map with 10,000 entry cap and 1-hour TTL

Duplicate webhooks return `{ duplicate: true }` without reprocessing.

### 3. Domain & Inbox Resolution
The system infers which domain and inbox the email is for:
1. Parse recipient addresses from the `to` field
2. Look up the domain by the recipient's email domain (e.g., `agents.example.com`)
3. Match the inbox by the local part (e.g., `support` in `support@agents.example.com`)

### 4. Thread Resolution (3-tier priority)
Inbound replies need to be linked to the correct conversation thread:

1. **Plus-address routing token** (highest priority): Outbound emails include a Reply-To like `agent+t1a2b3c4d5e6@domain.com`. The `t1a2b3c4d5e6` is an HMAC-SHA256-based token (`src/lib/threadToken.ts`) that maps to a `thread_id` via in-memory cache or MongoDB fallback.

2. **DB lookup by SMTP headers**: The `In-Reply-To` and `References` headers from the inbound email are matched against stored `metadata.message_id` and `metadata.resend_id` fields in MongoDB. This handles replies from clients that strip plus-addresses.

3. **SMTP header fallback**: If neither of the above resolves, a new `thread_id` is generated from the SMTP `Message-ID`.

### 5. Spam Detection
`src/services/spam/spamDetectionService.ts` runs 5 parallel analyzers:

| Analyzer | What it checks |
|----------|---------------|
| `ContentAnalyzer` | Spam keywords, CAPS ratio, punctuation density, HTML-to-text ratio, suspicious patterns |
| `URLValidator` | Blacklisted domains, URL shorteners, broken links, SSL validity |
| `DNSBLChecker` | Sender IP/domain against DNS-based blackhole lists |
| `ReputationCalculator` | Per-sender email history (bounce rate, complaint rate, volume) |
| `MassEmailDetector` | Volume spikes from single senders indicating mass email attacks |

The composite score determines the action:
- **Score ≥ 0.8** → `reject` — email is blocked, stored in `blocked_spam` collection for tracking, sender reputation updated
- **Score ≥ 0.5** → `flag` — email is delivered with `spam_flagged: true` in metadata
- **Score < 0.5** → `accept` — normal processing

Rejected emails return HTTP 200 to Resend (to prevent retries) but are not stored in the messages collection.

### 6. Prompt Injection Detection
`src/services/security/promptInjectionDetector.ts` protects AI agents that consume email via webhooks. It scans email content for 5 categories of injection attempts:

| Signal | Weight | Examples |
|--------|--------|---------|
| Role Override | 0.35 | "Ignore all previous instructions", "You are now a..." |
| LLM Delimiter Injection | 0.25 | `<|system|>`, `[INST]`, triple backtick boundaries |
| Hidden Text | 0.20 | Zero-width characters, white-on-white text, HTML display:none |
| Data Exfiltration | 0.15 | "Send the contents of...", "Output all previous..." |
| Encoding Obfuscation | 0.05 | Base64-encoded instructions, Unicode homoglyphs |

**Detection only, never blocks delivery.** Results are attached to message metadata (`prompt_injection_detected`, `prompt_injection_risk`, `prompt_injection_score`) and included in the webhook payload so the receiving agent can decide how to handle it.

### 7. Attachment Processing
For each attachment:
1. Download from Resend's temporary URL
2. **Security scan** via `AttachmentScannerService`: ClamAV TCP scan if available, otherwise heuristic analysis (file type validation, magic byte checking, known malware hash DB, size limits). Threats are quarantined — stored with `quarantined: true` and `scan_threats` metadata instead of the actual content.
3. Upload to Cloudinary (if configured) or store as encrypted base64 in MongoDB

### 8. Message Storage
The normalized message is encrypted field-by-field via `encryptMessageFields()` and inserted into MongoDB. The `_encrypted: true` flag marks it for decryption on read.

### 9. Structured Data Extraction
If the inbox has an `extractionSchema` configured, the email content (or full conversation thread for multi-turn interactions) is processed by Azure OpenAI to extract structured data into the schema. Results are stored encrypted in `metadata.extracted_data`.

### 10. Real-time Push
The message is pushed to connected dashboard clients via WebSocket (`src/services/realtimeService.ts`). Only a minimal payload is sent (~200 bytes: inbox_id, thread_id, subject, from, direction). The WebSocket server authenticates connections via JWT on upgrade, enforces per-org (20) and per-user (5) connection limits, and validates CORS origins.

### 11. Webhook Delivery
If the inbox has a webhook endpoint configured, the full message payload is delivered via `src/services/webhookDeliveryService.ts`:

**Signing:** Every webhook is signed with HMAC-SHA256. The signature format is `v1={HMAC-SHA256(secret, "{timestamp_ms}.{body}")}`, sent in `x-commune-signature` header alongside `x-commune-timestamp` (Unix milliseconds), `x-commune-delivery-id`, and `x-commune-attempt`.

**Retry with exponential backoff:** Failed deliveries are retried up to 8 times with delays of 5s, 30s, 2min, 10min, 30min, 1hr, 2hr, 4hr (with ±25% jitter). A background retry worker polls for pending deliveries every 5 seconds.

**Circuit breaker:** Per-endpoint circuit breaker opens after 5 consecutive failures, blocking further attempts for 5 minutes. After cooldown, one attempt is allowed (half-open state).

**Dead letter queue:** After all retries are exhausted, the delivery is marked `dead` with the full attempt history preserved for debugging.

**Re-signing on retry:** Each retry attempt re-computes the signature with a fresh timestamp using the stored (encrypted) webhook secret, preventing stale signatures.

---

## Outbound Email Flow

When sending email via `src/services/email/sendEmail.ts`:

### 1. From Address Resolution
The `buildFromAddress` function resolves the sender address through a priority chain:
1. Explicit `from` parameter → use directly (with inbox display name if available)
2. Inbox `address` or `localPart` + domain name → `support@agents.example.com`
3. Domain-level default → `agent@agents.example.com`
4. Fallback → `DEFAULT_FROM_EMAIL` env var

Display names are formatted per RFC 5322: `"Support Agent" <support@example.com>`.

### 2. Suppression Check
Each recipient is checked against the suppression list (`suppressionStore.isSuppressed`). Suppressed recipients are skipped. If all recipients are suppressed, the send is rejected.

### 3. Recipient Validation
`EmailValidationService` validates remaining recipients:
- Email syntax validation
- MX record lookup (does the domain accept email?)
- Disposable email domain detection
- Role address warnings (e.g., postmaster@, abuse@)

Invalid recipients are rejected; warnings are returned in the response.

### 4. Header Construction
- **Message-ID**: Generated as `<uuid@sender-domain>` for internal reference. Resend will assign its own ID (`<id@resend.dev>`) that recipients actually see.
- **Threading**: If `thread_id` is provided, the latest message in that thread is fetched. Its Resend-format Message-ID is used for `In-Reply-To`, and a `References` chain is built per RFC 5322.
- **Reply-To routing token**: A plus-addressed Reply-To (`agent+t1a2b3c4d5e6@domain.com`) is stamped so inbound replies map back to the thread. Skipped only if the caller explicitly set `reply_to`.
- **Custom headers**: User-provided headers are sanitized via `sanitizeCustomHeaders` — CRLF injection is stripped, forbidden headers (From, DKIM-Signature, etc.) are blocked.
- **List-Unsubscribe**: RFC 8058 one-click unsubscribe URL with HMAC-signed token (`src/lib/unsubscribeToken.ts`). Required by Gmail and Yahoo for deliverability.

### 5. Send via Resend
The constructed payload is sent via the Resend SDK. Both the Resend API response ID and our custom Message-ID are stored, enabling thread resolution from either direction.

### 6. Deliverability Tracking
- **Sending Health Service** (`src/services/sendingHealthService.ts`): Tracks per-org bounce and complaint rates over a 24-hour rolling window using Redis sorted sets (Lua scripts for atomicity). Pause thresholds: 5% bounce rate or 0.3% complaint rate. The `sendingHealthGate` middleware blocks sends when an org is paused.
- **Domain Warmup Service** (`src/services/domainWarmupService.ts`): New domains follow a 14-day warmup schedule (50 → 100 → 250 → 500 → 1000 → 2500 → 5000 emails/day). The `warmupGate` middleware enforces daily limits.

---

## Delivery Event Processing

Resend sends webhooks for delivery events (sent, delivered, bounced, complained, failed, delayed, suppressed). Processing is in `src/services/email/deliveryEvents.ts`:

- **Bounces**: Hard bounces immediately add the recipient to the suppression list. Soft bounces are tracked; after 3 consecutive soft bounces, a temporary suppression (7 days) is created. Successful delivery resets the soft bounce counter.
- **Complaints**: The recipient is permanently suppressed. The complaint is recorded for circuit breaker health tracking.
- **Orphan events**: If a delivery event references a Resend email ID that doesn't match any stored message, it's stored as an orphan event with an attempted inbox inference from the sender address.

---

## Rate Limiting

Two layers (`src/lib/redisRateLimiter.ts` + `src/middleware/rateLimiter.ts`):

**Redis-backed sliding window** (primary):
- Uses sorted sets with Lua scripts for atomic increment-and-check
- Per-org email sending: configurable per-hour and per-day limits by tier (free/pro/enterprise)
- Outbound burst detection: flags rapid fire patterns within short windows
- Falls back to Express `express-rate-limit` if Redis is unavailable

**Tier-based limits** (`src/config/rateLimits.ts`):
| Tier | Emails/hour | Emails/day | Domains | Inboxes/day |
|------|------------|------------|---------|-------------|
| Free | 50 | 200 | 1 | 5 |
| Pro | 500 | 5,000 | 10 | 50 |
| Enterprise | 5,000 | 50,000 | 100 | 500 |

---

## Audit Logging

Every authenticated API request is logged to MongoDB (`src/middleware/auditLog.ts`):
- **Who**: user ID, org ID, auth type (JWT/API key), API key ID
- **What**: HTTP method, path, resource type (inferred), resource ID (inferred)
- **When**: ISO 8601 timestamp
- **How**: client IP (from X-Forwarded-For), user agent, request ID (for distributed tracing)
- **Result**: HTTP status code, response time in milliseconds

Write operations and sensitive-path reads are always logged. Health checks are skipped. Logs auto-expire via MongoDB TTL index (configurable, default 90 days).

---

## Security Headers

Applied to every response (`src/middleware/securityHeaders.ts`):
- **HSTS**: `max-age=31536000; includeSubDomains; preload` (enforces HTTPS for 1 year)
- **X-Content-Type-Options**: `nosniff` (prevents MIME sniffing)
- **X-Frame-Options**: `DENY` (prevents clickjacking)
- **X-DNS-Prefetch-Control**: `off`
- **Referrer-Policy**: `strict-origin-when-cross-origin`
- **Cache-Control**: `no-store, no-cache, must-revalidate, proxy-revalidate` (no caching of API responses)
- **Permissions-Policy**: `camera=(), microphone=(), geolocation=(), interest-cohort=()` (disables unused browser features)
- **X-Request-ID**: UUID per request, uses client-provided value for distributed tracing (capped at 128 chars)

---

## Project Structure

```
src/
├── server.ts                  Express app setup, middleware registration, startup
├── db.ts                      MongoDB connection with retry logic
├── startup.ts                 Monitoring + metrics scheduler init
├── boot/
│   ├── ensureIndexes.ts       Parallel database index creation at startup
│   └── securityBootstrap.ts   Startup security config validation
├── config/
│   ├── freeTierConfig.ts      Default domain config
│   └── rateLimits.ts          Tier-based rate limits
├── lib/
│   ├── encryption.ts          AES-256-GCM field-level encryption
│   ├── encryptionKeyGuard.ts  Three-layer key safety checks
│   ├── redis.ts               Redis client with reconnect + fallback
│   ├── redisRateLimiter.ts    Lua-script sliding window rate limiting
│   ├── sanitize.ts            CRLF injection prevention, header validation
│   ├── threadToken.ts         HMAC-based opaque routing tokens
│   ├── unsubscribeToken.ts    HMAC-signed one-click unsubscribe URLs
│   ├── validation.ts          Zod request schemas
│   └── verifySvix.ts          Svix webhook signature verification
├── middleware/
│   ├── apiKeyAuth.ts          API key authentication (standalone)
│   ├── attachApiContext.ts    Normalize auth context on request
│   ├── auditLog.ts            Request audit logging with TTL
│   ├── combinedAuth.ts        JWT + API key dual auth (dashboard routes)
│   ├── errorHandler.ts        Global error handler
│   ├── jwtAuth.ts             JWT-only authentication
│   ├── permissions.ts         Permission-based route guards
│   ├── rateLimiter.ts         Express-based rate limiting (fallback)
│   ├── securityHeaders.ts     Helmet + HSTS + request ID
│   ├── sendingHealthGate.ts   Blocks sends when bounce/complaint rate too high
│   ├── spamPrevention.ts      Outbound content validation
│   ├── validateRequest.ts     Zod schema validation middleware
│   └── warmupGate.ts          Enforces domain warmup daily limits
├── routes/
│   ├── health.ts              Health check endpoint
│   ├── webhooks.ts            Resend inbound webhook handler
│   ├── dashboard/             Dashboard API (JWT auth, /api/*)
│   │   ├── admin.ts           Admin/migration endpoints
│   │   ├── apiKeys.ts         API key CRUD
│   │   ├── attachments.ts     Attachment retrieval
│   │   ├── auth.ts            Login, register, password reset
│   │   ├── domains.ts         Domain CRUD + DNS verification
│   │   ├── inboxes.ts         Inbox CRUD + webhook config
│   │   ├── messages.ts        Send + query messages
│   │   ├── organizations.ts   Org management
│   │   ├── search.ts          Vector search
│   │   └── spam.ts            Spam stats + management
│   └── v1/                    Public API (API key auth, /v1/*)
│       ├── index.ts           Route aggregation with API key auth
│       ├── messages.ts        POST /v1/messages/send
│       ├── threads.ts         Thread listing + messages
│       ├── domains.ts         Domain management
│       ├── inboxes.ts         Inbox management
│       ├── attachments.ts     Attachment download
│       ├── search.ts          Vector search
│       ├── deliveryMetrics.ts Delivery stats + events + suppressions
│       ├── dmarc.ts           DMARC report ingestion
│       ├── webhookDeliveries.ts Webhook delivery status + retry
│       └── unsubscribe.ts     One-click unsubscribe handler
├── services/
│   ├── email/                 Core email processing
│   │   ├── sendEmail.ts       Outbound: address building, validation, headers, send
│   │   ├── inboundWebhook.ts  Inbound: verification, spam, injection, storage
│   │   ├── deliveryEvents.ts  Bounce, complaint, delivered event handling
│   │   ├── helpers.ts         Address parsing, domain inference, webhook dedup
│   │   ├── normalize.ts       Raw email → UnifiedMessage normalization
│   │   └── index.ts           Re-exports
│   ├── spam/                  Multi-layer spam detection
│   │   ├── spamDetectionService.ts   Orchestrator (5 parallel analyzers)
│   │   ├── contentAnalyzer.ts        Keyword, pattern, structure analysis
│   │   ├── urlValidator.ts           URL blacklist, shortener, SSL checks
│   │   ├── dnsblChecker.ts           DNS blackhole list lookups
│   │   ├── reputationCalculator.ts   Per-sender reputation scoring
│   │   └── massEmailDetector.ts      Volume spike detection
│   ├── security/
│   │   ├── promptInjectionDetector.ts  5-signal injection detection for AI agents
│   │   └── attachmentScannerService.ts ClamAV + heuristic attachment scanning
│   ├── webhookDeliveryService.ts      Guaranteed delivery with retry + circuit breaker
│   ├── sendingHealthService.ts        Per-org bounce/complaint circuit breaker
│   ├── domainWarmupService.ts         14-day warmup schedule enforcement
│   ├── realtimeService.ts            WebSocket push with JWT auth + rate limiting
│   ├── domainService.ts              Resend domain + webhook management
│   ├── emailValidationService.ts     MX lookup, disposable domain detection
│   ├── structuredExtractionService.ts Azure OpenAI structured extraction
│   ├── attachmentStorageService.ts   Cloudinary upload + database fallback
│   └── ...
├── stores/                    MongoDB data access layer (one file per collection)
│   ├── messageStore.ts        Messages + attachments (encrypt on write, decrypt on read)
│   ├── domainStore.ts         Domains + inboxes (webhook secrets encrypted)
│   ├── deliveryEventStore.ts  Delivery tracking events
│   ├── suppressionStore.ts    Email suppression list
│   ├── webhookDeliveryStore.ts Webhook delivery queue (payloads encrypted)
│   └── ...
├── types/                     TypeScript type definitions
│   ├── index.ts               Consolidated re-exports
│   ├── messages.ts            UnifiedMessage, AttachmentRecord, Channel, Direction
│   ├── domains.ts             DomainEntry, InboxEntry, SendMessagePayload
│   ├── auth.ts                Organization, User, ApiKey, Session
│   ├── delivery.ts            DeliveryEvent, SuppressionEntry, WebhookDelivery
│   ├── spam.ts                SpamScore, SpamAnalysisResult, DomainReputation
│   ├── search.ts              SearchFilter, SearchResult, VectorData
│   └── webhooks.ts            SvixHeaders, InboundEmailWebhookPayload
├── utils/
│   ├── logger.ts              Winston structured logging
│   ├── passwords.ts           Bcrypt password hashing
│   └── tokens.ts              Secure token generation
└── scripts/
    └── migrateToAuth.ts       One-time auth migration script
```

---

## Environment Variables

See `.env.example` for the full list. Critical security variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `JWT_SECRET` | Yes (prod) | JWT signing. Must be ≥32 chars, not a known default |
| `EMAIL_ENCRYPTION_KEY` | Yes (prod) | AES-256-GCM key. Exactly 64 hex chars. **Do not change without rotation procedure.** |
| `MONGO_URL` | Yes | MongoDB connection string. Use TLS in production |
| `RESEND_API_KEY` | Yes | Resend API key for sending email |
| `REDIS_URL` | No | Redis for rate limiting. Falls back to in-memory |
| `THREAD_TOKEN_SECRET` | No | HMAC secret for routing tokens. Falls back to JWT_SECRET derivation |
| `UNSUBSCRIBE_SECRET` | No | HMAC secret for unsubscribe URLs. Falls back to JWT_SECRET derivation |

---

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Webhook forgery | Svix signature verification on every inbound webhook |
| Replay attacks | Svix-id dedup via Redis/memory; timestamp validation |
| Data breach (DB compromise) | AES-256-GCM encryption at rest for all sensitive fields |
| Key loss/change | Three-layer key guard: fingerprint lock, decryption canary, startup halt |
| Email header injection | CRLF stripping, forbidden header blocklist, length limits |
| Prompt injection via email | 5-signal detector flags attempts in metadata for agent consumers |
| Malware attachments | ClamAV scan + heuristic analysis; threats quarantined |
| Spam/phishing | 5-layer parallel analysis with reject/flag/accept thresholds |
| API abuse | Redis sliding-window rate limiting, tier-based quotas, burst detection |
| Deliverability damage | Sending health circuit breaker (bounce/complaint rate monitoring) |
| Domain reputation damage | 14-day warmup schedule for new domains |
| Webhook endpoint failure | Exponential backoff retry (8 attempts over ~8 hours), circuit breaker, dead letter queue |
| Session hijacking | JWT verification on every request, bcrypt-hashed API keys |
| Timing attacks | `crypto.timingSafeEqual` for all signature comparisons |
| Information leakage | Security headers (HSTS, no-cache, no-sniff), no X-Powered-By, no stack traces in production |
