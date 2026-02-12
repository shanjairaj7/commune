import { Request, Response, NextFunction } from 'express';
import { ApiKeyService } from '../services/apiKeyService';
import logger from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  apiKey?: string;
  apiKeyData?: { permissions: string[]; orgId: string; id: string; name: string };
  authType?: 'jwt' | 'apikey';
}

export const apiKeyAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const apiKey = authHeader.substring(7);
    const result = await ApiKeyService.validateApiKey(apiKey);

    if (!result) {
      return res.status(401).json({ error: 'Invalid or expired API key' });
    }

    req.orgId = result.orgId;
    req.apiKey = apiKey;
    req.apiKeyData = {
      permissions: result.apiKey.permissions || [],
      orgId: result.orgId,
      id: result.apiKey.id,
      name: result.apiKey.name,
    };
    req.authType = 'apikey';
    next();
  } catch (error) {
    logger.error('API key authentication error', { error });
    return res.status(500).json({ error: 'Authentication error' });
  }
};
