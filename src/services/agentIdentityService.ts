import { verify as cryptoVerify, createPublicKey, randomBytes } from 'crypto';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import { AgentSignupStore } from '../stores/agentSignupStore';
import { OrganizationService } from './organizationService';
import { UserService } from './userService';
import domainStore from '../stores/domainStore';
import logger from '../utils/logger';

// Ed25519 SPKI DER prefix — wraps raw 32-byte public key so Node.js crypto can use it
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const TIMESTAMP_TOLERANCE_MS = 60_000; // ±60 seconds

// Default Commune shared domain — agents get orgSlug@commune.email automatically
const DEFAULT_DOMAIN_ID = process.env.DEFAULT_DOMAIN_ID || '';
const DEFAULT_DOMAIN_NAME = process.env.DEFAULT_DOMAIN_NAME || 'commune.email';

// --- Crypto helpers ---

export function isValidBase64PublicKey(publicKeyBase64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    return raw.length === 32;
  } catch {
    return false;
  }
}

function verifyEd25519Signature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawPubKey.length !== 32) return false;

    const der = Buffer.concat([SPKI_ED25519_PREFIX, rawPubKey]);
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });

    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length !== 64) return false;

    return cryptoVerify(null, Buffer.from(message), publicKey, sig);
  } catch {
    return false;
  }
}

function generateChallenge(): string {
  // "chal_" + 32 random bytes hex = 69 chars total, unguessable server nonce
  return 'chal_' + randomBytes(32).toString('hex');
}

// --- Service ---

export class AgentIdentityService {
  /**
   * Step 1: Agent sends public key + org details.
   * Creates org + user, stores pending signup with a challenge nonce.
   * Returns agentSignupToken + challenge for agent to sign with their private key.
   *
   * No email required. No human verifier. The agent proves key ownership
   * in Step 2 by signing the challenge — cryptographic proof, not social proof.
   */
  static async registerAgent(data: {
    agentName: string;
    orgName: string;
    orgSlug: string;
    publicKey: string;  // base64 raw 32-byte Ed25519 PUBLIC key
  }): Promise<{ agentSignupToken: string; challenge: string }> {
    const { agentName, orgName, orgSlug, publicKey } = data;

    // Validate public key format before touching the DB
    if (!isValidBase64PublicKey(publicKey)) {
      throw Object.assign(new Error('publicKey must be a base64-encoded 32-byte Ed25519 public key'), { code: 'INVALID_PUBLIC_KEY' });
    }

    // Create org (slug uniqueness validated inside OrganizationService)
    const org = await OrganizationService.createOrganization({ name: orgName, slug: orgSlug });

    // Create a placeholder user — agents don't have email yet (that's why they're signing up!)
    // Synthetic email satisfies DB uniqueness; never displayed or sent to.
    const syntheticEmail = `agent_${randomBytes(12).toString('hex')}@agents.internal`;
    let user: import('../types/auth').User;
    try {
      ({ user } = await UserService.registerAgentUser({
        orgId: org.id,
        email: syntheticEmail,
        name: agentName,
      }));
    } catch (err: any) {
      logger.error('Agent user creation failed after org creation', { orgId: org.id, err: err.message });
      throw Object.assign(new Error('Registration failed'), { code: 'REGISTRATION_FAILED' });
    }

    // Generate server challenge — agent must sign this with their private key
    const challenge = generateChallenge();

    // Store pending signup atomically — userId/orgId included so verify step needs no extra fetch
    const signup = await AgentSignupStore.create({
      agentName,
      orgName,
      orgSlug,
      publicKey,
      challenge,
      userId: user.id,
      orgId: org.id,
    });

    return { agentSignupToken: signup.agentSignupToken, challenge };
  }

