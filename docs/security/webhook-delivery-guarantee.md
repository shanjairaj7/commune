# Webhook Delivery Guarantee

## What It Does

Every inbound email that hits your Commune inbox triggers a webhook to your endpoint. The webhook delivery guarantee ensures that **no webhook is ever lost** — even if your endpoint is temporarily down, slow, or returning errors.

Instead of a single fire-and-forget HTTP call, Commune persists every delivery to a durable queue, attempts immediate inline delivery for speed, and automatically retries with exponential backoff if the first attempt fails. After all retries are exhausted, the webhook enters a dead letter queue where it's preserved for 30 days and can be manually replayed via API.

---

## How It Works

```
Inbound Email Received
        │
        ▼
  Persist to delivery log (MongoDB)
        │
        ▼
  Attempt immediate delivery ──── Success ──── ✅ Delivered
        │                                       (zero queue delay)
        │ (failure)
        ▼
  Schedule retry with backoff
        │
        ▼
  Retry Worker picks up ──── Success ──── ✅ Delivered
        │
        │ (max retries exhausted)
        ▼
  Dead Letter Queue
  (preserved 30 days, replayable via API)
```

### Retry Schedule

8 attempts over approximately 8 hours with exponential backoff and jitter:

| Attempt | Delay After Failure |
|---------|-------------------|
| 1 | Immediate (inline) |
| 2 | ~5 seconds |
| 3 | ~30 seconds |
| 4 | ~2 minutes |
| 5 | ~10 minutes |
| 6 | ~30 minutes |
| 7 | ~1 hour |
| 8 | ~2 hours |

Jitter (±25%) is applied to each delay to prevent retry storms when multiple deliveries fail simultaneously.

### Circuit Breaker

If your endpoint fails **5 consecutive times**, the circuit breaker opens for 5 minutes. During this cooldown, deliveries are queued but not attempted — preventing your endpoint from being hammered while it's recovering. After cooldown, a single test delivery is attempted (half-open state). If it succeeds, normal delivery resumes.

### Dead Letter Queue

Webhooks that exhaust all retry attempts are moved to the dead letter queue with their full payload preserved. Dead letters are retained for 30 days and can be:
- Listed via `GET /v1/webhooks/deliveries?status=dead`
- Inspected via `GET /v1/webhooks/deliveries/:deliveryId`
- Replayed via `POST /v1/webhooks/deliveries/:deliveryId/retry`

---

## Webhook Headers

Every webhook delivery includes these headers:

| Header | Description |
|--------|------------|
| `x-commune-delivery-id` | Unique delivery ID for end-to-end tracking (format: `whd_...`) |
| `x-commune-timestamp` | Unix timestamp (ms) of the delivery attempt |
| `x-commune-attempt` | Attempt number (1 = first try, 2+ = retries) |
| `x-commune-signature` | HMAC-SHA256 signature for payload verification (if webhook secret configured) |

---

## API Endpoints

All endpoints require API key authentication.

### List Deliveries

```
GET /v1/webhooks/deliveries
```

Query parameters:
- `inbox_id` — Filter by inbox
- `status` — Filter by status: `pending`, `delivered`, `retrying`, `dead`
- `endpoint` — Filter by endpoint URL
- `limit` — Results per page (default: 50, max: 100)
- `offset` — Pagination offset

Response:
```json
{
  "deliveries": [
    {
      "delivery_id": "whd_a1b2c3d4e5f6g7h8i9j0",
      "inbox_id": "inbox_123",
      "message_id": "msg_456",
      "endpoint": "https://your-app.com/webhook",
      "status": "delivered",
      "attempt_count": 1,
      "max_attempts": 8,
      "created_at": "2025-02-11T14:00:00.000Z",
      "delivered_at": "2025-02-11T14:00:00.150Z",
      "delivery_latency_ms": 150,
      "last_error": null,
      "last_status_code": 200
    }
  ],
  "total": 1
}
```

### Get Delivery Detail

```
GET /v1/webhooks/deliveries/:deliveryId
```

Returns full delivery detail including every attempt with status codes, errors, and latencies.

### Manual Retry

```
POST /v1/webhooks/deliveries/:deliveryId/retry
```

Re-queues a dead or failed delivery for immediate retry. Useful for replaying webhooks after fixing an endpoint issue.

### Endpoint Health

```
GET /v1/webhooks/health
```

Returns per-endpoint health stats for the last 24 hours:
```json
{
  "endpoints": [
    {
      "endpoint": "https://your-app.com/webhook",
      "total": 150,
      "delivered": 148,
      "failed": 1,
      "dead": 1,
      "success_rate": 0.9867,
      "avg_latency_ms": 120
    }
  ],
  "totals": {
    "pending": 0,
    "delivered": 148,
    "retrying": 1,
    "dead": 1
  }
}
```

---

## For Developers

- **No configuration needed** — delivery guarantee is on by default for every inbox with a webhook endpoint
- **Use `x-commune-delivery-id`** to correlate webhook events with delivery status in the API
- **Use `x-commune-attempt`** to detect retries — your endpoint should be idempotent (processing the same webhook twice should be safe)
- **Return 2xx quickly** — Commune waits up to 10 seconds on the first attempt and 30 seconds on retries. Return 200 immediately after accepting the payload, then process asynchronously
- **Monitor endpoint health** via `GET /v1/webhooks/health` to catch issues before they escalate

## For AI Agents

- **No missed emails** — even if your agent's server restarts or has brief downtime, webhooks are retried automatically
- **Dead letter replay** — if your agent was offline for an extended period, replay dead letters to catch up on missed emails
- **Delivery tracking** — query the delivery API to confirm your agent received every webhook and diagnose any delivery issues
- **Built-in idempotency signals** — the `x-commune-delivery-id` and `x-commune-attempt` headers let your agent safely handle duplicate deliveries

---

## Configuration (Optional)

All settings have sensible defaults. Override via environment variables if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_MAX_ATTEMPTS` | 8 | Maximum delivery attempts before dead letter |
| `WEBHOOK_FIRST_TIMEOUT_MS` | 10000 | Timeout for first inline attempt (ms) |
| `WEBHOOK_RETRY_TIMEOUT_MS` | 30000 | Timeout for retry attempts (ms) |
| `WEBHOOK_RETRY_INTERVAL_MS` | 5000 | Retry worker polling interval (ms) |
| `WEBHOOK_RETRY_BATCH_SIZE` | 20 | Deliveries processed per retry worker tick |
| `WEBHOOK_CB_THRESHOLD` | 5 | Consecutive failures before circuit breaker opens |
| `WEBHOOK_CB_COOLDOWN_MS` | 300000 | Circuit breaker cooldown period (ms) |
