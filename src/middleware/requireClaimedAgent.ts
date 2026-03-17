import { Response, NextFunction } from 'express';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import type { V1AuthenticatedRequest } from './agentSignatureAuth';

/**
 * Middleware: requires agent to be claimed by a human owner.
 *
 * Only applies to agent-signed requests (req.authType === 'agent').
 * API key auth passes through — API keys can only be created after claiming,
 * so their existence proves the agent was already claimed.
 */
export const requireClaimedAgent = async (
  req: V1AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // API key auth bypasses — the key couldn't exist if agent wasn't claimed
  if (req.authType !== 'agent') {
    next();
    return;
  }

  if (!req.agentId) {
    res.status(401).json({ error: 'Missing agent identity' });
    return;
  }

  const identity = await AgentIdentityStore.findById(req.agentId);
  if (!identity) {
    res.status(401).json({ error: 'Agent not found' });
    return;
  }

  if (identity.ownershipStatus === 'claimed') {
    next();
    return;
  }

  res.status(403).json({
    error: 'ownership_required',
    message: 'This agent must be claimed by an owner before performing this action. Call POST /v1/agent/claim-ownership with your owner\'s email.',
    ownershipStatus: identity.ownershipStatus,
    claimEndpoint: 'POST /v1/agent/claim-ownership',
    docs: 'https://commune.email/agent-auth',
  });
};
