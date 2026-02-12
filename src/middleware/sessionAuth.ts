import type { NextFunction, Request, Response } from 'express';
import sessionStore from '../stores/sessionStore';

export type SessionContext = {
  userId: string;
  orgId: string;
};

export const requireSession = async (req: Request, res: Response, next: NextFunction) => {
  const auth = req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) {
    return res.status(401).json({ error: 'Missing session token' });
  }

  const session = await sessionStore.getSessionByToken(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  (req as any).session = { userId: session.userId, orgId: session.orgId } as SessionContext;
  return next();
};
