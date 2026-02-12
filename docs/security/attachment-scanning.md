# Attachment Scanning

## What It Does

Every inbound email attachment passes through multiple independent security layers before being stored or forwarded to your application. Dangerous file types are blocked outright. Files that disguise their true type are identified through deep inspection. Known malware signatures are matched. Full antivirus scanning provides the final layer, with intelligent fallback if the primary scanner is unavailable.

---

## Scanning Layers

### 1. File Type Blocking

High-risk file types are blocked regardless of content:
- Executables (`.exe`, `.bat`, `.cmd`, `.com`, `.scr`, `.pif`)
- Scripts (`.js`, `.vbs`, `.wsf`, `.ps1`, `.sh`)
- Other dangerous formats (`.dll`, `.sys`, `.msi`, `.reg`)

Blocked attachments are quarantined — the email is still delivered, but the dangerous attachment is stripped and replaced with a quarantine notice in the metadata.

### 2. Magic Byte Inspection

Files can be renamed to bypass extension-based blocking (e.g., an `.exe` renamed to `.pdf`). Magic byte inspection reads the actual binary header of the file to determine its true type, regardless of the file extension.

If the true type doesn't match the claimed extension, or if the true type is a blocked format, the attachment is quarantined.

### 3. Known Threat Hash Database

Every attachment is hashed and checked against a database of known malware signatures. This catches files that are known threats even if they use an allowed file type.

### 4. ClamAV Antivirus Scanning

When a ClamAV daemon is available, every attachment undergoes full antivirus scanning via TCP stream. This catches threats that the other layers might miss — polymorphic malware, archive-based attacks, and novel threats covered by ClamAV's signature database.

**Intelligent fallback**: If ClamAV is unavailable (not configured or temporarily down), the system falls back to heuristic scanning rather than letting attachments through unchecked. The other three layers continue to provide protection.

---

## What You Get in the Webhook Payload

Attachment metadata in your webhook includes scan results:

```json
{
  "attachments": [
    {
      "attachment_id": "att_abc123",
      "filename": "report.pdf",
      "mime_type": "application/pdf",
      "size": 245760
    }
  ]
}
```

Quarantined attachments are excluded from the webhook payload. If an attachment was quarantined, the email's metadata includes a quarantine notice so your application knows an attachment was removed and why.

---

## For Developers

- **Zero configuration** — all scanning layers run on every inbound attachment automatically
- **Defense in depth** — four independent layers mean a threat must bypass all of them
- **Never skips a check** — if one layer is unavailable, others continue protecting
- **Non-blocking for clean files** — scanning adds minimal latency for legitimate attachments
- **Quarantine, not reject** — the email still delivers; only the dangerous attachment is stripped

## For AI Agents

- Agents processing inbound email don't need to worry about malicious attachments
- Safe to download and process any attachment that passes scanning — PDFs, images, CSVs, etc.
- If an attachment was quarantined, the agent can inform the sender or escalate to human review
- Attachment IDs in the webhook payload can be used to download files via the attachments API

---

## Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAMAV_HOST` | — | ClamAV daemon hostname (if not set, heuristic scanning only) |
| `CLAMAV_PORT` | 3310 | ClamAV daemon port |
