# Domain Warmup Engine

## What It Does

When you connect a new domain, it has zero sending history with inbox providers. Sending a large volume immediately is one of the strongest spam signals an ISP can see. Commune enforces a **graduated sending schedule** for new domains, ramping up volume over a 14-day period to build your reputation naturally and safely.

---

## How It Works

```
Day 1          Day 7          Day 14         Day 15+
  │              │              │              │
  ▼              ▼              ▼              ▼
 Low            Medium         High           Full
 volume         volume         volume         capacity
 (conservative  (building      (near full     (graduated,
  daily limit)   trust)         capacity)      no limits)
```

### Warmup Schedule

New domains follow a 14-day graduated schedule where daily sending limits increase steadily. The exact limits ramp from conservative (tens of emails) on day 1 to full capacity by day 14.

- **Limits are enforced at the infrastructure level** — your API calls are rejected (with clear error messages) once the daily limit is reached, so you can't accidentally over-send
- **API responses include remaining daily capacity** — your app can plan campaigns around available sends
- **Existing domains** that predate the warmup system are unaffected and have full capacity immediately

### What Happens When the Limit Is Reached

The API returns a clear error with the daily limit, current usage, and when the limit resets. Your application can retry the next day or spread sends across the warmup period.

---

## Why This Matters

ISPs like Gmail, Yahoo, and Outlook track sender reputation per domain. A brand-new domain sending thousands of emails on day one looks identical to a spammer. Even if the content is legitimate, the volume pattern triggers filtering.

The warmup engine ensures your domain builds trust the way ISPs expect — gradually, with consistent volume growth and healthy engagement signals.

---

## For Developers

- **Automatic** — warmup starts when you connect a new domain, no configuration needed
- **Transparent** — API responses include remaining capacity so your app can plan sends
- **Safe** — over-sending is blocked at the infrastructure level, not just warned
- **Admin bypass** — if you've pre-warmed a domain through another provider, an admin can skip the warmup

## For AI Agents

- Agents can't accidentally burn a fresh domain's reputation by sending a large batch
- The daily capacity in API responses lets agents schedule outreach across the warmup period
- After warmup completes, the agent has a clean, trusted domain ready for full-volume sending
- Combined with the reputation autopilot, this creates a completely safe ramp from zero to full sending
