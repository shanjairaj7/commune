/**
 * /v1/agent/* — Agent self-service management
 *
 * Allows an authenticated agent (Ed25519 signing OR comm_ API key) to
 * manage their own org's resources without ever touching the dashboard.
 *
 * All routes here require v1CombinedAuth (mounted on the v1 router).
 *
 * Auth note: req.orgId is always set by v1CombinedAuth regardless of auth method.
 *            For agent signing, req.agentId is also set (used as createdBy for API keys).
 *            For API key auth, req.apiKeyData.id is used as createdBy.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ApiKeyService } from '../../services/apiKeyService';
import { AgentIdentityService } from '../../services/agentIdentityService';
import { OrganizationService } from '../../services/organizationService';
import { requireClaimedAgent } from '../../middleware/requireClaimedAgent';
import logger from '../../utils/logger';

const router = Router();

// ─── Org management ────────────────────────────────────────────────────────

/**
 * GET /v1/agent/org
 * Get the agent's own organization details.
 */
router.get('/org', async (req: any, res) => {
  try {
    const org = await OrganizationService.getOrganization(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res.json({ org });
  } catch (err) {
    logger.error('Agent GET org error', { err });
    return res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

/**
 * PATCH /v1/agent/org
 * Update org name. Slug changes are intentionally not supported here
 * (slug changes affect DNS/routing and should be deliberate).
 */
router.patch('/org', async (req: any, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'missing_fields', message: 'name is required' });
  }
  try {
    const updated = await OrganizationService.updateOrganization(req.orgId, {
      name: name.trim(),
      updatedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'Organization not found' });
    return res.json({ org: updated });
  } catch (err) {
    logger.error('Agent PATCH org error', { err });
    return res.status(500).json({ error: 'Failed to update organization' });
  }
});

// ─── Ownership claim ──────────────────────────────────────────────────────

// 3 claim attempts per IP per 24 hours — prevents spamming random emails
const claimRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many claim attempts. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /v1/agent/claim-ownership
 * Agent initiates ownership claim by providing its owner's email.
 * Sends a claim link to the owner. Owner clicks to accept.
 *
 * Body:
 *   ownerEmail: string — the human owner's email address
 */
router.post('/claim-ownership', claimRateLimit, async (req: any, res) => {
  const { ownerEmail } = req.body;

  if (!ownerEmail || typeof ownerEmail !== 'string') {
    return res.status(400).json({ error: 'missing_fields', message: 'ownerEmail is required' });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(ownerEmail.trim())) {
    return res.status(400).json({ error: 'invalid_email', message: 'ownerEmail must be a valid email address' });
  }

  if (!req.agentId) {
    return res.status(400).json({
      error: 'agent_signing_required',
      message: 'Ownership claim requires agent signature auth, not API key auth.',
    });
  }

  try {
    const result = await AgentIdentityService.initiateOwnershipClaim({
      agentId: req.agentId,
      ownerEmail: ownerEmail.trim().toLowerCase(),
    });

    return res.json({
      status: result.status,
      ownerEmail: result.ownerEmail,
      message: `Claim link sent to ${result.ownerEmail}. Your owner needs to click the link to activate this agent. You can receive and read emails while waiting.`,
      expiresIn: result.expiresIn,
    });
  } catch (err: any) {
    if (err.code === 'ALREADY_CLAIMED') {
      return res.status(409).json({ error: 'already_claimed', message: 'This agent is already claimed by an owner.' });
    }
    if (err.code === 'CLAIM_COOLDOWN') {
      return res.status(429).json({ error: 'claim_cooldown', message: err.message });
    }
    if (err.code === 'EMAIL_SEND_FAILED') {
      return res.status(502).json({ error: 'email_send_failed', message: 'Failed to send claim email. Please try again.' });
    }
    logger.error('Agent claim-ownership error', { err });
    return res.status(500).json({ error: 'Failed to initiate ownership claim' });
  }
});

// ─── API key management ────────────────────────────────────────────────────

/**
 * GET /v1/agent/api-keys
 * List all active API keys for the agent's org.
 * Raw key values are never returned — only metadata.
 */
router.get('/api-keys', async (req: any, res) => {
  try {
    const keys = await ApiKeyService.listApiKeys(req.orgId);
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res.json({
      apiKeys: keys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        permissions: k.permissions,
        status: k.status,
        expiresAt: k.expiresAt ?? null,
        lastUsedAt: k.lastUsedAt ?? null,
        createdAt: k.createdAt,
      })),
    });
  } catch (err) {
    logger.error('Agent list API keys error', { err });
    return res.status(500).json({ error: 'Failed to list API keys' });
  }
});

