# Continue with Commune — Internal Documentation

## Overview

"Continue with Commune" is Commune's OAuth identity provider system. Commune acts as the identity authority for AI agents — the same role Google plays for "Sign in with Google", but for agents instead of humans.

An integrator (any SaaS product) embeds "Continue with Commune" into their product. When an agent authenticates, the integrator receives a verified identity payload: who the agent is, who operates it, how trustworthy it is, and its email reputation.

---

## Architecture

### System Components

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│   Integrator's   │        │    Commune API   │        │  Agent's Commune │
│     Product      │───────▶│   /oauth/*       │───────▶│     Inbox        │
│  (client_id +    │        │                  │        │                  │
│   client_secret) │◀───────│  Identity Layer  │        │  Reads OTP code  │
└──────────────────┘        └──────────────────┘        └──────────────────┘
         │                           │
         │                    ┌──────┴──────┐
         │                    │  MongoDB    │
         │                    │  - oauth_clients
         │                    │  - oauth_codes
         │                    │  - oauth_tokens
         │                    │  - oauth_refresh_tokens
         │                    │  - agent_identities
         │                    │  - organizations
         │                    │  - messages
         │                    └─────────────┘
         │
         ▼
   Agent authenticates
   on integrator's product
```

### Data Flow

```
1. REGISTRATION (one-time, via dashboard or API key auth)
   Integrator → POST /oauth/clients → receives client_id + client_secret (shown once)

2. AUTHENTICATION (per agent sign-in)
   Integrator → POST /oauth/send-code {email} → Commune sends 6-digit OTP to agent inbox
   Agent reads OTP from inbox (via Commune API or any email client)
   Integrator → POST /oauth/verify-code {request_id, code} → receives:
     - access_token (1h TTL, comm_oauth_xxx)
     - refresh_token (30d TTL, comm_refresh_xxx)
     - id_token (signed JWT with agent claims)
     - agent_id (stable identifier — key your DB on this)

3. ONGOING USE
   Integrator → GET /oauth/agentinfo (Bearer access_token) → fresh agent claims
   Integrator → POST /oauth/token (grant_type=refresh_token) → new access_token + rotated refresh_token

4. REVOCATION
   Integrator → POST /oauth/revoke {token} → invalidates access or refresh token
```

---

## File Map

| File | Purpose |
|------|---------|
| `routes/oauth/index.ts` | HTTP layer — request parsing, rate limiting, error mapping |
| `services/oauthService.ts` | Business logic — domain validation, OTP flow, token issuance, trust scoring |
| `stores/oauthClientStore.ts` | Integrator registrations (client_id/client_secret) |
| `stores/oauthCodeStore.ts` | OTP codes — creation, rate limiting, atomic single-use consumption |
| `stores/oauthTokenStore.ts` | Access tokens — creation, validation, revocation |
| `stores/oauthRefreshTokenStore.ts` | Refresh tokens — creation, rotation, revocation |
| `types/auth.ts` | `AgentIdentity`, `AgentSignup` types with optional profile fields |

---

## Security Design

### Secret Storage

Every secret (client_secret, OTP codes, access tokens, refresh tokens) follows the same pattern:

1. **Generated** as `comm_<type>_` + `crypto.randomBytes(N).toString('hex')`
2. **HMAC-SHA256 hashed** using the global `API_KEY_HMAC_SECRET` before storage
3. **Prefix stored** separately for fast DB lookup (`clientSecretPrefix`, `tokenPrefix`)
4. **Plain text returned once** to the caller, then discarded server-side
5. **Timing-safe comparison** (`crypto.timingSafeEqual`) used for all secret verification

Why HMAC over bcrypt: all these secrets are high-entropy random strings (not user passwords). HMAC is constant-time, doesn't need salt, and is orders of magnitude faster — important for per-request token validation. The same `API_KEY_HMAC_SECRET` used for API key hashing is reused here.

### Token Formats and Lifetimes

| Token | Format | TTL | Storage |
|-------|--------|-----|---------|
| `client_secret` | `comm_secret_<64hex>` | Permanent | HMAC hash in `oauth_clients` |
| OTP code | 6-digit numeric | 10 min | HMAC hash in `oauth_codes`, TTL index |
| `access_token` | `comm_oauth_<64hex>` | 1 hour | HMAC hash in `oauth_tokens`, TTL index |
| `refresh_token` | `comm_refresh_<64hex>` | 30 days | HMAC hash in `oauth_refresh_tokens`, TTL index |
| `id_token` | Signed JWT (HS256) | 1 hour | Not stored — stateless, verified by signature |

### OTP Security

- **Rate limited**: max 3 sends per (email, clientId) pair per 15 minutes (Redis-backed, MongoDB fallback)
- **Single-use**: atomic `findOneAndUpdate` with `used: false` guard — two concurrent verify attempts cannot both succeed
- **TTL cleanup**: MongoDB TTL index on `expiresAt` auto-deletes expired codes

### Refresh Token Rotation

Every time a refresh token is used, it is revoked and replaced with a new one. The old token's `replacedByToken` field points to the new one. This means:

- A stolen refresh token can only be used once
- If the legitimate client and attacker both try to use the same token, one will fail
- `revokeAllForAgent(agentId, clientId)` revokes the entire chain

### Domain Validation

Requests to `send-code` and `verify-code` are validated against the integrator's registered `websiteUrl`:

| Scenario | Result |
|----------|--------|
| No `Origin`/`Referer` header (server-to-server) | **Allowed** — authenticated via client_secret |
| `Origin` is `localhost` / `127.0.0.1` / `::1` | **Allowed** — dev mode |
| `Origin` matches registered `websiteUrl` domain | **Allowed** |
| `Origin` is a subdomain of `websiteUrl` | **Allowed** — `app.example.com` passes for `example.com` |
| `Origin` is a different domain | **Rejected** with `ORIGIN_NOT_ALLOWED` |
| No `websiteUrl` registered | **Allowed** — no constraint to enforce |

This replaces the traditional OAuth `redirect_uri` validation. Since agents don't use browsers, there's no redirect — domain validation on the Origin header serves the same purpose.

### id_token (Signed JWT)

Mirrors Google's id_token convention. Signed with `JWT_SECRET` (HS256). Contains:

```json
{
  "iss": "https://commune.dev",
  "sub": "agt_xxx",           // stable agent ID
  "aud": "comm_client_xxx",   // the integrator's client_id
  "iat": 1710000000,
  "exp": 1710003600,
  "email": "acme@commune.email",
  "email_verified": true,
  "name": "Acme Support Agent",
  "commune:entity_type": "agent",
  "commune:verified_agent": true,
  "commune:trust_level": "established",
  "commune:trust_score": 65,
  "commune:org_id": "org_xxx",
  "commune:org_tier": "agent_pro"
}
```

Integrators can verify this locally (if they have the signing key shared out-of-band) or simply trust the API response from `verify-code` and `agentinfo` endpoints.

---

## Trust Score System

Trust is computed from observable signals that Commune uniquely has — inbox age and email activity:

### Score Computation (0–100)

| Signal | Points |
|--------|--------|
| Account age ≥ 1 day | +10 |
| Account age ≥ 7 days | +10 |
| Account age ≥ 30 days | +15 |
| ≥ 1 email sent | +10 |
| ≥ 10 emails sent | +10 |
| ≥ 50 emails sent | +10 |
| ≥ 200 emails sent | +10 |
| Active inbox (age ≥ 1d OR sends > 0) | +15 |

### Score → Trust Level

| Score Range | Level |
|-------------|-------|
| 0–24 | `new` |
| 25–49 | `provisional` |
| 50–74 | `established` |
| 75–100 | `trusted` |

### Trust Signals (machine-readable)

Every agent always has: `key_pair_verified`, `contextual_challenge_passed`.
Additional signals accumulate: `inbox_age_1d`, `inbox_age_7d`, `inbox_age_30d`, `inbox_activity_moderate` (≥10 sends), `inbox_activity_high` (≥50 sends).

### Email Reputation

Derived from the same trust score. Grade mapping: A (≥80), B (≥65), C (≥50), D (≥30), F (<30). `spam_agent` flag is `true` when score < 20.

---

## AgentInfo Payload

The full identity payload returned to integrators via `GET /oauth/agentinfo` and inline in `POST /oauth/verify-code`:

```typescript
{
  // OIDC standard (mirrors Google)
  sub: string;                   // stable agent ID — never changes
  email: string;                 // agent's Commune inbox
  email_verified: true;          // always true — Commune owns the inbox
  name: string;                  // display name

  // Commune-specific
  entity_type: 'agent';
  verified_agent: true;          // passed Ed25519 + contextual challenge at registration
  purpose: string;               // agent's stated purpose
  registered_at: string;         // ISO 8601
  account_age_days: number;
  last_active_at: string | null;

  // Operator
  org_id: string;
  org_name: string;
  org_slug: string;
  org_tier: string;              // free | agent_pro | business | enterprise

  // Email reputation (Commune's unique signal)
  email_reputation: {
    score: number;               // 0–100
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    spam_agent: boolean;
    sends_last_30d: number;
    domain_name: string;
    domain_verified: boolean;
  };

  // Trust
  trust_level: TrustLevel;
  trust_score: number;
  trust_signals: string[];

  // Social
  moltbook_connected: boolean;
  moltbook_handle?: string;      // only if agent provided at registration

  // Optional profile (only present if agent provided at registration)
  avatar_url?: string;
  website_url?: string;
  capabilities?: string[];
}
```

### Optional Fields

Fields like `avatar_url`, `website_url`, `moltbook_handle`, and `capabilities` are provided by the agent at registration time (via `POST /v1/auth/agent-register`). They are optional — if not set, they are omitted entirely from the agentinfo response (no null noise).

`moltbook_connected` is derived from whether `moltbookHandle` exists on the `AgentIdentity` record. It was previously hardcoded to `false`.

---

## Rate Limiting

| Endpoint | Limit | Scope |
|----------|-------|-------|
| `POST /oauth/clients` | 10/hour | Per IP |
| `POST /oauth/send-code` | 20/15min | Per IP |
| `POST /oauth/send-code` | 3/15min | Per (email, clientId) — in OAuthCodeStore |
| `POST /oauth/verify-code` | 10/15min | Per IP |
| `POST /oauth/token` | No IP limit | Authenticated via client_secret |
| `GET /oauth/agentinfo` | No IP limit | Authenticated via access_token |

---

## MongoDB Collections and Indexes

### `oauth_clients`
- `clientId: 1` (unique)
- `orgId: 1`
- `clientSecretPrefix: 1`
- `status: 1`

### `oauth_codes`
- `requestId: 1` (unique)
- `expiresAt: 1` (TTL, expireAfterSeconds: 0)
- `agentEmail: 1, clientId: 1, createdAt: -1` (rate limiting lookups)

### `oauth_tokens`
- `tokenPrefix: 1`
- `agentId: 1, clientId: 1`
- `expiresAt: 1` (TTL, expireAfterSeconds: 0)

### `oauth_refresh_tokens`
- `tokenPrefix: 1`
- `agentId: 1, clientId: 1`
- `expiresAt: 1` (TTL, expireAfterSeconds: 0)

---

## Design Decisions

### Why OTP instead of OAuth authorization code?

Standard OAuth requires a browser redirect for the authorization code grant. Agents don't have browsers. The OTP replaces the "click Approve" step — the agent proves inbox ownership by reading the code from their Commune inbox, which is equivalent to the consent screen.

### Why not re-verify Ed25519 at OAuth time?

The Ed25519 challenge-response happens once at Commune registration. It proves the agent is a real LLM (contextual reasoning challenge). At OAuth time, we just need to confirm the agent controls their inbox — a simpler OTP suffices. The `verified_agent: true` flag carries forward from registration.

### Why HMAC-SHA256 instead of bcrypt?

All secrets in the OAuth system are high-entropy random strings (32–64 bytes of randomness). Bcrypt's computational cost is designed to slow down brute-forcing of low-entropy passwords — unnecessary here. HMAC is O(1) and uses the existing `API_KEY_HMAC_SECRET`, keeping the security model consistent with API key auth.

### Why refresh token rotation?

If a refresh token is intercepted, the attacker can mint access tokens indefinitely. Rotation ensures each refresh token is single-use. If both the legitimate client and attacker try to use the same token, one will fail — alerting to compromise.

### Why domain validation instead of redirect_uri?

Traditional OAuth validates `redirect_uri` to prevent authorization code interception. Since there's no browser redirect in this flow, we validate the `Origin`/`Referer` header against the registered `websiteUrl` instead. Server-to-server calls (no Origin) pass through because they're authenticated via `client_secret`.

### Why separate access_token and id_token?

Following Google's convention. The `id_token` is a signed JWT that can be verified locally by the integrator. The `access_token` is an opaque string validated server-side via `GET /oauth/agentinfo`. This separation lets integrators choose their verification strategy.
