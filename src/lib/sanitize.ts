/**
 * Input sanitization utilities for email header injection prevention.
 * Prevents CRLF injection, null byte injection, and forbidden header overrides.
 */

/**
 * Strip CRLF and null bytes from a string.
 * Prevents header injection attacks where \r\n can inject additional SMTP headers.
 */
export const stripCRLF = (value: string): string => {
  return value.replace(/[\r\n\x00]/g, ' ').trim();
};

/**
 * Sanitize an email header value.
 * Strips CRLF, null bytes, and limits length per RFC 5322 (max 998 chars per line).
 */
export const sanitizeHeaderValue = (value: string, maxLength = 998): string => {
  return stripCRLF(value).slice(0, maxLength);
};

/**
 * Headers that users must never override — they control routing, authentication,
 * and trust signals. Allowing them would enable spoofing and delivery manipulation.
 */
const FORBIDDEN_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'sender',
  'return-path',
  'delivered-to',
  'received',
  'dkim-signature',
  'authentication-results',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
  'x-google-dkim-signature',
  'list-unsubscribe',       // managed by our unsubscribe system
  'list-unsubscribe-post',  // managed by our unsubscribe system
]);

/**
 * Sanitize a map of custom headers provided by API consumers.
 * - Removes forbidden routing/auth headers
 * - Strips CRLF from keys and values
 * - Enforces RFC 5322 line length
 */
export const sanitizeCustomHeaders = (headers: Record<string, string>): Record<string, string> => {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (FORBIDDEN_HEADERS.has(lowerKey)) continue;

    const cleanKey = stripCRLF(key);
    const cleanValue = sanitizeHeaderValue(value);

    if (cleanKey && cleanValue) {
      sanitized[cleanKey] = cleanValue;
    }
  }

  return sanitized;
};

/**
 * Validate that an email address is clean of injection patterns.
 * This is a secondary check beyond Zod's .email() — catches edge cases
 * like angle bracket injection and header splitting.
 */
export const isCleanEmailAddress = (email: string): boolean => {
  if (/[\r\n]/.test(email)) return false;
  if (/\x00/.test(email)) return false;
  if (/<|>/.test(email) && !email.match(/^[^<]*<[^>]+>$/)) return false;
  if (/;/.test(email)) return false;
  if (email.length > 254) return false;
  return true;
};

/**
 * Sanitize an error message for production responses.
 * Redacts MongoDB connection strings, file system paths, and internal details.
 */
export const sanitizeErrorMessage = (message: string): string => {
  let clean = message;
  clean = clean.replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, '[redacted]');
  clean = clean.replace(/redis:\/\/[^\s]+/gi, '[redacted]');
  clean = clean.replace(/\/Users\/[^\s]+/g, '[redacted]');
  clean = clean.replace(/\/home\/[^\s]+/g, '[redacted]');
  clean = clean.replace(/\/app\/[^\s]+/g, '[redacted]');
  clean = clean.replace(/[A-Za-z]:\\[^\s]+/g, '[redacted]');
  clean = clean.replace(/password[=:]\s*\S+/gi, 'password=[redacted]');
  clean = clean.replace(/secret[=:]\s*\S+/gi, 'secret=[redacted]');
  clean = clean.replace(/token[=:]\s*\S+/gi, 'token=[redacted]');
  return clean;
};
