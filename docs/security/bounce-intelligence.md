# Bounce Intelligence

## What It Does

Every bounce event is classified in real-time as either a **hard bounce** (permanent failure) or a **soft bounce** (temporary failure), and the correct suppression action is taken automatically. This prevents you from repeatedly sending to dead addresses while ensuring temporary issues don't permanently block good contacts.

---

## How It Works

### Hard Bounces (Permanent)

Causes: mailbox doesn't exist, domain doesn't exist, address rejected permanently.

**Action**: The address is **immediately and permanently suppressed**. No email will ever be sent to it again through your account. This is critical — ISPs treat repeated sends to non-existent addresses as a strong spam signal.

### Soft Bounces (Temporary)

Causes: mailbox full, server temporarily unavailable, rate limited by receiver, message too large.

**Action**: A consecutive failure counter is incremented. The address is **only suppressed after reaching the threshold** (default: 3 consecutive soft bounces). Suppression is **temporary** (default: 7 days) — after expiry, the address is automatically reinstated.

### Self-Healing

When a previously soft-bounced address accepts a delivery successfully, the soft bounce counter is **reset to zero**. The system recognizes recovery and removes restrictions automatically. No manual intervention needed.

```
Soft Bounce Event
      │
      ▼
  Increment counter ──── Counter < Threshold ──── No action
      │                                            (keep sending)
      │ Counter >= Threshold
      ▼
  Temporary suppression (7 days)
      │
      │ (after 7 days, or successful delivery)
      ▼
  Counter reset, address reinstated
```

---

## What This Means

| Scenario | What Happens |
|----------|-------------|
| Send to nonexistent address | Hard bounce → permanently suppressed |
| Recipient mailbox is full | Soft bounce → counter incremented, still sendable |
| Mailbox full 3 times in a row | Threshold reached → temporarily suppressed for 7 days |
| Suppressed address starts working | Successful delivery → counter reset, fully reinstated |
| Previously bounced address in a batch | Automatically excluded from send, other recipients still receive |

---

## For Developers

- **Zero manual work** — all classification and suppression decisions are automatic
- **Per-send visibility** — the API response shows which addresses were suppressed
- **No permanent damage from temporary issues** — soft bounce suppression expires automatically
- **Feedback loop** — bounce data feeds into the reputation autopilot circuit breaker

## For AI Agents

- Agents running outreach campaigns don't need to maintain their own bounce lists
- Temporary suppression means agents won't waste sends on temporarily unreachable contacts
- Self-healing means agents don't permanently lose valid contacts due to a brief server issue
- The suppression API (`GET /v1/delivery/suppressions`) lets agents query their suppression list programmatically

---

## Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SOFT_BOUNCE_THRESHOLD` | 3 | Consecutive soft bounces before temporary suppression |
| `SOFT_BOUNCE_SUPPRESSION_DAYS` | 7 | Days before a soft-bounce suppression expires |
