export type TierType = 'free' | 'agent_pro' | 'business' | 'enterprise';

export interface TierLimits {
  emailsPerHour: number;
  emailsPerDay: number;
  emailsPerInboxPerDay: number;
  domainsPerDay: number;
  inboxesPerDay: number;
  maxInboxes: number;
  maxCustomDomains: number;
  attachmentStorageBytes: number;
  features: {
    semanticSearch: boolean;
    structuredExtraction: boolean;
    senderReputation: boolean;
    promptInjection: boolean;
    encryptionAtRest: boolean;
    manualLimits: boolean;
    domainWarmup: boolean;
    auditLogging: boolean;
    sso: boolean;
  };
}

export const RATE_LIMITS: Record<TierType, TierLimits> = {
  free: {
    emailsPerHour: 10,
    emailsPerDay: 50,
    emailsPerInboxPerDay: 20,
    domainsPerDay: 0,
    inboxesPerDay: 2,
    maxInboxes: 2,
    maxCustomDomains: 0,
    attachmentStorageBytes: 100 * 1024 * 1024, // 100 MB
    features: {
      semanticSearch: false,
      structuredExtraction: false,
      senderReputation: false,
      promptInjection: false,
      encryptionAtRest: false,
      manualLimits: false,
      domainWarmup: false,
      auditLogging: false,
      sso: false,
    },
  },
  agent_pro: {
    emailsPerHour: 200,
    emailsPerDay: 1000,
    emailsPerInboxPerDay: 100,
    domainsPerDay: 3,
    inboxesPerDay: 10,
    maxInboxes: 25,
    maxCustomDomains: 3,
    attachmentStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: false,
      auditLogging: false,
      sso: false,
    },
  },
  business: {
    emailsPerHour: 1000,
    emailsPerDay: 5000,
    emailsPerInboxPerDay: 500,
    domainsPerDay: 5,
    inboxesPerDay: 25,
    maxInboxes: 100,
    maxCustomDomains: 10,
    attachmentStorageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: true,
      auditLogging: false,
      sso: false,
    },
  },
  enterprise: {
    emailsPerHour: 5000,
    emailsPerDay: 25000,
    emailsPerInboxPerDay: 1000,
    domainsPerDay: 10,
    inboxesPerDay: 50,
    maxInboxes: Infinity,
    maxCustomDomains: Infinity,
    attachmentStorageBytes: Infinity,
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: true,
      auditLogging: true,
      sso: true,
    },
  },
};

export const getOrgTierLimits = (tier: TierType = 'free'): TierLimits => {
  return RATE_LIMITS[tier] || RATE_LIMITS.free;
};

export const hasFeature = (tier: TierType, feature: keyof TierLimits['features']): boolean => {
  const limits = getOrgTierLimits(tier);
  return limits.features[feature];
};
