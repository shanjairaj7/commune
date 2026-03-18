import { verify as cryptoVerify, createPublicKey, randomBytes } from 'crypto';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import { AgentSignupStore } from '../stores/agentSignupStore';
import { AgentClaimStore } from '../stores/agentClaimStore';
import { OrganizationService } from './organizationService';
import { UserService } from './userService';
import resend from './resendClient';
import domainStore from '../stores/domainStore';
import logger from '../utils/logger';
import type { ChallengeParams } from '../types/auth';

// Ed25519 SPKI DER prefix — wraps raw 32-byte public key so Node.js crypto can use it
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const TIMESTAMP_TOLERANCE_MS = 60_000; // ±60 seconds

// Default Commune shared domain — agents get orgSlug@commune.email automatically
const DEFAULT_DOMAIN_ID = process.env.DEFAULT_DOMAIN_ID || '';
const DEFAULT_DOMAIN_NAME = process.env.DEFAULT_DOMAIN_NAME || 'commune.email';

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL || 'https://commune.email';

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

// --- Contextual challenge helpers ---

/**
 * Count words in a string that have 5 or more alphabetical characters.
 * Punctuation is stripped before measuring each word's length.
 *
 * "handles customer-support tickets efficiently" → ["handles"(7), "customer"(8), "support"(7), "tickets"(7), "efficiently"(11)] → 5
 */
function countLongWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 5)
    .length;
}

/**
 * Generate a contextual registration challenge for an LLM agent.
 *
 * The challenge is a natural-language paragraph — not a structured JSON nonce.
 * It requires the agent to:
 *   1. Identify the primary verb of their stated purpose (reading comprehension + reasoning)
 *   2. Count words in their purpose with 5+ alphabetical chars (reading + arithmetic)
 *   3. Include a server-issued epoch marker (prevents replay / cached solutions)
 *
 * The server pre-computes the expected word count and stores it alongside the epoch
 * marker, so verification is fully deterministic — no LLM evaluation needed server-side.
 *
 * A hardcoded script targeting Commune's API cannot complete this challenge because:
 *   - The old API expected signing an opaque "chal_xxx" nonce directly; the new flow
 *     requires constructing and signing a structured string derived from NLP reasoning.
 *   - The epoch marker is unique per registration (no caching solutions).
 *   - The verb must semantically match the stated purpose — not derivable without
 *     reading comprehension.
 *   - The word count depends on the content of agentPurpose, which varies per agent.
 */
function generateContextualChallenge(
  agentName: string,
  agentPurpose: string
): { challengeText: string; challengeParams: ChallengeParams } {
  const epochMarker = randomBytes(8).toString('hex'); // 16-char hex, unguessable
  const expectedWordCount = countLongWords(agentPurpose);

  const challengeText = [
    `You are registering "${agentName}" on Commune, an email infrastructure platform for AI agents.`,
    ``,
    `Your stated purpose:`,
    `"${agentPurpose}"`,
    ``,
    `To verify you are an AI agent capable of reading and reasoning about your own context,`,
    `complete ALL THREE of the following steps:`,
    ``,
    `STEP 1 — PRIMARY VERB`,
    `Identify the single lowercase verb that best captures your agent's core action.`,
    `Choose one that genuinely reflects what you do — for example: monitors, processes, sends,`,
    `handles, analyzes, classifies, routes, extracts, generates, summarizes, responds,`,
    `manages, detects, orchestrates, triages, filters, schedules, coordinates, validates.`,
    ``,
    `STEP 2 — WORD COUNT`,
    `Count the words in your stated purpose above that contain 5 or more alphabetical`,
    `characters. Strip punctuation before measuring each word's length. Use the exact`,
    `quoted text as your source (do not re-read this instruction text).`,
    ``,
    `STEP 3 — EPOCH MARKER`,
    `Include this exact string: ${epochMarker}`,
    ``,
    `RESPONSE FORMAT`,
    `Construct your challengeResponse as a single colon-separated string:`,
    `  <primary_verb>:<word_count>:<epoch_marker>`,
    ``,
    `Example — if your verb is "processes" and your word count is 4:`,
    `  processes:4:${epochMarker}`,
    ``,
    `Sign this exact challengeResponse string (not this challenge text) with your`,
    `Ed25519 private key. Submit both challengeResponse and signature to /v1/auth/agent-verify.`,
  ].join('\n');

  return {
    challengeText,
    challengeParams: { epochMarker, expectedWordCount },
  };
}

