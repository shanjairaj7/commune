/**
 * Reputation Worker — publishes on-chain attestations for x402 wallet orgs.
 *
 * Runs weekly (configurable). For each wallet-based org:
 * 1. Aggregates email metrics (delivery rate, bounce rate, etc.)
 * 2. Compares with last published attestation
 * 3. Publishes updated attestation on Base via EAS if metrics changed
 */

import {
  getWalletOrgs,
  aggregateWalletMetrics,
  publishAttestation,
  type ReputationMetrics,
} from '../services/reputationService';
import logger from '../utils/logger';

// Minimum emails before we publish an attestation (avoid noise from inactive wallets)
const MIN_EMAILS_FOR_ATTESTATION = 10;

/**
 * Run the reputation attestation cycle for all wallet-based orgs.
 * Called by BullMQ scheduler or manually via script.
 */
export async function runReputationCycle(): Promise<{
  processed: number;
  published: number;
  skipped: number;
  errors: number;
}> {
  const stats = { processed: 0, published: 0, skipped: 0, errors: 0 };

  const orgs = await getWalletOrgs();
  logger.info('Reputation cycle starting', { walletOrgs: orgs.length });

  for (const org of orgs) {
    stats.processed++;
    try {
      if (!org.walletAddress) {
        stats.skipped++;
        continue;
      }

      const metrics = await aggregateWalletMetrics(org.id);
      if (!metrics || metrics.emailsSent < MIN_EMAILS_FOR_ATTESTATION) {
        stats.skipped++;
        continue;
      }

      const uid = await publishAttestation(org.walletAddress, metrics);
      if (uid) {
        stats.published++;
        logger.info('Attestation published', {
          wallet: org.walletAddress,
          uid,
          emailsSent: metrics.emailsSent,
          deliveryRate: `${(metrics.deliveryRateBps / 100).toFixed(1)}%`,
        });
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.errors++;
      logger.error('Reputation cycle error for org', { orgId: org.id, error: err });
    }
  }

  logger.info('Reputation cycle complete', stats);
  return stats;
}

// Allow running directly: npx ts-node src/workers/reputationWorker.ts
if (require.main === module) {
  runReputationCycle()
    .then((stats) => {
      console.log('Done:', stats);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed:', err);
      process.exit(1);
    });
}
