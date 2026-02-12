import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { sanitizeErrorMessage } from '../lib/sanitize';

export interface CustomError extends Error {
  status?: number;
  code?: string;
}

export const errorHandler = (err: CustomError, req: Request, res: Response, next: NextFunction) => {
  const status = err.status || 500;
  let message = err.message || 'Internal server error';

  // In production, sanitize 500 errors to prevent leaking internals
  if (process.env.NODE_ENV === 'production' && status === 500) {
    message = 'Internal server error';
  } else {
    message = sanitizeErrorMessage(message);
  }

  logger.error('Unhandled error', {
    path: req.path,
    method: req.method,
    status,
    error: err.message,
    stack: err.stack,
    ...(process.env.NODE_ENV !== 'production' && { body: req.body, query: req.query }),
  });

  res.status(status).json({
    error: message,
    code: err.code || 'INTERNAL_ERROR',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
