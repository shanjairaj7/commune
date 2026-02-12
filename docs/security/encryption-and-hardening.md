# Encryption & Infrastructure Hardening

## What It Does

The infrastructure powering all of Commune's security layers is itself hardened against abuse, injection attacks, and information leakage. This includes encryption of all stored email content, input sanitization to prevent header injection, rate limiting on all public endpoints, and automatic error redaction in production.

---

## Encryption at Rest (AES-256-GCM)

All stored email content — subject lines, body text, snippets — is encrypted using **AES-256-GCM** before being written to the database. Decryption happens transparently when your application reads messages via the API or receives them via webhook.

### How It Works

- **Algorithm**: AES-256-GCM (authenticated encryption with associated data)
- **Per-field encryption**: Each sensitive field (subject, body, snippet) is encrypted independently with a unique IV
- **Transparent to your application**: You read and receive plaintext — encryption/decryption is handled at the storage layer
- **Optional**: If no encryption key is configured, data is stored unencrypted (useful for development)

### What's Encrypted

| Field | Encrypted |
|-------|-----------|
| Email subject | ✅ |
| Email body (text + HTML) | ✅ |
| Thread snippets | ✅ |
| Sender/recipient addresses | ❌ (needed for queries) |
| Message metadata | ❌ (needed for queries) |
| Attachment content | ✅ (encrypted at storage layer) |

---

## Input Sanitization (Injection Prevention)

All email fields are sanitized before processing to prevent **CRLF header injection** — a technique where malicious input adds unauthorized headers to redirect or copy your emails.

### What's Sanitized

- **Custom headers** — any headers you pass via the API are validated against a blocklist of reserved/dangerous headers and stripped of CRLF sequences
- **Email addresses** — validated for format correctness before processing
- **Subject lines** — stripped of control characters that could be used for injection
- **Reply-To addresses** — validated to prevent header injection via reply routing

---

## Rate Limiting

All public-facing endpoints are rate-limited to prevent abuse and flooding:

### Webhook Endpoints
- IP-based rate limiting on inbound webhook endpoints
- Prevents attackers from flooding your webhook processing pipeline

### API Endpoints
- Redis-backed sliding window rate limiting on all API routes
- Burst detection — sudden spikes in request volume trigger temporary throttling
- Per-API-key limits to prevent a single integration from monopolizing resources

### How It Works

Rate limiting uses **Redis sorted sets with Lua scripts** for atomic, race-condition-free counting. When Redis is unavailable, the system falls back to in-memory rate limiting (per-instance, not distributed).

---

## Webhook Verification (Inbound)

Webhooks from Resend to Commune are verified using **Svix signature verification**:

- Every inbound webhook includes `svix-id`, `svix-timestamp`, and `svix-signature` headers
- Commune verifies the signature against the shared webhook secret before processing
- Invalid signatures are rejected with a 400 error — no processing occurs
- Duplicate webhooks are detected via the `svix-id` (idempotency key) and safely ignored

---

## Error Redaction

In production, API error responses are automatically sanitized to prevent internal system details from leaking:

- Stack traces are never included in API responses
- Database error details are replaced with generic error messages
- Internal service names and paths are stripped from error responses
- Validation errors include field-level detail (useful for developers) without exposing internals

---

## For Developers

- **Encryption is transparent** — you never handle encrypted data directly; the API and webhooks always deliver plaintext
- **Injection protection is automatic** — you don't need to sanitize email fields before passing them to the API
- **Rate limit headers** are included in API responses so your app can implement backoff
- **Error messages are helpful in development, safe in production** — you get useful debug info locally without leaking internals in production

## For AI Agents

- Agent data is encrypted at rest — even if the database were compromised, email content is protected
- Rate limiting prevents runaway agents from accidentally DDoS-ing the API
- Injection prevention means an agent can safely forward user-provided content in email fields without risk of header injection
- Webhook verification ensures the agent's inbound pipeline only processes authentic events from Resend

---

## Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `EMAIL_ENCRYPTION_KEY` | — | 64 hex chars for AES-256-GCM (if not set, data stored unencrypted) |
| `REDIS_URL` | — | Redis connection for distributed rate limiting (falls back to in-memory) |