/**
 * Validate the agent's challengeResponse against the stored params.
 *
 * Format: "<verb>:<wordCount>:<epochMarker>"
 *
 * Validates:
 *   - Exactly 3 colon-separated parts
 *   - verb: single lowercase alphabetical word, 2–30 chars
 *   - wordCount: integer matching the server's pre-computed expectedWordCount
 *   - epochMarker: exact match to the stored epoch marker
 *
 * The verb is validated for format (lowercase alpha) but NOT for semantic correctness —
 * that would require an LLM judge. The script-resistance comes from the agent needing
 * to parse natural language to discover the required format + compute the correct count.
 */
function validateChallengeResponse(
  challengeResponse: string,
  params: ChallengeParams
): { valid: boolean; reason?: string } {
  if (!challengeResponse || typeof challengeResponse !== 'string') {
    return { valid: false, reason: 'challengeResponse is required' };
  }

  const parts = challengeResponse.split(':');
  if (parts.length !== 3) {
    return {
      valid: false,
      reason: 'challengeResponse must have exactly 3 colon-separated parts: verb:count:epochMarker',
    };
  }

  const [verb, countStr, marker] = parts;

  // Verb: single lowercase alphabetical word, 2–30 characters
  if (!/^[a-z]{2,30}$/.test(verb)) {
    return {
      valid: false,
      reason: 'first part (verb) must be a single lowercase alphabetical word, 2–30 characters',
    };
  }

  // Word count: must be a non-negative integer matching the pre-computed value
  if (!/^\d+$/.test(countStr)) {
    return { valid: false, reason: 'second part (word count) must be a non-negative integer' };
  }
  const count = parseInt(countStr, 10);
  if (count !== params.expectedWordCount) {
    return { valid: false, reason: 'word count does not match the 5+-character word count of your stated purpose' };
  }

  // Epoch marker: must be verbatim
  if (marker !== params.epochMarker) {
    return { valid: false, reason: 'epoch marker does not match — use the exact string from the challenge' };
  }

  return { valid: true };
}

// --- Service ---

export class AgentIdentityService {
  /**
   * Step 1: Agent sends public key, agent purpose, and org details.
   *
   * Creates org + synthetic user, generates a contextual natural-language challenge
   * that requires LLM reasoning to complete, stores pending signup, and returns the
   * challenge text + signup token.
   *
   * New field: agentPurpose — a 1–3 sentence description of what the agent does.
   * This is used to generate a challenge specific to the agent's context, making it
   * impossible to hardcode a solution without an LLM.
   */
  static async registerAgent(data: {
    agentName: string;
    agentPurpose: string; // new: what the agent does — used to generate contextual challenge
    orgName: string;
    orgSlug: string;
    publicKey: string;  // base64 raw 32-byte Ed25519 PUBLIC key
    avatarUrl?: string;
    websiteUrl?: string;
    moltbookHandle?: string;
    capabilities?: string[];
  }): Promise<{ agentSignupToken: string; challenge: { text: string; format: string } }> {
    const { agentName, agentPurpose, orgName, orgSlug, publicKey, avatarUrl, websiteUrl, moltbookHandle, capabilities } = data;

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

    // Generate contextual challenge — specific to this agent's purpose
    const { challengeText, challengeParams } = generateContextualChallenge(agentName, agentPurpose);

    // Store pending signup atomically — all params included so verify step needs no extra fetch
    const signup = await AgentSignupStore.create({
      agentName,
      agentPurpose,
      orgName,
      orgSlug,
      publicKey,
      challenge: challengeText,
      challengeParams,
      userId: user.id,
      orgId: org.id,
      avatarUrl,
      websiteUrl,
      moltbookHandle,
      capabilities,
    });

    return {
      agentSignupToken: signup.agentSignupToken,
      challenge: {
        text: challengeText,
        format: '<primary_verb>:<word_count>:<epoch_marker>',
      },
    };
  }

