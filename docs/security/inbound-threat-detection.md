# Inbound Threat Detection (Inbox Shield)

## What It Does

Every inbound email passes through a multi-layered threat detection system **before** reaching your application. The system analyzes multiple independent signals in parallel — content patterns, embedded links, sender history, sending domain reputation, and known blacklists — and produces an overall risk assessment.

High-confidence threats are rejected. Suspicious emails are flagged with warnings. Clean email passes through untouched. Every email arrives with **rich security metadata** so your application always knows the risk profile of what it's processing.

---

## Detection Layers

### Spam Detection

Analyzes email content for classic spam indicators across multiple signal categories:

- **Content analysis** — urgency tactics, financial lures, excessive capitalization, keyword density
- **Link analysis** — suspicious URLs, redirect chains, URL shorteners, known bad domains
- **Sender reputation** — historical behavior of the sending address (improves over time)
- **Domain reputation** — reputation of the sending domain, including blacklist checks
- **Behavioral patterns** — sending frequency, content similarity across messages

Each signal contributes to an overall **spam score**. Based on the score:
- `pass` — clean, delivered normally
- `flag` — suspicious, delivered with a warning in the metadata
- `reject` — high-confidence spam, blocked

### Phishing Detection

Purpose-built to catch emails that impersonate trusted brands or trick recipients into clicking malicious links:

- **Brand impersonation** — detects display names or addresses mimicking known brands
- **Typosquatting** — catches domains that are one character off from legitimate domains (e.g., `paypa1.com`)
- **URL analysis** — inspects every link in the email for redirects, suspicious TLDs, and known phishing domains
- **Header spoofing** — detects mismatches between the display name and actual sending domain

### Mass Attack Detection

Identifies coordinated email attacks:

- **Flood detection** — sudden spike in emails from the same source
- **Content clustering** — similar content from different senders targeting the same inbox
- **Rate anomalies** — unusual sending patterns that indicate automated attacks

### Adaptive Sender Reputation

Sender reputations aren't static — they evolve based on ongoing behavior:

- A new sender starts with a neutral reputation
- Consistent clean sending builds trust over time
- Spam or phishing from a sender degrades their reputation progressively
- A sender who improves sees relaxed filtering

---

## What You Get in the Webhook Payload

Every webhook delivery includes security metadata:

```json
{
  "security": {
    "spam": {
      "checked": true,
      "score": 0.15,
      "action": "pass",
      "flagged": false
    },
    "prompt_injection": {
      "checked": true,
      "detected": false,
      "risk_level": "low",
      "confidence": 0.92
    }
  }
}
```

---

## For Developers

- **Zero configuration** — all detection layers run on every inbound email automatically
- **Metadata-rich** — your app receives detailed scores and flags, not just pass/fail
- **Tunable responses** — the spam score and action tell you exactly what was detected and how the system responded
- **Never blocks legitimate mail** — the system errs on the side of flagging over rejecting for borderline cases

## For AI Agents

- Agents processing inbound email get risk context **before** acting on the content
- The spam score lets agents prioritize clean emails and deprioritize suspicious ones
- Phishing detection prevents agents from following malicious links embedded in emails
- Agents can use the security metadata to route emails differently — e.g., flag suspicious emails for human review instead of auto-responding
