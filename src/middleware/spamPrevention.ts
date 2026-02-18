import { Request, Response, NextFunction } from 'express';
import { ContentAnalyzer } from '../services/spam/contentAnalyzer';
import logger from '../utils/logger';

interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string };
  apiKey?: { orgId?: string };
}

// Validate outbound email content for spam patterns
export const validateOutboundContent = async (
  req: OrgRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { text, html, to } = req.body;
    const content = html || text || '';

    // Skip validation for very short content
    if (content.length < 20) {
      return next();
    }

    // Check for too many recipients
    const recipients = Array.isArray(to) ? to : [to];
    if (recipients.length > 50) {
      return res.status(400).json({
        error: 'Too many recipients',
        max_recipients: 50,
        provided: recipients.length,
      });
    }

    // Analyze content for spam patterns
    const contentAnalyzer = ContentAnalyzer.getInstance();
    const contentScore = await contentAnalyzer.analyze(content, req.body.subject || '');

    // If spam score is too high, reject
    if (contentScore.spam_score > 0.8) {
      logger.warn('Outbound email flagged as spam', {
        orgId: req.orgId,
        score: contentScore.spam_score,
        reasons: contentScore.reasons,
      });

      return res.status(400).json({
        error: 'Email content flagged as potential spam',
        score: contentScore.spam_score,
        reasons: contentScore.reasons,
        suggestion: 'Please review your email content and remove spam-like patterns',
      });
    }

    // Log warning if score is moderate
    if (contentScore.spam_score > 0.5) {
      logger.warn('Outbound email has moderate spam score', {
        orgId: req.orgId,
        score: contentScore.spam_score,
        reasons: contentScore.reasons,
      });
    }

    next();
  } catch (error) {
    logger.error('Outbound content validation error:', error);
    // Don't block on validation errors
    next();
  }
};

