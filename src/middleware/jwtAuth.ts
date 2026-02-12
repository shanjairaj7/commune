import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getCollection } from '../db';
import type { User } from '../types';

export interface AuthenticatedRequest extends Request {
  user?: User;
  orgId?: string;
}

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!process.env.JWT_SECRET) {
  console.error('🚨 SECURITY: JWT_SECRET not set in jwtAuth — JWT verification will fail');
}

export const jwtAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    const userCollection = await getCollection<User>('users');
    if (!userCollection) {
      return res.status(500).json({ error: 'Database error' });
    }

    const user = await userCollection.findOne({
      id: decoded.userId,
      status: 'active',
      emailVerified: true
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = user;
    req.orgId = user.orgId;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    console.error('JWT authentication error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
};
