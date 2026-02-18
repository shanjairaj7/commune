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
