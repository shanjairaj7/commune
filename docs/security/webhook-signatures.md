# Webhook Signature Verification

## What It Does

Every webhook Commune sends to your endpoint is signed with an HMAC-SHA256 signature. This lets your application cryptographically verify that:

1. **The webhook came from Commune** — not a malicious third party
2. **The payload wasn't tampered with** — the body you received is exactly what Commune sent

---

## How It Works

When you configure a webhook on your inbox, Commune generates a shared secret. On every delivery, Commune:

1. Serializes the payload as JSON
2. Concatenates the timestamp and body: `{timestamp}.{body}`
3. Signs it with HMAC-SHA256 using your webhook secret
4. Sends the signature in the `x-commune-signature` header

```
Signature = HMAC-SHA256(secret, "{timestamp}.{body}")
Header:    x-commune-signature: v1={hex_digest}
```

---

## Headers Sent

| Header | Example | Description |
|--------|---------|-------------|
| `x-commune-signature` | `v1=5a3f2b...` | HMAC-SHA256 signature of `{timestamp}.{body}` |
| `x-commune-timestamp` | `1707667200000` | Unix timestamp (ms) when the webhook was signed |
| `x-commune-delivery-id` | `whd_a1b2c3...` | Unique delivery ID for tracking |
| `x-commune-attempt` | `1` | Attempt number (1 = first try) |

---

## Verification Examples

### Node.js

```javascript
const crypto = require('crypto');

function verifyWebhook(req, secret) {
  const signature = req.headers['x-commune-signature'];
  const timestamp = req.headers['x-commune-timestamp'];
  const body = JSON.stringify(req.body); // or raw body string

  if (!signature || !timestamp) return false;

  // Prevent replay attacks — reject timestamps older than 5 minutes
  const age = Date.now() - parseInt(timestamp);
  if (age > 5 * 60 * 1000) return false;

  const expected = `v1=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### Python (using the SDK)

```python
from commune import verify_signature, WebhookVerificationError

def handle_webhook(request):
    try:
        verify_signature(
            payload=request.body,
            signature=request.headers["x-commune-signature"],
            secret="whsec_...",
            timestamp=request.headers.get("x-commune-timestamp"),
        )
    except WebhookVerificationError as e:
        return 401, str(e)

    # Signature valid — process the webhook
    ...
```

### Python (manual)

```python
import hmac
import hashlib
import time

def verify_webhook(headers: dict, body: str, secret: str) -> bool:
    signature = headers.get('x-commune-signature', '')
    timestamp = headers.get('x-commune-timestamp', '')

    if not signature or not timestamp:
        return False

    # Prevent replay attacks — timestamp is Unix milliseconds
    age_ms = int(time.time() * 1000) - int(timestamp)
    if age_ms > 5 * 60 * 1000:
        return False

    expected = 'v1=' + hmac.new(
        secret.encode(),
        f'{timestamp}.{body}'.encode(),
        hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(signature, expected)
```

---

## Security Best Practices

- **Always verify signatures** in production — never trust webhook payloads without verification
- **Use `crypto.timingSafeEqual`** (Node.js) or `hmac.compare_digest` (Python) to prevent timing attacks
- **Check the timestamp** — reject webhooks older than 5 minutes to prevent replay attacks
- **Store your webhook secret securely** — use environment variables, not source code
- **Use raw body for verification** — parse the JSON body only after signature verification succeeds

## For AI Agents

- Signature verification ensures an attacker can't send fake emails to your agent's webhook endpoint
- Combined with prompt injection detection, this provides two layers of defense: **authenticity** (is this really from Commune?) and **content safety** (is the email trying to manipulate the agent?)
- The `x-commune-delivery-id` header lets your agent deduplicate retried webhooks by tracking which delivery IDs have already been processed
