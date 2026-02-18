import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AgentIdentityService } from '../../services/agentIdentityService';
import logger from '../../utils/logger';

const router = Router();

// 3 registration attempts per IP per hour
const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many registration attempts. Try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 10 OTP verify attempts per IP per 15 minutes
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
 * Agent sends public key + metadata. Returns agentSignupToken.
 * OTP sent to verifierEmail (human owner).
 *
 * Body:
 *   agentName:     string   — display name for this agent
 *   agentEmail:    string   — agent's email address
 *   orgName:       string   — organization name
 *   orgSlug:       string   — organization URL slug (unique)
 *   publicKey:     string   — base64-encoded raw 32-byte Ed25519 public key
 *   verifierEmail: string   — human owner's email (receives OTP)
 */
router.post('/agent-register', registerRateLimit, async (req: Request, res: Response) => {
  const { agentName, agentEmail, orgName, orgSlug, publicKey, verifierEmail } = req.body;

  if (!agentName || !agentEmail || !orgName || !orgSlug || !publicKey || !verifierEmail) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentName, agentEmail, orgName, orgSlug, publicKey, verifierEmail',
    });
  }

  // Base64 of exactly 32 bytes = 43 data chars + 1 trailing '=' = 44 chars total
  // Service re-validates by actually decoding and checking byte length
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
      agentEmail: agentEmail.trim().toLowerCase(),
      orgName: orgName.trim(),
      orgSlug: orgSlug.trim().toLowerCase(),
      publicKey,
      verifierEmail: verifierEmail.trim().toLowerCase(),
    });

    return res.status(201).json({
      agentSignupToken: result.agentSignupToken,
      message: `A 6-digit OTP has been sent to ${verifierEmail}. Submit it to POST /v1/auth/agent-verify.`,
      expiresIn: result.expiresIn,
    });
  } catch (err: any) {
    if (err.code === 'INVALID_PUBLIC_KEY') {
      return res.status(400).json({ error: 'invalid_public_key', message: err.message });
    }
    if (err.code === 'EMAIL_EXISTS') {
      return res.status(409).json({ error: 'email_exists', message: 'This email is already registered' });
    }
    if (err.message?.includes('Organization slug already exists')) {
      return res.status(409).json({ error: 'slug_exists', message: 'This org slug is already taken' });
    }
    logger.error('Agent registration error', { err });
    return res.status(500).json({ error: 'registration_failed', message: 'Registration failed' });
  }
});

/**
 * POST /v1/auth/agent-verify
 *
 * Agent submits the OTP that the human verifier received.
 * Returns agentId (COMMUNE_AGENT_ID) to store permanently.
 *
 * Body:
 *   agentSignupToken: string — from the /agent-register response
 *   otp:              string — 6-digit code from verifier's email
 */
router.post('/agent-verify', verifyRateLimit, async (req: Request, res: Response) => {
  const { agentSignupToken, otp } = req.body;

  if (!agentSignupToken || !otp) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentSignupToken, otp',
    });
  }

  if (!/^\d{6}$/.test(String(otp))) {
    return res.status(400).json({
      error: 'invalid_otp_format',
      message: 'OTP must be a 6-digit number',
    });
  }

  try {
    const result = await AgentIdentityService.verifyAgentOtp({
      agentSignupToken,
      otp: String(otp),
    });

    return res.status(200).json({
      agentId: result.agentId,
      orgId: result.orgId,
      message: [
        'Registration complete. Store these environment variables:',
        `  export COMMUNE_AGENT_ID="${result.agentId}"`,
        '  export COMMUNE_PRIVATE_KEY="<your_private_key_base64>"',
        '',
        'Sign every request with: Authorization: Agent {COMMUNE_AGENT_ID}:{ed25519_signature}',
      ].join('\n'),
    });
  } catch (err: any) {
    if (err.code === 'INVALID_TOKEN') {
      return res.status(401).json({ error: 'invalid_token', message: 'Invalid or expired signup token' });
    }
    if (err.code === 'MAX_ATTEMPTS') {
      return res.status(429).json({ error: 'max_attempts', message: err.message });
    }
    if (err.code === 'INVALID_OTP') {
      return res.status(401).json({ error: 'invalid_otp', message: err.message });
    }
    logger.error('Agent OTP verification error', { err });
    return res.status(500).json({ error: 'verification_failed', message: 'Verification failed' });
  }
});

export default router;
