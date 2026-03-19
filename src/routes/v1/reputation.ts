import { Router, Request, Response } from 'express';
import { getReputation, aggregateWalletMetrics } from '../../services/reputationService';
import logger from '../../utils/logger';

const router = Router();

/**
 * GET /v1/wallet/reputation
 * Returns the authenticated agent's own reputation metrics.
 */
router.get('/wallet/reputation', async (req: any, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const metrics = await aggregateWalletMetrics(orgId);
    if (!metrics) {
      return res.status(404).json({ error: 'No reputation data found' });
    }
    return res.json({ data: metrics });
  } catch (err) {
    logger.error('Failed to fetch own reputation', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

/**
 * GET /v1/wallet/reputation/:walletAddress
 * Public endpoint — returns any wallet's reputation metrics.
 * No auth required. Reputation is public by design.
 */
router.get('/wallet/reputation/:walletAddress', async (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address required' });
  }

  try {
    const metrics = await getReputation(walletAddress);
    if (!metrics) {
      return res.status(404).json({
        error: 'No reputation data for this wallet',
        wallet: walletAddress,
      });
    }
    return res.json({ data: metrics });
  } catch (err) {
    logger.error('Failed to fetch wallet reputation', { walletAddress, error: err });
    return res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

export default router;