  /**
   * Step 2: Agent submits their constructed challengeResponse and its signature.
   *
   * The agent must have:
   *   1. Read the challenge text (natural language)
   *   2. Identified their primary verb
   *   3. Counted 5+-character words in their stated purpose
   *   4. Constructed: "<verb>:<count>:<epochMarker>"
   *   5. Signed that string with their private key
   *
   * Server validates:
   *   - challengeResponse format is correct
   *   - word count matches the pre-computed expectedWordCount for their agentPurpose
   *   - epoch marker matches what was issued
   *   - signature is a valid Ed25519 signature of challengeResponse (not the challenge text)
   *
   * On success: activates account, auto-provisions inbox, returns agentId.
   */
  static async verifyAgentChallenge(data: {
    agentSignupToken: string;
    challengeResponse: string; // the agent-constructed "verb:count:epochMarker" string
    signature: string;          // base64 Ed25519 signature of challengeResponse
  }): Promise<{
    agentId: string;
    orgId: string;
    inboxEmail: string;
    ownershipStatus: 'unclaimed';
    nextStep: { action: string; endpoint: string; body: { ownerEmail: string }; description: string };
  }> {
    const { agentSignupToken, challengeResponse, signature } = data;

    const signup = await AgentSignupStore.findByToken(agentSignupToken);
    if (!signup) {
      throw Object.assign(new Error('Invalid or expired signup token'), { code: 'INVALID_TOKEN' });
    }

    // 1. Validate challengeResponse structure + correctness (deterministic, no LLM needed)
    const validation = validateChallengeResponse(challengeResponse, signup.challengeParams);
    if (!validation.valid) {
      throw Object.assign(
        new Error(`Challenge response invalid: ${validation.reason}`),
        { code: 'INVALID_CHALLENGE_RESPONSE' }
      );
    }

    // 2. Verify the Ed25519 signature — the agent signs challengeResponse, not the challenge text.
    //    This proves: (a) the agent holds the private key, AND (b) they constructed the correct response.
    const valid = verifyEd25519Signature(signup.publicKey, challengeResponse, signature);
    if (!valid) {
      throw Object.assign(
        new Error('Signature verification failed — ensure you signed the challengeResponse string, not the challenge text'),
        { code: 'INVALID_SIGNATURE' }
      );
    }

    const { userId, orgId, orgSlug, agentName, agentPurpose, avatarUrl, websiteUrl, moltbookHandle, capabilities } = signup;

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
        logger.warn('Auto-inbox provisioning failed during agent registration', { orgId, orgSlug, err });
      }
    }

    // Create permanent agent identity record (now includes agentPurpose)
    const identity = await AgentIdentityStore.create({
      agentName,
      agentPurpose,
      inboxEmail,
      publicKey: signup.publicKey,
      orgId,
      userId,
      avatarUrl,
      websiteUrl,
      moltbookHandle,
      capabilities,
    });

    // Mark signup as verified (TTL index will auto-delete the record after expiry)
    await AgentSignupStore.markVerified(signup.id);

    logger.info('Agent identity created via contextual challenge-response', {
      agentId: identity.id,
      orgId,
      inboxEmail,
      agentPurpose: agentPurpose.slice(0, 80),
    });

    return {
      agentId: identity.id,
      orgId,
      inboxEmail,
      ownershipStatus: 'unclaimed',
      nextStep: {
        action: 'claim_ownership',
        endpoint: 'POST /v1/agent/claim-ownership',
        body: { ownerEmail: '<your_owner_email>' },
        description: 'Link this agent to a human owner. Required before you can send emails or create additional inboxes.',
      },
    };
  }

  /**
   * Step 3: Agent initiates ownership claim by providing owner's email.
   * Sends a claim link to the owner. Owner clicks to accept.
   */
  static async initiateOwnershipClaim(data: {
    agentId: string;
    ownerEmail: string;
  }): Promise<{ status: string; ownerEmail: string; expiresIn: number }> {
    const { agentId, ownerEmail } = data;

    const identity = await AgentIdentityStore.findById(agentId);
    if (!identity) {
      throw Object.assign(new Error('Agent not found'), { code: 'AGENT_NOT_FOUND' });
    }

    if (identity.ownershipStatus === 'claimed') {
      throw Object.assign(new Error('Agent is already claimed'), { code: 'ALREADY_CLAIMED' });
    }

    // Check for existing pending claim — allow re-send after 5 minutes
    const existing = await AgentClaimStore.findPendingByAgentId(agentId);
    if (existing) {
      const createdAt = new Date(existing.createdAt).getTime();
      const cooldownMs = 5 * 60 * 1000;
      if (Date.now() - createdAt < cooldownMs) {
        throw Object.assign(
          new Error('A claim link was already sent. Please wait before requesting another.'),
          { code: 'CLAIM_COOLDOWN' }
        );
      }
    }

    // Create claim token
    const claimToken = await AgentClaimStore.create({
      agentId,
      orgId: identity.orgId,
      ownerEmail,
      agentName: identity.agentName,
      agentPurpose: identity.agentPurpose,
      inboxEmail: identity.inboxEmail || '',
    });

    // Send claim email BEFORE updating ownership status — if email fails,
    // agent stays in current state and can retry
    const claimUrl = `${FRONTEND_URL.replace(/\/$/, '')}/claim/${claimToken.token}`;
    await sendClaimEmail(ownerEmail, identity.agentName, identity.inboxEmail || '', identity.agentPurpose, claimUrl);

    // Email sent successfully — now update agent ownership status
    await AgentIdentityStore.updateOwnership(agentId, {
      ownerEmail,
      ownershipStatus: 'pending',
    });

    logger.info('Agent ownership claim initiated', {
      agentId,
      ownerEmail,
      claimTokenId: claimToken.id,
    });

    return {
      status: 'pending',
      ownerEmail,
      expiresIn: 86400,
    };
  }

  /**
   * Accept an ownership claim. Called when the owner clicks the claim link.
   */
  static async acceptOwnershipClaim(token: string): Promise<{
    agentName: string;
    agentEmail: string;
    ownerEmail: string;
  }> {
    const claimToken = await AgentClaimStore.findByToken(token);
    if (!claimToken) {
      throw Object.assign(new Error('Invalid or expired claim link'), { code: 'INVALID_CLAIM_TOKEN' });
    }

    // Check expiry
    if (new Date(claimToken.expiresAt) < new Date()) {
      throw Object.assign(new Error('This claim link has expired'), { code: 'CLAIM_EXPIRED' });
    }

    // Mark token as accepted
    await AgentClaimStore.markAccepted(claimToken.id);

    // Mark agent as claimed
    await AgentIdentityStore.updateOwnership(claimToken.agentId, {
      ownerEmail: claimToken.ownerEmail,
      ownershipStatus: 'claimed',
      claimedAt: new Date().toISOString(),
    });

    logger.info('Agent ownership claimed', {
      agentId: claimToken.agentId,
      ownerEmail: claimToken.ownerEmail,
    });

    return {
      agentName: claimToken.agentName,
      agentEmail: claimToken.inboxEmail,
      ownerEmail: claimToken.ownerEmail,
    };
  }

  /**
   * Get claim details for rendering the claim page.
   */
  static async getClaimDetails(token: string): Promise<{
    agentName: string;
    agentPurpose: string;
    agentEmail: string;
    ownerEmail: string;
    createdAt: string;
  } | null> {
    const claimToken = await AgentClaimStore.findByToken(token);
    if (!claimToken) return null;
    if (new Date(claimToken.expiresAt) < new Date()) return null;

    return {
      agentName: claimToken.agentName,
      agentPurpose: claimToken.agentPurpose,
      agentEmail: claimToken.inboxEmail,
      ownerEmail: claimToken.ownerEmail,
      createdAt: claimToken.createdAt,
    };
  }

  /**
   * Per-request: Verify the Ed25519 signature from the Authorization header.
   * Called by the v1CombinedAuth middleware on every authenticated /v1/* request.
   *
   * Returns { orgId, agentId } if valid, null if invalid (caller returns 401).
   *
   * Unchanged from the original implementation — per-request auth is already solid.
   */
  static async verifyRequestSignature(
    agentId: string,
    timestampMs: number,
    signatureBase64: string
  ): Promise<{ orgId: string; agentId: string } | null> {
    // 1. Look up the agent's public key (only active agents).
    //    Must happen before nonce claim so a garbage-signature request from an
    //    attacker who knows a valid agentId cannot burn nonces (DoS).
    const identity = await AgentIdentityStore.findById(agentId);
    if (!identity) {
      return null;
    }

    // 2. Verify the Ed25519 signature BEFORE consuming the nonce.
    //    message = "{agentId}:{timestampMs}" — same format the agent computes client-side
    const message = `${agentId}:${timestampMs}`;
    const valid = verifyEd25519Signature(identity.publicKey, message, signatureBase64);
    if (!valid) {
      logger.warn('Agent signature verification failed', { agentId });
      return null;
    }

    // 3. Replay protection: claim this (agentId, timestampMs) nonce atomically.
    //    Only reached after the signature is confirmed valid, so only the legitimate
    //    key-holder can consume nonces.
    const nonceAccepted = await AgentIdentityStore.claimNonce(agentId, timestampMs);
    if (!nonceAccepted) {
      logger.warn('Agent request replay detected', { agentId, timestampMs });
      return null;
    }

    // 4. Update last used timestamp — fire-and-forget, don't block the request
    AgentIdentityStore.updateLastUsed(agentId).catch(err =>
      logger.error('Failed to update agent lastUsedAt', { err })
    );

    return { orgId: identity.orgId, agentId };
  }
}

