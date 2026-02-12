import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import apiKeyStore from '../stores/apiKeyStore';
import sessionStore from '../stores/sessionStore';
import userStore from '../stores/userStore';

const API_KEYS = (process.env.COMMUNE_API_KEY || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export const requireApiKey = async (req: Request, res: Response, next: NextFunction) => {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  const match = API_KEYS.some((key) => timingSafeEqual(key, token));
  if (match) {
    (req as any).apiKey = { orgId: null, source: 'static' };
    return next();
  }

  const record = await apiKeyStore.findApiKey(token);
  if (!record) {
    const session = await sessionStore.getSessionByToken(token);
    if (!session) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    const user = await userStore.getUserById(session.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!user.verifiedAt) {
      return res.status(403).json({ error: 'Email verification required' });
    }

    (req as any).session = { userId: session.userId, orgId: session.orgId };
    (req as any).apiKey = { orgId: session.orgId, source: 'session' };
    return next();
  }

  await apiKeyStore.touchApiKey(token);
  (req as any).apiKey = { orgId: record.orgId, source: 'apiKey' };
  return next();
};
