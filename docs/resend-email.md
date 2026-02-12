# Resend Email Setup (Inbound + Outbound)

## Domain and DNS
- Add a domain in Resend (recommended: subdomain like agents.example.com).
- Resend will provide DNS records for DKIM/SPF and (if Receiving is enabled) an MX record.
- Receiving accepts any address at the domain; route using the `to` field.

From Resend docs:
- Webhooks do not include full HTML/text; fetch via the Receiving API.
- Webhooks are signed (Svix headers) and must be verified with the raw body.

## Inbound Flow
1) Enable Receiving on the domain/subdomain.
2) Create a webhook for `email.received`.
3) Point it to `POST /webhooks/resend/:domainId`.

## Outbound Flow
- Once a domain is verified, you can send from any address at that domain.
- Use `POST /api/email/send` with `from` or `domainId` + `localPart`.

## Config
- Domain records and webhook secrets are stored in `config/domains.json`.
- Inbound emails are stored in MongoDB (`received_emails` collection).

## API Endpoints
### Create domain
`POST /api/domains`
```json
{
  "name": "agents.example.com",
  "region": "us-east-1",
  "capabilities": {
    "sending": "enabled",
    "receiving": "enabled"
  },
  "createWebhook": true
}
```

### Verify domain
`POST /api/domains/:domainId/verify`

### Get domain records
`GET /api/domains/:domainId/records`

### Domain status
`GET /api/domains/:domainId/status`

### Create inbound webhook
`POST /api/domains/:domainId/webhook`
```json
{
  "endpoint": "https://your-server.example.com/webhooks/resend/<domainId>",
  "events": ["email.received"]
}
```

### Store webhook secret (if created in dashboard)
`POST /api/domains/:domainId/webhook/secret`
```json
{
  "secret": "whsec_xxxxxxxxx"
}
```

### Send email
`POST /api/email/send`
```json
{
  "domainId": "d_xxxxxxxx",
  "localPart": "agent",
  "to": "user@example.com",
  "subject": "Update",
  "html": "<p>It works</p>",
  "text": "It works"
}
```
