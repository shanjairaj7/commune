import { Router, json } from 'express';
import emailService from '../../services/email';
import messageStore from '../../stores/messageStore';
import { requirePermission } from '../../middleware/permissions';
import { validate } from '../../middleware/validateRequest';
import { SendEmailSchema } from '../../lib/validation';
import logger from '../../utils/logger';
import { emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector } from '../../lib/redisRateLimiter';
import { validateOutboundContent } from '../../middleware/spamPrevention';
import { sendingHealthGate } from '../../middleware/sendingHealthGate';
import { warmupGate } from '../../middleware/warmupGate';
import { enforceInboxDailyLimit } from '../../middleware/inboxLimits';
import { enforceApiKeyEmailLimit } from '../../middleware/apiKeyLimits';

const router = Router();

/**
 * POST /v1/messages/send
 * Send an email message.
 *
 * Body:
 *   to         - Recipient email(s): string or string[]
 *   subject    - Email subject line
 *   html       - HTML body (optional if text is provided)
 *   text       - Plain text body (optional if html is provided)
 *   from       - Sender email address (optional, uses default)
 *   cc         - CC recipients (optional)
 *   bcc        - BCC recipients (optional)
 *   reply_to   - Reply-to address (optional)
 *   thread_id  - Existing thread to reply to (optional)
 *   domain_id  - Domain to send from (optional)
 *   inbox_id   - Inbox to send from (optional)
 *   attachments - Array of attachment IDs from upload (optional)
 */
router.post('/send', sendingHealthGate, warmupGate, emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector, validateOutboundContent, json({ limit: '2mb' }), requirePermission('messages:write'), validate(SendEmailSchema), enforceInboxDailyLimit, enforceApiKeyEmailLimit, async (req: any, res) => {
  const orgId = req.orgId;
  const payload = req.body;

  // thread_id is now used natively throughout the backend — no remapping needed

  try {
    const result = await emailService.sendEmail({
      ...payload,
      orgId: orgId || undefined,
    });

    if (result.error) {
      logger.warn('v1: Email send failed', { orgId, error: result.error, to: payload.to });
      return res.status(400).json({ error: result.error, validation: (result as any).validation });
    }

    const response: Record<string, unknown> = { data: result.data };
    if ((result as any).validation) {
      const v = (result as any).validation;
      if (v.rejected?.length > 0 || v.warnings?.length > 0 || v.suppressed?.length > 0) {
        response.validation = {
          ...(v.rejected?.length > 0 && { rejected: v.rejected }),
          ...(v.warnings?.length > 0 && { warnings: v.warnings }),
          ...(v.suppressed?.length > 0 && { suppressed: v.suppressed }),
          duration_ms: v.duration_ms,
        };
      }
    }

    logger.info('v1: Email sent', { orgId, messageId: result.data?.id });
    return res.json(response);
  } catch (err) {
    logger.error('v1: Email send exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

/**
 * GET /v1/messages
 * List messages with filters.
 *
 * Query params:
 *   inbox_id  - Filter by inbox
 *   domain_id - Filter by domain
 *   sender    - Filter by sender identity
 *   limit     - Max results (1-1000, default 50)
 *   order     - 'asc' or 'desc' (default)
 *   before    - ISO date string, messages before this date
 *   after     - ISO date string, messages after this date
 */
router.get('/', requirePermission('messages:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const { sender, before, after, limit: rawLimit, order, domain_id, inbox_id } = req.query;
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 1000);

  if (!sender && !domain_id && !inbox_id) {
    return res.status(400).json({ error: 'Provide at least one filter: sender, domain_id, or inbox_id' });
  }

  try {
    let data;
    if (inbox_id) {
      data = await messageStore.getMessagesByInbox({
        inboxId: inbox_id as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    } else if (domain_id) {
      data = await messageStore.getMessagesByDomain({
        domainId: domain_id as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    } else {
      data = await messageStore.getMessagesBySender({
        identity: sender as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    }

    return res.json({ data });
  } catch (err) {
    logger.error('v1: Failed to list messages', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list messages' });
  }
});

export default router;
