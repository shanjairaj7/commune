import express from 'express';
import { z } from 'zod';
import reputationStore from '../../stores/reputationStore';
import messageStore from '../../stores/messageStore';
import blockedSpamStore from '../../stores/blockedSpamStore';
import logger from '../../utils/logger';

const router = express.Router();

// POST /api/spam/report
router.post('/report', async (req, res) => {
  try {
    const { message_id, reason, classification } = z.object({
      message_id: z.string(),
      reason: z.string().optional(),
      classification: z.enum(['spam', 'phishing', 'malware', 'other']).default('spam'),
    }).parse(req.body);

    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get the message
    const message = await messageStore.getMessage(message_id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Extract sender email
    const sender = message.participants.find((p: any) => p.role === 'sender');
    if (!sender) {
      return res.status(400).json({ error: 'Sender not found in message' });
    }

    // Report spam
    await reputationStore.reportSpam(
      message_id,
      sender.identity,
      orgId,
      message.metadata.inbox_id || '',
      reason,
      classification
    );

    // Update message metadata
    await messageStore.updateMessage(message_id, {
      'metadata.spam_reported': true,
      'metadata.spam_report_reason': reason,
      'metadata.spam_report_classification': classification,
    });

    // Check if sender should be blocked
    const spamScore = await reputationStore.getSpamScore(sender.identity);
    let senderBlocked = false;

    if (spamScore && spamScore.spam_score > 0.8) {
      await reputationStore.blockSender(sender.identity, 'High spam score from user reports');
      senderBlocked = true;
    }

    logger.info('Spam reported', {
      message_id,
      sender: sender.identity,
      orgId,
      classification,
      senderBlocked,
    });

    res.json({
      success: true,
      sender_blocked: senderBlocked,
      sender_score: spamScore?.spam_score || 0,
    });
  } catch (error) {
    logger.error('Spam report error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to report spam' });
  }
});

// GET /api/spam/stats
router.get('/stats', async (req, res) => {
  try {
    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const days = parseInt(req.query.period as string) || 7;
    const stats = await reputationStore.getSpamStats(orgId, days);

    res.json(stats);
  } catch (error) {
    logger.error('Spam stats error:', error);
    res.status(500).json({ error: 'Failed to get spam stats' });
  }
});

// POST /api/spam/whitelist
router.post('/whitelist', async (req, res) => {
  try {
    const { email } = z.object({
      email: z.string().email(),
    }).parse(req.body);

    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await reputationStore.unblockSender(email);

    logger.info('Sender whitelisted', { email, orgId });

    res.json({ success: true });
  } catch (error) {
    logger.error('Whitelist error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to whitelist sender' });
  }
});

// DELETE /api/spam/whitelist/:email
router.delete('/whitelist/:email', async (req, res) => {
  try {
    const { email } = req.params;

    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await reputationStore.blockSender(email, 'Removed from whitelist');

    logger.info('Sender removed from whitelist', { email, orgId });

    res.json({ success: true });
  } catch (error) {
    logger.error('Remove whitelist error:', error);
    res.status(500).json({ error: 'Failed to remove from whitelist' });
  }
});

// GET /api/spam/blocked - Get blocked spam emails
router.get('/blocked', async (req, res) => {
  try {
    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { limit, offset, startDate, endDate, classification } = req.query;

    const options: any = {};
    if (limit) options.limit = parseInt(limit as string);
    if (offset) options.offset = parseInt(offset as string);
    if (startDate) options.startDate = new Date(startDate as string);
    if (endDate) options.endDate = new Date(endDate as string);
    if (classification) options.classification = classification as string;

    const blockedEmails = await blockedSpamStore.getBlockedEmails(orgId, options);

    res.json({
      blocked_emails: blockedEmails,
      count: blockedEmails.length,
    });
  } catch (error) {
    logger.error('Get blocked emails error:', error);
    res.status(500).json({ error: 'Failed to get blocked emails' });
  }
});

// GET /api/spam/blocked/stats - Get blocked spam statistics
router.get('/blocked/stats', async (req, res) => {
  try {
    const orgId = (req as any).orgId || (req as any).apiKey?.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const days = parseInt(req.query.days as string) || 7;
    const stats = await blockedSpamStore.getBlockedEmailStats(orgId, days);

    res.json(stats);
  } catch (error) {
    logger.error('Get blocked email stats error:', error);
    res.status(500).json({ error: 'Failed to get blocked email stats' });
  }
});

export default router;
