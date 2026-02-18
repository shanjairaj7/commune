import express, { Router } from 'express';
import emailService from '../../services/email';
import messageStore from '../../stores/messageStore';
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

router.post('/email/send', sendingHealthGate, warmupGate, emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector, validateOutboundContent, express.json({ limit: '2mb' }), validate(SendEmailSchema), enforceInboxDailyLimit, enforceApiKeyEmailLimit, async (req, res) => {
  const payload = req.body;
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const result = await emailService.sendEmail({
      ...payload,
      orgId: orgId || undefined,
    });
    
    if (result.error) {
      logger.warn('Email send failed', { orgId, error: result.error, to: payload.to });
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

    logger.info('Email sent successfully', { 
      orgId, 
      messageId: result.data?.id,
      recipientCount: payload.to?.length || 1,
    });
    return res.json(response);
  } catch (err) {
    logger.error('Email send exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

router.post('/messages/send', sendingHealthGate, warmupGate, emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector, validateOutboundContent, express.json({ limit: '2mb' }), validate(SendEmailSchema), enforceInboxDailyLimit, enforceApiKeyEmailLimit, async (req, res) => {
  const payload = req.body;
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const result = await emailService.sendEmail({
      ...payload,
      orgId: orgId || undefined,
    });
    
    if (result.error) {
      logger.warn('Message send failed', { orgId, error: result.error, to: payload.to });
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

    logger.info('Message sent successfully', { 
      orgId, 
      messageId: result.data?.id,
      recipientCount: payload.to?.length || 1,
    });
    return res.json(response);
  } catch (err) {
    logger.error('Message send exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

router.get('/threads/:threadId/legacy/messages', async (req, res) => {
  const { threadId } = req.params;
  const limit = Math.min(Number(req.query.limit || 50), 1000);
  const order = (req.query.order as 'asc' | 'desc') || 'asc';
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const data = await messageStore.getMessagesByThread(
      threadId,
      limit,
      order,
      orgId || undefined
    );
    logger.info('Fetched thread messages', { 
      orgId, 
      threadId, 
      count: data?.length || 0 
    });
    return res.json({ data });
  } catch (err) {
    logger.error('Failed to fetch thread messages', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.get('/messages', async (req, res) => {
  const { sender, channel, before, after, limit, order, domain_id, inbox_id } = req.query;
  const orgId = (req as any).apiKey?.orgId || null;
  const queryLimit = Math.min(Number(limit || 50), 1000);

  if (!sender && !domain_id && !inbox_id) {
    logger.warn('Missing required query parameter', { orgId, params: req.query });
    return res.status(400).json({ error: 'Missing sender, domain_id, or inbox_id' });
  }

  try {
    if (inbox_id) {
      const data = await messageStore.getMessagesByInbox({
        inboxId: inbox_id as string,
        channel: channel as string | undefined,
        before: before as string | undefined,
        after: after as string | undefined,
        limit: queryLimit,
        order: order as 'asc' | 'desc' | undefined,
        orgId: orgId || undefined,
      });
      logger.info('Fetched messages by inbox', { orgId, inboxId: inbox_id, count: data?.length || 0 });
      return res.json({ data });
    }

    if (domain_id) {
      const data = await messageStore.getMessagesByDomain({
        domainId: domain_id as string,
        channel: channel as string | undefined,
        before: before as string | undefined,
        after: after as string | undefined,
        limit: queryLimit,
        order: order as 'asc' | 'desc' | undefined,
        orgId: orgId || undefined,
      });
      logger.info('Fetched messages by domain', { orgId, domainId: domain_id, count: data?.length || 0 });
      return res.json({ data });
    }

    const data = await messageStore.getMessagesBySender({
      identity: sender as string,
      channel: channel as string | undefined,
      before: before as string | undefined,
      after: after as string | undefined,
      limit: queryLimit,
      order: order as 'asc' | 'desc' | undefined,
      orgId: orgId || undefined,
    });
    logger.info('Fetched sender messages', { orgId, sender, count: data?.length || 0 });
    return res.json({ data });
  } catch (err) {
    logger.error('Failed to fetch messages', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.get('/threads', async (req, res) => {
  const { inbox_id, domain_id, limit: rawLimit, cursor, order } = req.query;
  const orgId = (req as any).apiKey?.orgId || null;

  if (!inbox_id && !domain_id) {
    return res.status(400).json({ error: 'Missing required query parameter: inbox_id or domain_id' });
  }

  const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 100);

  try {
    const result = await messageStore.listThreads({
      inboxId: inbox_id as string | undefined,
      domainId: domain_id as string | undefined,
      limit,
      cursor: cursor as string | undefined,
      order: (order as 'asc' | 'desc') || 'desc',
      orgId: orgId || undefined,
    });

    return res.json({
      data: result.threads,
      next_cursor: result.next_cursor,
      has_more: result.next_cursor !== null,
    });
  } catch (err) {
    logger.error('Failed to list threads', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list threads' });
  }
});

router.get('/threads/:threadId/messages', async (req, res) => {
  const { threadId } = req.params;
  const limit = Math.min(Number(req.query.limit || 50), 1000);
  const order = (req.query.order as 'asc' | 'desc') || 'asc';
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const data = await messageStore.getMessagesByThread(
      threadId,
      limit,
      order,
      orgId || undefined
    );
    return res.json({ data });
  } catch (err) {
    logger.error('Failed to fetch thread messages', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to fetch thread messages' });
  }
});

export default router;