  /**
   * Step 2: Agent signs the challenge with their private key and submits it.
   * If the signature verifies against the stored public key, the agent proved they
   * hold the private key — account activated, inbox auto-provisioned, agentId returned.
   *
   * This replaces the OTP+human flow entirely. No email, no human, cryptographic proof.
   */
  static async verifyAgentChallenge(data: {
    agentSignupToken: string;
    signature: string;  // base64 Ed25519 signature of the challenge string
  }): Promise<{ agentId: string; orgId: string; inboxEmail: string }> {
    const { agentSignupToken, signature } = data;

    const signup = await AgentSignupStore.findByToken(agentSignupToken);
    if (!signup) {
      throw Object.assign(new Error('Invalid or expired signup token'), { code: 'INVALID_TOKEN' });
    }

    // Verify the signature: agent proves they hold the private key for the registered public key
    const valid = verifyEd25519Signature(signup.publicKey, signup.challenge, signature);
    if (!valid) {
      throw Object.assign(new Error('Signature verification failed — wrong private key or corrupted signature'), { code: 'INVALID_SIGNATURE' });
    }

    const { userId, orgId, orgSlug, agentName } = signup;

    // Activate user
    const { getCollection } = await import('../db');
    const userCollection = await getCollection<import('../types/auth').User>('users');
    if (!userCollection) throw new Error('Database not available');
    await userCollection.updateOne(
      { id: userId },
      { $set: { status: 'active', emailVerified: true, updatedAt: new Date().toISOString() } }
    );

    // Auto-provision inbox: orgSlug@commune.email — agent gets email in the same call
    let inboxEmail = `${orgSlug}@${DEFAULT_DOMAIN_NAME}`;
    if (DEFAULT_DOMAIN_ID) {
      try {
        const inbox = await domainStore.upsertInbox({
          domainId: DEFAULT_DOMAIN_ID,
          orgId,
          inbox: {
            localPart: orgSlug,
            displayName: agentName,
            agent: { name: agentName },
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        });
        if (inbox?.address) {
          inboxEmail = inbox.address;
        }
      } catch (err) {
        // Non-fatal: agent still gets their identity even if inbox creation fails
        // They can create an inbox manually via POST /v1/inboxes
        logger.warn('Auto-inbox provisioning failed during agent registration', { orgId, orgSlug, err });
      }
    }

    // Create permanent agent identity record
    const identity = await AgentIdentityStore.create({
      agentName,
      inboxEmail,
      publicKey: signup.publicKey,
      orgId,
      userId,
    });

    // Mark signup as verified (TTL index will auto-delete the record after expiry)
    await AgentSignupStore.markVerified(signup.id);

    logger.info('Agent identity created via challenge-response', { agentId: identity.id, orgId, inboxEmail });

    return { agentId: identity.id, orgId, inboxEmail };
  }

  /**
   * Per-request: Verify the Ed25519 signature from the Authorization header.
   * Called by the v1CombinedAuth middleware on every authenticated /v1/* request.
   *
   * Returns { orgId, agentId } if valid, null if invalid (caller returns 401).
   */
  static async verifyRequestSignature(
    agentId: string,
    timestampMs: number,
    signatureBase64: string
  ): Promise<{ orgId: string; agentId: string } | null> {
    // 1. Replay protection: claim this (agentId, timestampMs) nonce atomically
    const nonceAccepted = await AgentIdentityStore.claimNonce(agentId, timestampMs);
    if (!nonceAccepted) {
      logger.warn('Agent request replay detected', { agentId, timestampMs });
      return null;
    }

    // 2. Look up the agent's public key (only active agents)
    const identity = await AgentIdentityStore.findById(agentId);
    if (!identity) {
      return null;
    }

    // 3. Verify the Ed25519 signature
    //    message = "{agentId}:{timestampMs}" — same format the agent computes client-side
    const message = `${agentId}:${timestampMs}`;
    const valid = verifyEd25519Signature(identity.publicKey, message, signatureBase64);
    if (!valid) {
      logger.warn('Agent signature verification failed', { agentId });
      return null;
    }

    // 4. Update last used timestamp — fire-and-forget, don't block the request
    AgentIdentityStore.updateLastUsed(agentId).catch(err =>
      logger.error('Failed to update agent lastUsedAt', { err })
    );

    return { orgId: identity.orgId, agentId };
  }
}
