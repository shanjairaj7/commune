/**
 * Security Headers Middleware
 * 
 * Applies standard security headers to all responses:
 * - Helmet for baseline headers (X-Content-Type-Options, X-Frame-Options, etc.)
 * - HSTS for HTTPS enforcement
 * - Request ID for correlation
 * - Remove X-Powered-By to reduce fingerprinting
 */
import helmet from 'helmet';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Helmet middleware with sensible defaults for an API server.
 */
export const securityHeaders = helmet({
  // Prevent MIME sniffing
  xContentTypeOptions: true,
  // Prevent clickjacking
  xFrameOptions: { action: 'deny' },
  // Disable DNS prefetching
  xDnsPrefetchControl: { allow: false },
  // Hide X-Powered-By
  xPoweredBy: false,
  // HSTS: enforce HTTPS for 1 year including subdomains
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Don't send referrer on navigation
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // CSP — relaxed for API server (no HTML served except unsubscribe page)
  contentSecurityPolicy: false,
});

/**
 * Request ID middleware — attaches a unique ID to every request for tracing.
 * Uses client-provided X-Request-ID if present (for distributed tracing),
 * otherwise generates a new UUID.
 */
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  const existing = req.headers['x-request-id'];
  const id = (typeof existing === 'string' && existing.length <= 128)
    ? existing
    : crypto.randomUUID();
  
  (req as any).requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
};

/**
 * Additional hardening headers not covered by Helmet.
 */
export const extraSecurityHeaders = (_req: Request, res: Response, next: NextFunction) => {
  // Prevent caching of API responses containing sensitive data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Permissions Policy — disable browser features we don't use
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  
  next();
};
