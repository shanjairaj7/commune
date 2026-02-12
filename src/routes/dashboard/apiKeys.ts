import { Router } from 'express';
import { jwtAuth, AuthenticatedRequest } from '../../middleware/jwtAuth';
import { ApiKeyService } from '../../services/apiKeyService';

const router = Router();

router.use(jwtAuth);

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, permissions, expiresIn } = req.body;
    const userId = req.user!.id;
    const orgId = req.orgId!;

    if (!name) {
      return res.status(400).json({ error: 'API key name is required' });
    }

    const keyCount = await ApiKeyService.countApiKeysByOrg(orgId);
    if (keyCount >= 10) {
      return res.status(400).json({ error: 'Maximum API keys limit reached (10)' });
    }

    const result = await ApiKeyService.generateApiKey({
      orgId,
      name,
      permissions,
      expiresIn,
      createdBy: userId
    });

    res.status(201).json({
      apiKey: result.apiKey,
      apiKeyData: {
        id: result.apiKeyData.id,
        name: result.apiKeyData.name,
        keyPrefix: result.apiKeyData.keyPrefix,
        permissions: result.apiKeyData.permissions,
        status: result.apiKeyData.status,
        expiresAt: result.apiKeyData.expiresAt,
        createdAt: result.apiKeyData.createdAt
      }
    });
  } catch (error) {
    console.error('API key creation error:', error);
    res.status(400).json({ error: 'Failed to create API key' });
  }
});

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const apiKeys = await ApiKeyService.listApiKeys(orgId);

    res.json({
      apiKeys: apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        permissions: key.permissions,
        status: key.status,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt
      }))
    });
  } catch (error) {
    console.error('API key listing error:', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.get('/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;

    const apiKey = await ApiKeyService.getApiKeyById(keyId);
    if (!apiKey || apiKey.orgId !== orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        permissions: apiKey.permissions,
        status: apiKey.status,
        lastUsedAt: apiKey.lastUsedAt,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        updatedAt: apiKey.updatedAt
      }
    });
  } catch (error) {
    console.error('API key fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch API key' });
  }
});

router.delete('/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;

    const success = await ApiKeyService.revokeApiKey(orgId, keyId);
    if (!success) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    console.error('API key revocation error:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

router.post('/:keyId/rotate', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const userId = req.user!.id;
    const orgId = req.orgId!;

    const result = await ApiKeyService.rotateApiKey(orgId, keyId, userId);
    if (!result) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      apiKey: result.apiKey,
      apiKeyData: {
        id: result.apiKeyData.id,
        name: result.apiKeyData.name,
        keyPrefix: result.apiKeyData.keyPrefix,
        permissions: result.apiKeyData.permissions,
        status: result.apiKeyData.status,
        expiresAt: result.apiKeyData.expiresAt,
        updatedAt: result.apiKeyData.updatedAt
      }
    });
  } catch (error) {
    console.error('API key rotation error:', error);
    res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

export default router;
