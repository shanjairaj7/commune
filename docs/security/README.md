# Commune Security Documentation

Commune provides multi-layered security that protects both outbound sending reputation and inbound processing integrity — all enabled by default, zero configuration required.

These docs explain each security layer, what it does, and how developers and agents interact with it.

---

## Security Layers

### Outbound (Sending) Protection

| Layer | Doc | What It Does |
|-------|-----|-------------|
| Email Validation | [email-validation.md](./email-validation.md) | Validates every recipient before sending — catches spam traps, disposable addresses, invalid domains |
| Bounce Intelligence | [bounce-intelligence.md](./bounce-intelligence.md) | Classifies hard vs soft bounces, auto-suppresses, self-heals when addresses recover |
| Reputation Autopilot | [reputation-autopilot.md](./reputation-autopilot.md) | Real-time circuit breaker — auto-pauses sending before ISPs flag you |
| Domain Warmup | [domain-warmup.md](./domain-warmup.md) | Graduated sending schedule for new domains to build ISP trust safely |
| Deliverability Compliance | [deliverability-compliance.md](./deliverability-compliance.md) | One-click unsubscribe (RFC 8058), DMARC monitoring, Gmail/Yahoo compliance |

### Inbound (Receiving) Protection

| Layer | Doc | What It Does |
|-------|-----|-------------|
| Spam & Phishing Detection | [inbound-threat-detection.md](./inbound-threat-detection.md) | Multi-signal spam scoring, phishing detection, mass attack blocking |
| AI Agent Safety | [ai-agent-safety.md](./ai-agent-safety.md) | Prompt injection detection for AI agents processing email |
| Attachment Scanning | [attachment-scanning.md](./attachment-scanning.md) | File type blocking, magic byte inspection, malware signatures, ClamAV |

### Webhook & Delivery Infrastructure

| Layer | Doc | What It Does |
|-------|-----|-------------|
| Webhook Delivery Guarantee | [webhook-delivery-guarantee.md](./webhook-delivery-guarantee.md) | Retries, exponential backoff, circuit breaker, dead letter queue, delivery tracking API |
| Webhook Signature Verification | [webhook-signatures.md](./webhook-signatures.md) | HMAC-SHA256 signing so agents can verify webhook authenticity |

### Infrastructure Hardening

| Layer | Doc | What It Does |
|-------|-----|-------------|
| Encryption & Hardening | [encryption-and-hardening.md](./encryption-and-hardening.md) | AES-256-GCM encryption at rest, injection prevention, rate limiting, error redaction |

---

## For Developers

Every security feature is **on by default**. You don't configure or enable anything. When you send an email, validation and reputation protection happen automatically. When you receive an email, threat detection and AI safety scanning happen before your webhook fires.

Security metadata is included in every webhook payload and API response, so your application always knows the risk profile of what it's processing.

## For AI Agents

Commune is purpose-built for AI agent email infrastructure. The security layers are designed to:

- **Protect agents from manipulation** — Prompt injection detection flags emails that try to hijack agent behavior
- **Guarantee webhook delivery** — Retries with exponential backoff ensure your agent never misses an email, even during downtime
- **Provide rich context** — Every email arrives with spam scores, phishing flags, injection risk levels, and attachment scan results so agents can make informed decisions
- **Verify authenticity** — HMAC signatures on every webhook let agents cryptographically verify that payloads came from Commune and weren't tampered with
