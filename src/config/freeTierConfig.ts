import logger from '../utils/logger';

// Free tier configuration
// Free users can only create inboxes on the shared default domain.
// These MUST be set via environment variables in production.

export const DEFAULT_DOMAIN_ID = process.env.DEFAULT_DOMAIN_ID || '';
export const DEFAULT_DOMAIN_NAME = process.env.DEFAULT_DOMAIN_NAME || '';

if (!process.env.DEFAULT_DOMAIN_ID || !process.env.DEFAULT_DOMAIN_NAME) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('DEFAULT_DOMAIN_ID and DEFAULT_DOMAIN_NAME must be set in production. Free-tier inbox creation will fail.');
  } else {
    logger.warn('DEFAULT_DOMAIN_ID / DEFAULT_DOMAIN_NAME not set — free-tier shared domain features disabled in development.');
  }
}
