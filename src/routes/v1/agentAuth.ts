import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AgentIdentityService } from '../../services/agentIdentityService';
import logger from '../../utils/logger';

const router = Router();

// 5 registrations per IP per day — each requires a unique keypair + signs a challenge,
// making mass registration expensive. Legitimate agents need very few registrations.
const registerRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 10 challenge-verify attempts per IP per 15 minutes
const verifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many verification attempts.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /v1/auth/agent-register
 *
 * Agent sends public key + org details.
 * Returns agentSignupToken + a challenge the agent must sign with their private key.
 * No email required. No human verifier.
 *
 * Body:
 *   agentName:  string — display name for this agent
 *   orgName:    string — organization name
 *   orgSlug:    string — organization URL slug (unique, becomes inbox localPart)
 *   publicKey:  string — base64-encoded raw 32-byte Ed25519 public key
 *
 * Anti-spam: each public key can only register once; rate limited 5/IP/day;
 * verification requires signing the challenge with the matching private key.
 */
router.post('/agent-register', registerRateLimit, async (req: Request, res: Response) => {
  const { agentName, orgName, orgSlug, publicKey } = req.body;

  if (!agentName || !orgName || !orgSlug || !publicKey) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentName, orgName, orgSlug, publicKey',
    });
  }

  // Base64 of exactly 32 bytes = 43 data chars + 1 trailing '=' = 44 chars total
  if (typeof publicKey !== 'string' || publicKey.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
    return res.status(400).json({
      error: 'invalid_public_key',
      message: 'publicKey must be a base64-encoded 32-byte Ed25519 public key (44 characters, standard base64 with trailing =)',
    });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(orgSlug)) {
    return res.status(400).json({
      error: 'invalid_org_slug',
      message: 'orgSlug may only contain letters, numbers, hyphens, and underscores',
    });
  }

  try {
    const result = await AgentIdentityService.registerAgent({
      agentName: agentName.trim(),
      orgName: orgName.trim(),
      orgSlug: orgSlug.trim().toLowerCase(),
      publicKey,
    });

    return res.status(201).json({
      agentSignupToken: result.agentSignupToken,
      challenge: result.challenge,
      message: 'Sign the challenge with your private key and submit to POST /v1/auth/agent-verify.',
      expiresIn: 900,
    });
  } catch (err: any) {
    if (err.code === 'INVALID_PUBLIC_KEY') {
      return res.status(400).json({ error: 'invalid_public_key', message: err.message });
    }
    if (err.message?.includes('Organization slug already exists') || err.message?.includes('slug')) {
      return res.status(409).json({ error: 'slug_exists', message: 'This org slug is already taken' });
    }
    logger.error('Agent registration error', { err });
    return res.status(500).json({ error: 'registration_failed', message: 'Registration failed' });
  }
});

/**
 * POST /v1/auth/agent-verify
 *
 * Agent signs the challenge from /agent-register with their private key and submits it.
 * Server verifies the signature against the stored public key.
 * On success: activates account, auto-provisions inbox at orgSlug@commune.email, returns agentId.
 *
 * Body:
 *   agentSignupToken: string — from the /agent-register response
 *   signature:        string — base64 Ed25519 signature of the challenge string
 */
router.post('/agent-verify', verifyRateLimit, async (req: Request, res: Response) => {
  const { agentSignupToken, signature } = req.body;

  if (!agentSignupToken || !signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentSignupToken, signature',
    });
  }

  if (typeof signature !== 'string') {
    return res.status(400).json({
      error: 'invalid_signature_format',
      message: 'signature must be a base64-encoded Ed25519 signature string',
    });
  }

  try {
    const result = await AgentIdentityService.verifyAgentChallenge({
      agentSignupToken,
      signature,
    });

    return res.status(200).json({
      agentId: result.agentId,
      orgId: result.orgId,
      inboxEmail: result.inboxEmail,
      message: [
        'Registration complete. Store these permanently:',
        `  export COMMUNE_AGENT_ID="${result.agentId}"`,
        '  export COMMUNE_PRIVATE_KEY="<your_private_key_base64>"',
        '',
        `Your inbox is ready: ${result.inboxEmail}`,
        'Sign every request: Authorization: Agent {COMMUNE_AGENT_ID}:{ed25519_signature}',
      ].join('\n'),
    });
  } catch (err: any) {
    if (err.code === 'INVALID_TOKEN') {
      return res.status(401).json({ error: 'invalid_token', message: 'Invalid or expired signup token' });
    }
    if (err.code === 'INVALID_SIGNATURE') {
      return res.status(401).json({ error: 'invalid_signature', message: err.message });
    }
    logger.error('Agent challenge verification error', { err });
    return res.status(500).json({ error: 'verification_failed', message: 'Verification failed' });
  }
});

export default router;
