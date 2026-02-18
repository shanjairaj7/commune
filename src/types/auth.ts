export type OrgTier = 'free' | 'agent_pro' | 'business' | 'enterprise';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: OrgTier;
  settings: {
    allowedDomains?: string[];
    emailVerificationRequired?: boolean;
    maxApiKeys?: number;
    maxUsers?: number;
  };
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt: string;
  // Stripe billing
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  billing_cycle?: 'monthly' | 'yearly';
  plan_updated_at?: string;
  // Usage tracking
  attachment_storage_used_bytes?: number;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  status: 'active' | 'inactive' | 'pending';
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: string;
  passwordHash: string;
  provider?: 'email' | 'google';
  googleId?: string;
  avatarUrl?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  permissions: string[];
  status: 'active' | 'inactive' | 'expired';
  lastUsedAt?: string;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  limits?: {
    maxInboxes?: number;
    maxEmailsPerDay?: number;
  };
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  token: string;
  email: string;
  purpose: 'verification' | 'password_reset' | 'login';
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastAccessAt: string;
  createdAt: string;
}

// Agent signing standard types

export interface AgentIdentity {
  id: string;           // "agt_<32hex>" — stored as COMMUNE_AGENT_ID by the agent
  agentName: string;
  inboxEmail?: string;  // auto-provisioned at registration: orgSlug@commune.email
  publicKey: string;    // base64-encoded raw 32-byte Ed25519 public key
  orgId: string;
  userId: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AgentSignup {
  id: string;
  agentSignupToken: string; // opaque token returned to agent after POST /v1/auth/agent-register
  agentName: string;
  orgName: string;
  orgSlug: string;
  publicKey: string;    // base64-encoded public key — used to verify the challenge signature
  challenge: string;    // server-issued random nonce the agent must sign with their private key
  status: 'pending' | 'verified' | 'expired';
  expiresAt: string;    // 15-minute TTL
  createdAt: string;
  // Set atomically during registerAgent so verifyAgentChallenge never needs a second DB fetch
  userId: string;
  orgId: string;
}

export interface AgentSignatureNonce {
  _id: string;    // "{agentId}:{timestampMs}" — unique constraint is the replay guard
  expiresAt: Date;
}