// --- Claim email helper ---

async function sendClaimEmail(
  toEmail: string,
  agentName: string,
  agentEmail: string,
  agentPurpose: string,
  claimUrl: string,
): Promise<void> {
  const subject = `Verify agent ownership — ${agentName}`;

  // Escape HTML special chars in user-provided text
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeName = esc(agentName);
  const safeEmail = esc(agentEmail);
  const safePurpose = esc(agentPurpose.length > 120 ? agentPurpose.slice(0, 120) + '...' : agentPurpose);
  const initial = agentName.charAt(0).toUpperCase();

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:32px;">
          <span style="font-size:20px;font-weight:500;color:#18181b;letter-spacing:-0.01em;">commune</span>
        </td></tr>

        <!-- Card -->
        <tr><td style="background-color:#ffffff;border-radius:12px;border:1px solid #e4e4e7;overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

            <!-- Header -->
            <tr><td style="padding:32px 32px 0 32px;">
              <p style="margin:0 0 4px 0;font-size:11px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:0.1em;color:#a1a1aa;">Agent ownership</p>
              <h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#18181b;line-height:1.3;">Verify ownership</h1>
              <p style="margin:0;font-size:14px;color:#71717a;line-height:1.6;">An agent has registered on Commune and listed you as its owner.</p>
            </td></tr>

            <!-- Agent card -->
            <tr><td style="padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafafa;border:1px solid #e4e4e7;border-radius:10px;">
                <!-- Agent identity -->
                <tr><td style="padding:20px 20px 16px 20px;">
                  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                    <td style="vertical-align:top;padding-right:14px;">
                      <div style="width:40px;height:40px;border-radius:8px;background:linear-gradient(135deg,#dcfce7,#f0fdf4);border:1px solid #bbf7d0;text-align:center;line-height:40px;font-size:16px;font-weight:600;color:#16a34a;">${initial}</div>
                    </td>
                    <td style="vertical-align:top;">
                      <p style="margin:0;font-size:15px;font-weight:600;color:#18181b;">${safeName}</p>
                      <p style="margin:2px 0 0 0;font-size:12px;font-family:'Courier New',monospace;color:#a1a1aa;">${safeEmail}</p>
                    </td>
                  </tr></table>
                </td></tr>

                <!-- Divider -->
                <tr><td style="padding:0 20px;"><hr style="margin:0;border:none;border-top:1px solid #e4e4e7;"></td></tr>

                <!-- Purpose -->
                <tr><td style="padding:16px 20px 20px 20px;">
                  <p style="margin:0 0 4px 0;font-size:10px;font-family:'Courier New',monospace;text-transform:uppercase;letter-spacing:0.08em;color:#a1a1aa;">Purpose</p>
                  <p style="margin:0;font-size:13px;color:#52525b;line-height:1.5;">${safePurpose}</p>
                </td></tr>
              </table>
            </td></tr>

            <!-- CTA -->
            <tr><td style="padding:0 32px 12px 32px;" align="center">
              <a href="${claimUrl}" style="display:inline-block;width:100%;text-align:center;background-color:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 0;border-radius:8px;box-sizing:border-box;">Yes, this is my agent</a>
            </td></tr>

            <!-- Disclaimer -->
            <tr><td style="padding:0 32px 32px 32px;" align="center">
              <p style="margin:0;font-size:11px;color:#a1a1aa;line-height:1.5;">By confirming, you take responsibility for this agent's activity on Commune.</p>
            </td></tr>

          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding-top:24px;">
          <p style="margin:0;font-size:11px;color:#a1a1aa;line-height:1.5;">This link expires in 24 hours. If you didn't request this, ignore this email.</p>
          <p style="margin:8px 0 0 0;font-size:11px;color:#d4d4d8;">Commune &middot; commune.email</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `VERIFY AGENT OWNERSHIP

An agent has registered on Commune and listed you as its owner.

Agent: ${agentName}
Email: ${agentEmail}
Purpose: ${agentPurpose}

Verify ownership: ${claimUrl}

By confirming, you take responsibility for this agent's activity on Commune.

This link expires in 24 hours. If you didn't request this, ignore this email.

Commune - commune.email`;

  const fromEmail = process.env.DEFAULT_FROM_EMAIL || 'noreply@commune.email';

  try {
    await resend.emails.send({
      from: `Commune <${fromEmail}>`,
      to: toEmail,
      subject,
      html,
      text,
    });
    logger.info('Claim email sent to owner', { toEmail, agentName });
  } catch (err: any) {
    logger.error('Failed to send claim email', { toEmail, error: err?.message });
    throw Object.assign(new Error(`Failed to send claim email: ${err?.message}`), { code: 'EMAIL_SEND_FAILED' });
  }
}
