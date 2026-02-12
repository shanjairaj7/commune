# Email Validation Engine

## What It Does

Before any email leaves your domain, every recipient address passes through a multi-stage validation engine. Invalid, risky, and disposable addresses are caught and suppressed **before sending** — protecting your bounce rate and sender reputation automatically.

---

## Validation Stages

### 1. Syntax Validation
Rejects malformed email addresses that would guaranteed-bounce. Catches missing `@`, invalid characters, oversized local parts, and malformed domains.

### 2. MX Record Verification
Performs a live DNS lookup to verify the recipient's domain has valid mail servers (MX records). If no MX or A records exist, the address is rejected — the domain literally cannot receive email.

- DNS lookups are cached (TTL: 5 minutes by default) to avoid repeated lookups for the same domain
- Timeout: 1.2 seconds — if DNS doesn't respond, the address is allowed through (fail-open to avoid blocking legitimate mail)

### 3. Disposable Domain Detection
Checks the recipient's domain against a database of thousands of known disposable email providers (Mailinator, Guerrilla Mail, temp-mail, etc.). Disposable addresses are flagged with a warning but not blocked — useful for agents that want to deprioritize or tag these contacts.

### 4. Role-Based Address Detection
Identifies role-based addresses like `info@`, `support@`, `admin@`, `noreply@`. These addresses typically forward to multiple people and are more likely to generate complaints. Flagged with a warning.

### 5. Suppression Check
Cross-references every address against your active suppression list — known bounces, past complaints, and unsubscribes are excluded from every send automatically.

---

## What You Get Back

When you send via the API, the response includes per-recipient validation results:

```json
{
  "message_id": "msg_abc123",
  "validation": {
    "rejected": ["invalid@nonexistent-domain.xyz"],
    "warnings": [
      { "email": "test@mailinator.com", "reason": "disposable_domain" },
      { "email": "info@company.com", "reason": "role_based" }
    ],
    "suppressed": ["bounced-user@example.com"]
  }
}
```

- **Rejected** — Address is definitively invalid; email was not sent
- **Warnings** — Address is risky but email was still sent; useful for tagging or scoring
- **Suppressed** — Address is on your suppression list; email was not sent

Valid recipients in the same batch still send normally — one bad address doesn't block the whole batch.

---

## For Developers

- **Zero configuration** — validation runs on every send automatically
- **Partial success** — a batch with some invalid addresses still delivers to valid ones
- **Per-recipient results** — your app knows exactly which addresses were rejected and why
- **Deduplication** — duplicate addresses in a batch are automatically collapsed

## For AI Agents

- Agents sending outreach or follow-up emails are protected from list quality issues
- Disposable domain detection helps agents identify low-quality leads
- Suppression is automatic — agents can't accidentally re-email someone who bounced or complained
- The validation response gives agents structured data to update their contact lists

---

## Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `MX_CACHE_TTL_SECONDS` | 300 | How long MX lookup results are cached |
| `MX_LOOKUP_TIMEOUT_MS` | 1200 | DNS timeout before fail-open |