/**
 * POST /v1/agent/api-keys
 * Create a new comm_ API key for the agent's org.
 * The raw key is shown ONCE in the response — store it immediately.
 *
 * Body:
 *   name:        string   — label for this key
 *   permissions: string[] — optional, defaults to ['read', 'write']
 *   expiresIn:   number   — optional, seconds until expiry
 */
router.post('/api-keys', requireClaimedAgent, async (req: any, res) => {
  const { name, permissions, expiresIn } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'missing_fields', message: 'name is required' });
  }

  // Enforce org API key limit (reuse existing service method)
  const count = await ApiKeyService.countApiKeysByOrg(req.orgId);
  const MAX_KEYS = 10;
  if (count >= MAX_KEYS) {
    return res.status(429).json({
      error: 'api_key_limit_reached',
      message: `Maximum ${MAX_KEYS} API keys per organization. Revoke an existing key first.`,
    });
  }

  if (permissions !== undefined && !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'invalid_permissions', message: 'permissions must be an array' });
  }

  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || expiresIn <= 0)) {
    return res.status(400).json({ error: 'invalid_expires_in', message: 'expiresIn must be a positive number of seconds' });
  }

  try {
    // createdBy is the agentId (for agent signing) or the API key id (for comm_ key auth)
    const createdBy = req.agentId ?? req.apiKeyData?.id ?? 'agent';

    const { apiKey, apiKeyData } = await ApiKeyService.generateApiKey({
      orgId: req.orgId,
      name: name.trim(),
      permissions: permissions ?? ['read', 'write'],
      expiresIn,
      createdBy,
    });

    return res.status(201).json({
      apiKey,               // comm_xxx — shown ONCE, store immediately
      id: apiKeyData.id,
      name: apiKeyData.name,
      keyPrefix: apiKeyData.keyPrefix,
      permissions: apiKeyData.permissions,
      status: apiKeyData.status,
      expiresAt: apiKeyData.expiresAt ?? null,
      createdAt: apiKeyData.createdAt,
      message: `Store immediately: export COMMUNE_API_KEY="${apiKey}"`,
    });
  } catch (err) {
    logger.error('Agent create API key error', { err });
    return res.status(500).json({ error: 'Failed to create API key' });
  }
});

/**
 * DELETE /v1/agent/api-keys/:keyId
 * Revoke an API key. Scoped to the agent's org — cannot revoke keys from other orgs.
 */
router.delete('/api-keys/:keyId', async (req: any, res) => {
  const { keyId } = req.params;
  try {
    // getApiKeyById doesn't scope by orgId, so we do an explicit ownership check
    const key = await ApiKeyService.getApiKeyById(keyId);
    if (!key || key.orgId !== req.orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }
    const revoked = await ApiKeyService.revokeApiKey(req.orgId, keyId);
    if (!revoked) return res.status(404).json({ error: 'API key not found or already revoked' });
    return res.json({ message: 'API key revoked' });
  } catch (err) {
    logger.error('Agent revoke API key error', { err });
    return res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

/**
 * POST /v1/agent/api-keys/:keyId/rotate
 * Rotate an API key — invalidates the old key and returns a new raw key.
 * The new raw key is shown ONCE — store it immediately.
 */
router.post('/api-keys/:keyId/rotate', async (req: any, res) => {
  const { keyId } = req.params;
  try {
    const key = await ApiKeyService.getApiKeyById(keyId);
    if (!key || key.orgId !== req.orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }
    const createdBy = req.agentId ?? req.apiKeyData?.id ?? 'agent';
    const result = await ApiKeyService.rotateApiKey(req.orgId, keyId, createdBy);
    if (!result) return res.status(404).json({ error: 'API key not found or inactive' });

    return res.json({
      apiKey: result.apiKey,      // new comm_xxx — shown ONCE
      id: result.apiKeyData.id,
      name: result.apiKeyData.name,
      keyPrefix: result.apiKeyData.keyPrefix,
      expiresAt: result.apiKeyData.expiresAt ?? null,
      message: `Old key invalidated. Store the new key immediately: export COMMUNE_API_KEY="${result.apiKey}"`,
    });
  } catch (err) {
    logger.error('Agent rotate API key error', { err });
    return res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

export default router;
