# Reputation Autopilot (Circuit Breaker)

## What It Does

Your sender reputation is monitored continuously in real-time. If your bounce rate or complaint rate starts climbing toward the thresholds that inbox providers (Gmail, Yahoo, Outlook) use to trigger spam filtering, Commune **automatically pauses sending** before those providers take action. Once rates recover, sending resumes on its own.

This is a circuit breaker — it trips when things go wrong, and resets when things are healthy again.

---

## How It Works

```
Every Send/Bounce/Complaint Event
        │
        ▼
  Update rolling rate window
        │
        ▼
  Check thresholds ──── Healthy ──── Normal sending continues
        │
        │ (approaching danger zone)
        ▼
  ⚠️ Warning emitted
        │
        │ (threshold crossed)
        ▼
  🛑 Sending PAUSED automatically
        │
        │ (rates recover — bad contacts suppressed)
        ▼
  ✅ Sending RESUMES automatically
```

### Thresholds

The circuit breaker is aligned with the thresholds that major inbox providers enforce:

- **Bounce rate** — if your bounce rate approaches the level where Gmail/Yahoo begin filtering, sending pauses
- **Complaint rate** — if your complaint rate spikes (recipients clicking "Report Spam"), sending pauses

These thresholds are conservative — they trip **before** ISPs take action, giving the system time to suppress the problematic contacts and stabilize your rates.

### What Triggers Recovery

When sending pauses, the bounce and complaint events that triggered the pause also feed into the suppression system. The addresses causing the problems are automatically suppressed. Once those addresses are removed from your sending pool, your rates drop, and the circuit breaker resets.

---

## Why This Matters

Without a circuit breaker, a single bad campaign can cascade:

1. Send to a stale list → high bounce rate
2. ISPs notice → start filtering your emails to spam
3. Recipients don't see your emails → stop engaging
4. Lower engagement → ISPs filter even more aggressively
5. Recovery takes **weeks** of careful sending to rebuild trust

The circuit breaker stops this cascade at step 1. The damage is contained within minutes.

---

## For Developers

- **Fully automatic** — no dashboards to watch, no alerts to configure
- **Early warning** — problems are caught within minutes, not after ISPs have already flagged you
- **Self-healing** — the pause-and-recover cycle requires zero manual intervention
- **API visibility** — query delivery metrics via `GET /v1/delivery/metrics` to see your current health

## For AI Agents

- Agents running automated campaigns are protected from reputation damage caused by list quality issues
- The circuit breaker prevents an agent from burning through a domain's reputation in a single batch
- When the breaker trips, the agent's API calls return clear error codes indicating sending is paused
- Combined with the domain warmup engine, this creates a safe sandbox for agents to send email at scale
