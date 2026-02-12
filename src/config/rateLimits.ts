export type TierType = 'free' | 'pro' | 'enterprise';

export interface TierLimits {
  emailsPerHour: number;
  emailsPerDay: number;
  domainsPerDay: number;
  inboxesPerDay: number;
}

export const RATE_LIMITS: Record<TierType, TierLimits> = {
  free: {
    emailsPerHour: 100,
    emailsPerDay: 1000,
    domainsPerDay: 5,
    inboxesPerDay: 50,
  },
  pro: {
    emailsPerHour: 10000,
    emailsPerDay: 100000,
    domainsPerDay: 50,
    inboxesPerDay: 500,
  },
  enterprise: {
    emailsPerHour: Infinity,
    emailsPerDay: Infinity,
    domainsPerDay: Infinity,
    inboxesPerDay: Infinity,
  },
};

export const getOrgTierLimits = (tier: TierType = 'free'): TierLimits => {
  return RATE_LIMITS[tier] || RATE_LIMITS.free;
};
