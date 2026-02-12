import { Router } from 'express';
import dataDeletionService from '../../services/dataDeletionService';
import logger from '../../utils/logger';

const router = Router();

/**
 * POST /v1/data/deletion-request
 *
 * Create a deletion request with a preview of what will be deleted.
 * Returns a time-limited confirmation token that must be presented
 * to actually execute the deletion.
 *
 * Body:
 *   scope: 'organization' | 'inbox' | 'messages'
 *   inbox_id?: string  (required when scope is 'inbox')
 *   before?: string    (ISO date, optional for scope 'messages')
 */
router.post('/deletion-request', async (req: any, res) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Permission check: only admin-level API keys or JWT users can request deletion
    if (req.authType === 'apikey') {
      const permissions = req.apiKeyData?.permissions || [];
      if (!permissions.includes('admin') && !permissions.includes('data:delete')) {
        return res.status(403).json({
          error: 'Insufficient permissions. API key requires "admin" or "data:delete" permission.',
        });
      }
    }

    const { scope, inbox_id, before } = req.body || {};

    if (!scope || !['organization', 'inbox', 'messages'].includes(scope)) {
      return res.status(400).json({
        error: 'Invalid scope. Must be one of: organization, inbox, messages',
      });
    }

    if (scope === 'inbox' && !inbox_id) {
      return res.status(400).json({ error: 'inbox_id is required for inbox-scoped deletion' });
    }

    if (before && isNaN(Date.parse(before))) {
      return res.status(400).json({ error: 'Invalid "before" date format. Use ISO 8601.' });
    }

    const requestedBy = req.apiKeyData?.id || req.user?.id || 'unknown';

    const { request, confirmationToken } = await dataDeletionService.createRequest({
      orgId,
      scope,
      inboxId: inbox_id,
      before,
      requestedBy,
    });

    // Return the raw token to the caller — only the hash is stored
    return res.status(201).json({
      id: request.id,
      scope: request.scope,
      inbox_id: request.inbox_id || undefined,
      before: request.before || undefined,
      status: request.status,
      preview: request.preview,
      confirmation_token: confirmationToken,
      confirm_by: request.confirm_by,
      requested_at: request.requested_at,
      warning: scope === 'organization'
        ? 'This will permanently delete ALL data for your organization including users, API keys, and the organization itself. This action cannot be undone.'
        : scope === 'inbox'
          ? 'This will permanently delete all messages, attachments, and delivery data for this inbox. This action cannot be undone.'
          : 'This will permanently delete the matching messages and their attachments. This action cannot be undone.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create deletion request', { error: message });

    if (message.includes('active deletion request already exists')) {
      return res.status(409).json({ error: message });
    }

    return res.status(400).json({ error: message });
  }
});

/**
 * POST /v1/data/deletion-request/:id/confirm
 *
 * Confirm and execute a deletion request.
 * The confirmation_token from the creation response must be provided.
 *
 * Body:
 *   confirmation_token: string
 */
router.post('/deletion-request/:id/confirm', async (req: any, res) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { confirmation_token } = req.body || {};

    if (!confirmation_token) {
      return res.status(400).json({ error: 'confirmation_token is required' });
    }

    // Verify the request belongs to this org
    const existing = await dataDeletionService.getRequest(id, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Deletion request not found' });
    }

    const result = await dataDeletionService.confirmRequest(id, confirmation_token);

    return res.json({
      id: result.id,
      scope: result.scope,
      status: result.status,
      preview: result.preview,
      deleted_counts: result.deleted_counts,
      confirmed_at: result.confirmed_at,
      completed_at: result.completed_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to confirm deletion request', { error: message });

    if (message.includes('expired')) {
      return res.status(410).json({ error: message });
    }
    if (message.includes('Invalid confirmation token')) {
      return res.status(403).json({ error: message });
    }

    return res.status(400).json({ error: message });
  }
});

/**
 * GET /v1/data/deletion-request/:id
 *
 * Check the status of a deletion request.
 */
router.get('/deletion-request/:id', async (req: any, res) => {
  try {
    const orgId = req.orgId;
    if (!orgId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const request = await dataDeletionService.getRequest(id, orgId);

    if (!request) {
      return res.status(404).json({ error: 'Deletion request not found' });
    }

    return res.json({
      id: request.id,
      scope: request.scope,
      inbox_id: request.inbox_id || undefined,
      before: request.before || undefined,
      status: request.status,
      preview: request.preview,
      deleted_counts: request.deleted_counts || undefined,
      confirm_by: request.confirm_by,
      requested_at: request.requested_at,
      confirmed_at: request.confirmed_at || undefined,
      completed_at: request.completed_at || undefined,
      error: request.error || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message });
  }
});

export default router;
