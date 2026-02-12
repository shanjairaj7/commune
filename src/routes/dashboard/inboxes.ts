import express, { Router } from 'express';
import { randomUUID } from 'crypto';
import domainStore from '../../stores/domainStore';
import { inboxLimiter } from '../../middleware/rateLimiter';
import logger from '../../utils/logger';
import { OrganizationService } from '../../services/organizationService';
import { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } from '../../config/freeTierConfig';

const router = Router();

router.get('/domains/:domainId/inboxes', async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const inboxes = await domainStore.listInboxes(domainId, orgId);
  return res.json({ data: inboxes });
});

router.post('/domains/:domainId/inboxes', inboxLimiter, express.json(), async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Restrict free tier to default domain only
    if (org.tier === 'free' && domainId !== DEFAULT_DOMAIN_ID) {
      logger.warn('Free tier attempted non-default domain', { 
        orgId, 
        orgName: org.name,
        attemptedDomainId: domainId,
        allowedDomainId: DEFAULT_DOMAIN_ID 
      });
      return res.status(403).json({ 
        error: `Free tier can only use default domain: ${DEFAULT_DOMAIN_NAME}` 
      });
    }

    let domain = await domainStore.getDomain(domainId);
    if (!domain && org.tier === 'free' && domainId === DEFAULT_DOMAIN_ID) {
      domain = await domainStore.upsertDomain({
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: 'verified',
        createdAt: new Date().toISOString(),
        inboxes: [],
      });
    }
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const { localPart, displayName, display_name, agent, webhook, status } = req.body || {};
    if (!localPart) {
      return res.status(400).json({ error: 'Missing localPart' });
    }

    const resolvedDisplayName = displayName || display_name || undefined;

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        id: randomUUID(),
        localPart,
        displayName: resolvedDisplayName,
        agent: agent || (resolvedDisplayName ? { name: resolvedDisplayName } : undefined),
        webhook,
        status,
      },
    });

    if (!inbox) {
      logger.warn('Inbox creation returned null (domain/org mismatch)', { orgId, domainId });
      return res.status(403).json({ error: 'Cannot create inbox on this domain' });
    }

    logger.info('Inbox created', { 
      orgId, 
      tier: org.tier,
      inboxLocalPart: localPart, 
      address: `${localPart}@${domain.name}`,
      hasWebhook: !!webhook,
      domainId 
    });

    return res.json({ data: inbox });
  } catch (err) {
    logger.error('Inbox creation exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to create inbox' });
  }
});

router.get('/domains/:domainId/inboxes/:inboxId', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }

  return res.json({ data: inbox });
});

router.put('/domains/:domainId/inboxes/:inboxId', express.json(), async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const { localPart, agent, webhook, status } = req.body || {};
  const existing = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!existing) {
    return res.status(404).json({ error: 'Inbox not found' });
  }

  const inbox = await domainStore.upsertInbox({
    domainId,
    orgId,
    inbox: {
      ...existing,
      id: inboxId,
      localPart: localPart || existing.localPart,
      agent: agent ?? existing.agent,
      webhook: webhook ?? existing.webhook,
      status: status ?? existing.status,
    },
  });

  return res.json({ data: inbox });
});

router.delete('/domains/:domainId/inboxes/:inboxId', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const removed = await domainStore.removeInbox(domainId, inboxId, orgId);
  if (!removed) {
    return res.status(404).json({ error: 'Inbox not found' });
  }

  return res.json({ ok: true });
});

router.post(
  '/domains/:domainId/inboxes/:inboxId/webhook',
  express.json(),
  async (req, res) => {
    console.log('WEBHOOK ROUTE HIT:', req.params, req.body);
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }
    const { endpoint, events, secret } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    const inbox = await domainStore.updateInboxWebhook({
      domainId,
      inboxId,
      webhook: {
        endpoint,
        events,
        secret,
      },
      orgId,
    });

    if (!inbox) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    return res.json({ data: inbox });
  }
);

router.put(
  '/domains/:domainId/inboxes/:inboxId/extraction-schema',
  express.json(),
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }

    const { name, description, schema, enabled } = req.body || {};
    
    if (!name || !schema) {
      return res.status(400).json({ error: 'Missing required fields: name and schema' });
    }

    // Validate schema is a valid JSON object
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      return res.status(400).json({ error: 'Schema must be a valid JSON object' });
    }

    // Validate schema has required JSON Schema fields
    if (schema.type !== 'object' || !schema.properties) {
      return res.status(400).json({ 
        error: 'Schema must be a valid JSON Schema with type: "object" and properties' 
      });
    }

    const existing = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        ...existing,
        id: inboxId,
        extractionSchema: {
          name,
          description,
          schema,
          enabled: enabled !== undefined ? enabled : true,
        },
      },
    });

    logger.info('Extraction schema updated for inbox', {
      orgId,
      domainId,
      inboxId,
      schemaName: name,
      enabled: inbox?.extractionSchema?.enabled
    });

    return res.json({ data: inbox });
  }
);

router.delete(
  '/domains/:domainId/inboxes/:inboxId/extraction-schema',
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }

    const existing = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        ...existing,
        id: inboxId,
        extractionSchema: undefined,
      },
    });

    logger.info('Extraction schema removed from inbox', {
      orgId,
      domainId,
      inboxId
    });

    return res.json({ data: inbox });
  }
);

export default router;
