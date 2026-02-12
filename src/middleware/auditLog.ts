/**
 * Audit Logging Middleware
 * 
 * Logs all authenticated API requests with:
 * - Who (user ID, org ID, auth type)
 * - What (method, path, resource type)
 * - When (timestamp)
 * - How (IP, user agent, request ID)
 * 
 * Stored in MongoDB `audit_logs` collection with TTL auto-expiry.
 */
import { Request, Response, NextFunction } from 'express';
import { getCollection } from '../db';
import logger from '../utils/logger';

export interface AuditLogEntry {
  timestamp: string;
  requestId?: string;
  method: string;
  path: string;
  statusCode?: number;
  userId?: string;
  orgId?: string;
  authType?: 'jwt' | 'apikey';
  apiKeyId?: string;
  ip: string;
  userAgent?: string;
  resourceType?: string;
  resourceId?: string;
  durationMs?: number;
}

const AUDIT_COLLECTION = 'audit_logs';
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 90);

// Paths that are sensitive and should always be logged
const SENSITIVE_PATHS = [
  '/v1/messages',
  '/v1/threads',
  '/v1/attachments',
  '/v1/inboxes',
  '/v1/domains',
  '/v1/webhooks',
  '/v1/search',
  '/api/messages',
  '/api/threads',
  '/api/domains',
  '/api/inboxes',
  '/api/admin',
  '/api/api-keys',
  '/auth/me',
];

// Paths to skip (health checks, static assets)
const SKIP_PATHS = ['/health', '/healthz', '/favicon.ico'];

/**
 * Determine the resource type from the request path.
 */
const inferResourceType = (path: string): string | undefined => {
  if (path.includes('/messages')) return 'message';
  if (path.includes('/threads')) return 'thread';
  if (path.includes('/attachments')) return 'attachment';
  if (path.includes('/inboxes')) return 'inbox';
  if (path.includes('/domains')) return 'domain';
  if (path.includes('/webhooks')) return 'webhook';
  if (path.includes('/api-keys')) return 'api_key';
  if (path.includes('/search')) return 'search';
  if (path.includes('/admin')) return 'admin';
  if (path.includes('/auth')) return 'auth';
  return undefined;
};

/**
 * Extract resource ID from common URL patterns.
 */
const inferResourceId = (path: string): string | undefined => {
  // Match patterns like /v1/threads/:id, /v1/messages/:id, etc.
  const segments = path.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const next = segments[i + 1];
    if (next && (next.startsWith('thread_') || next.startsWith('msg_') || next.startsWith('att_') || next.startsWith('inbox_') || next.startsWith('dom_') || next.startsWith('whd_'))) {
      return next;
    }
  }
  return undefined;
};

export const ensureAuditIndexes = async () => {
  const col = await getCollection<AuditLogEntry>(AUDIT_COLLECTION);
  if (!col) return;

  await col.createIndex({ timestamp: -1 });
  await col.createIndex({ orgId: 1, timestamp: -1 });
  await col.createIndex({ userId: 1, timestamp: -1 });
  await col.createIndex({ resourceType: 1, timestamp: -1 });
  // Auto-expire audit logs after retention period
  await col.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 60 * 60 }
  );
};

/**
 * Audit logging middleware.
 * Captures request details on response finish.
 */
export const auditLog = (req: Request, res: Response, next: NextFunction) => {
  // Skip non-sensitive paths
  if (SKIP_PATHS.some(p => req.path === p)) {
    return next();
  }

  const startTime = Date.now();

  // Hook into response finish to capture status code
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const authReq = req as any;
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      requestId: authReq.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      userId: authReq.user?.id,
      orgId: authReq.orgId,
      authType: authReq.authType,
      apiKeyId: authReq.apiKeyData?.id,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent']?.substring(0, 256),
      resourceType: inferResourceType(req.path),
      resourceId: inferResourceId(req.path),
      durationMs: Date.now() - startTime,
    };

    // Only log sensitive paths or write operations to reduce noise
    const isSensitive = SENSITIVE_PATHS.some(p => req.path.startsWith(p));
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    
    if (isSensitive || isWrite) {
      // Fire-and-forget — don't block the response
      writeAuditLog(entry).catch(err => {
        logger.error('Failed to write audit log', { error: err });
      });
    }

    return originalEnd.apply(res, args as any);
  } as any;

  next();
};

const writeAuditLog = async (entry: AuditLogEntry) => {
  const col = await getCollection<AuditLogEntry>(AUDIT_COLLECTION);
  if (!col) return;
  await col.insertOne(entry as any);
};
