# Deliverability Compliance

## What It Does

Modern inbox providers (Gmail, Yahoo, Outlook) enforce strict requirements for email senders. Non-compliant senders get filtered to spam or rejected entirely. Commune handles these requirements **automatically on every outbound email** — no configuration, no headers to add manually.

---

## One-Click Unsubscribe (RFC 8058)

Every outbound email includes the `List-Unsubscribe` and `List-Unsubscribe-Post` headers required by Gmail and Yahoo's 2024 sender requirements. This enables the "Unsubscribe" button that appears in email clients next to the sender name.

### How It Works

```
Recipient clicks "Unsubscribe" in Gmail/Yahoo/Outlook
        │
        ▼
  POST request sent to Commune's unsubscribe endpoint
        │
        ▼
  Cryptographic signature verified (tamper-proof)
        │
        ▼
  Contact permanently added to your suppression list
        │
        ▼
  No future emails sent to this address
```

- **Cryptographically signed** — unsubscribe links contain an HMAC signature so they can't be forged or tampered with
- **Permanent suppression** — once someone unsubscribes, they're on your suppression list permanently (unless they re-subscribe)
- **Reduces complaints** — recipients who would have clicked "Report Spam" use the unsubscribe button instead, which doesn't damage your sender reputation

### Why This Matters

Gmail and Yahoo now require one-click unsubscribe for bulk senders. Emails without these headers face increased spam filtering. More importantly, easy unsubscribe **protects your reputation** — a complaint (spam report) hurts your domain far more than an unsubscribe.

---

## DMARC Monitoring

Commune parses and stores aggregate DMARC reports from inbox providers, giving you visibility into:

- Whether your emails are passing **SPF**, **DKIM**, and **DMARC** authentication checks
- Whether anyone is **spoofing your domain** (sending email as your domain without authorization)
- Per-source IP authentication results

### API Endpoints

```
POST /v1/dmarc/reports     — Ingest a DMARC aggregate report (XML)
GET  /v1/dmarc/reports     — List DMARC reports for your domain
GET  /v1/dmarc/summary     — Authentication pass rates and spoofing alerts
```

---

## Email Authentication

When you connect a domain through Commune, the following authentication records are configured via Resend:

| Record | Purpose |
|--------|---------|
| **SPF** | Authorizes Commune's servers to send email on behalf of your domain |
| **DKIM** | Cryptographically signs every email so receivers can verify it wasn't tampered with |
| **DMARC** | Tells receivers what to do if SPF or DKIM fail (and where to send reports) |
| **MX** | Routes inbound email to Commune for processing |

All four are set up during domain onboarding. You verify them once and they're active permanently.

---

## For Developers

- **Zero configuration** — compliance headers are added to every outbound email automatically
- **No manual unsubscribe handling** — Commune processes unsubscribe requests end-to-end
- **DMARC visibility** — query your authentication health via the API without parsing XML reports yourself
- **Domain setup is guided** — the onboarding flow tells you exactly which DNS records to add

## For AI Agents

- Agents sending email are automatically compliant with Gmail/Yahoo requirements — no extra work needed
- Unsubscribe handling is fully automated — agents don't need to process or honor unsubscribe requests manually
- DMARC monitoring gives agents (or their operators) visibility into whether outbound emails are authenticating correctly
- Combined with domain warmup and reputation autopilot, agents have a complete sending compliance stack
