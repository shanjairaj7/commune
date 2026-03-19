/**
 * Agent Reputation Service — aggregates email metrics per wallet
 * and publishes on-chain attestations via EAS on Base.
 *
 * Each x402 wallet gets an attestation with anonymized metrics:
 * emails sent, delivery/bounce/complaint rates, unique contacts,
 * reply rate, and days active. No PII, no email content, no recipients.
 */

import { getCollection } from '../db';
import logger from '../utils/logger';
import type { Organization } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReputationMetrics {
  emailsSent: number;
  deliveryRateBps: number;   // basis points: 9850 = 98.50%
  bounceRateBps: number;
  complaintRateBps: number;
  uniqueContacts: number;
  replyRateBps: number;
  activeDays: number;
  lastUpdated: number;       // unix timestamp
}

// ── EAS Config ────────────────────────────────────────────────────────────────

export const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
export const SCHEMA_REGISTRY = '0x4200000000000000000000000000000000000020';

export const REPUTATION_SCHEMA =
  'uint32 emailsSent, uint16 deliveryRateBps, uint16 bounceRateBps, uint16 complaintRateBps, uint32 uniqueContacts, uint16 replyRateBps, uint32 activeDays, uint64 lastUpdated';

const SCHEMA_UID = process.env.COMMUNE_REPUTATION_SCHEMA_UID || '';

// ── Metric Aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate email reputation metrics for a wallet-based org.
 * Queries the messages collection across all inboxes for the org.
 */
export async function aggregateWalletMetrics(orgId: string): Promise<ReputationMetrics | null> {
  const messages = await getCollection('messages');
  const orgs = await getCollection<Organization>('organizations');
  if (!messages || !orgs) return null;

  const org = await orgs.findOne({ id: orgId, status: 'active' });
  if (!org) return null;

  const [deliveryStats, uniqueContactCount, inboundCount] = await Promise.all([
    // Delivery metrics: count by status for outbound messages
    messages.aggregate([
      { $match: { direction: 'outbound', org_id: orgId } },
      {
        $group: {
          _id: null,
          sent: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] } },
          complained: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] } },
        },
      },
    ]).toArray(),

    // Unique contacts: distinct recipient addresses
    messages.aggregate([
      { $match: { direction: 'outbound', org_id: orgId } },
      { $unwind: '$participants' },
      { $match: { 'participants.role': 'recipient' } },
      { $group: { _id: '$participants.identity' } },
      { $count: 'total' },
    ]).toArray(),

    // Inbound message count (for reply rate)
    messages.countDocuments({ direction: 'inbound', org_id: orgId }),
  ]);

  const stats = deliveryStats[0] || { sent: 0, delivered: 0, bounced: 0, complained: 0 };
  const sent = stats.sent || 0;
  const divisor = sent || 1;

  const activeDays = org.createdAt
    ? Math.floor((Date.now() - new Date(org.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    emailsSent: sent,
    deliveryRateBps: Math.round((stats.delivered / divisor) * 10000),
    bounceRateBps: Math.round((stats.bounced / divisor) * 10000),
    complaintRateBps: Math.round((stats.complained / divisor) * 10000),
    uniqueContacts: uniqueContactCount[0]?.total || 0,
    replyRateBps: sent > 0 ? Math.round((inboundCount / sent) * 10000) : 0,
    activeDays,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}

// ── EAS Attestation ───────────────────────────────────────────────────────────

/**
 * Publish a reputation attestation on Base via EAS.
 * Returns the attestation UID, or null if EAS is not configured.
 */
export async function publishAttestation(
  walletAddress: string,
  metrics: ReputationMetrics,
): Promise<string | null> {
  const attestationKey = process.env.COMMUNE_ATTESTATION_KEY;
  if (!attestationKey || !SCHEMA_UID) {
    logger.warn('EAS not configured — skipping attestation', {
      hasKey: !!attestationKey,
      hasSchema: !!SCHEMA_UID,
    });
    return null;
  }

  try {
    const { EAS, SchemaEncoder } = await import('@ethereum-attestation-service/eas-sdk');
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base } = await import('viem/chains');

    const account = privateKeyToAccount(attestationKey as `0x${string}`);
    const wallet = createWalletClient({ account, chain: base, transport: http() });

    const eas = new EAS(EAS_CONTRACT);
    eas.connect(wallet as any);

    const encoder = new SchemaEncoder(REPUTATION_SCHEMA);
    const encodedData = encoder.encodeData([
      { name: 'emailsSent', value: metrics.emailsSent, type: 'uint32' },
      { name: 'deliveryRateBps', value: metrics.deliveryRateBps, type: 'uint16' },
      { name: 'bounceRateBps', value: metrics.bounceRateBps, type: 'uint16' },
      { name: 'complaintRateBps', value: metrics.complaintRateBps, type: 'uint16' },
      { name: 'uniqueContacts', value: metrics.uniqueContacts, type: 'uint32' },
      { name: 'replyRateBps', value: metrics.replyRateBps, type: 'uint16' },
      { name: 'activeDays', value: metrics.activeDays, type: 'uint32' },
      { name: 'lastUpdated', value: metrics.lastUpdated, type: 'uint64' },
    ]);

    const tx = await eas.attest({
      schema: SCHEMA_UID,
      data: {
        recipient: walletAddress,
        expirationTime: 0n,
        revocable: true,
        data: encodedData,
      },
    });

    const uid = await tx.wait();
    logger.info('Reputation attestation published', { wallet: walletAddress, uid });
    return uid;
  } catch (err) {
    logger.error('Failed to publish reputation attestation', { wallet: walletAddress, error: err });
    return null;
  }
}

/**
 * Read a wallet's reputation from the local database (cached metrics).
 */
export async function getReputation(walletAddress: string): Promise<ReputationMetrics | null> {
  const orgs = await getCollection<Organization>('organizations');
  if (!orgs) return null;

  const normalized = walletAddress.startsWith('0x') ? walletAddress.toLowerCase() : walletAddress;
  const org = await orgs.findOne({ walletAddress: normalized, status: 'active' });
  if (!org) return null;

  return aggregateWalletMetrics(org.id);
}

/**
 * Get all wallet-based orgs that need attestation updates.
 */
export async function getWalletOrgs(): Promise<Organization[]> {
  const orgs = await getCollection<Organization>('organizations');
  if (!orgs) return [];
  return orgs.find({ walletAddress: { $exists: true, $ne: '' }, status: 'active' } as any).toArray();
}
