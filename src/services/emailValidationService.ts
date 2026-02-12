import dns from 'dns/promises';
import validator from 'validator';
import disposableDomains from 'disposable-email-domains';
import { getRedisClient, isRedisAvailable } from '../lib/redis';
import logger from '../utils/logger';

export interface EmailValidationIssue {
  email: string;
  reason: string;
  detail?: string;
}

export interface EmailValidationSummary {
  valid: string[];
  rejected: EmailValidationIssue[];
  warnings: EmailValidationIssue[];
  suppressed?: string[];
  duration_ms: number;
  checked_domains: number;
  cached_domains: number;
}

type DomainCheckResult = {
  status: 'valid' | 'invalid' | 'unknown';
  reason?: string;
  cached?: boolean;
};

const ROLE_BASED_LOCAL_PARTS = new Set([
  'admin',
  'administrator',
  'abuse',
  'postmaster',
  'support',
  'help',
  'info',
  'sales',
  'marketing',
  'billing',
  'security',
  'privacy',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'root',
  'webmaster',
  'hostmaster',
  'contact',
  'team',
]);

const MX_CACHE_TTL_SECONDS = Number(process.env.MX_CACHE_TTL_SECONDS || 300);
const DNS_TIMEOUT_MS = Number(process.env.MX_LOOKUP_TIMEOUT_MS || 1200);

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs);
    }),
  ]);
};

class EmailValidationService {
  private static instance: EmailValidationService;
  private disposableSet: Set<string>;
  private memoryCache: Map<string, { valid: boolean; expiresAt: number }> = new Map();
  private readonly MAX_CACHE_SIZE = 10_000;

  private constructor() {
    const domainList = Array.isArray(disposableDomains) ? disposableDomains : [];
    this.disposableSet = new Set(domainList.map((domain) => normalizeDomain(domain)));

    // Periodic cache cleanup every 5 minutes — evict expired entries
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.memoryCache.entries()) {
        if (entry.expiresAt <= now) {
          this.memoryCache.delete(key);
        }
      }
    }, 5 * 60 * 1000);
  }

  public static getInstance(): EmailValidationService {
    if (!EmailValidationService.instance) {
      EmailValidationService.instance = new EmailValidationService();
    }
    return EmailValidationService.instance;
  }

  public async validateRecipients(emails: string[]): Promise<EmailValidationSummary> {
    const start = Date.now();
    const rejected: EmailValidationIssue[] = [];
    const warnings: EmailValidationIssue[] = [];

    const seen = new Set<string>();
    const validCandidates: Array<{ email: string; local: string; domain: string; baseLocal: string }> = [];

    for (const email of emails) {
      const parsed = this.parseEmail(email);
      if (!parsed) {
        rejected.push({ email: email.trim(), reason: 'invalid_syntax' });
        continue;
      }
      if (seen.has(parsed.email)) continue;
      seen.add(parsed.email);
      validCandidates.push(parsed);
    }

    const domainMap = new Map<string, Array<{ email: string; local: string; baseLocal: string }>>();
    for (const candidate of validCandidates) {
      const list = domainMap.get(candidate.domain) || [];
      list.push({ email: candidate.email, local: candidate.local, baseLocal: candidate.baseLocal });
      domainMap.set(candidate.domain, list);
    }

    const domainEntries = Array.from(domainMap.entries());
    const domainChecks = await Promise.all(
      domainEntries.map(async ([domain]) => {
        const result = await this.checkDomainMx(domain);
        return { domain, result };
      })
    );

    const domainResultMap = new Map(domainChecks.map(({ domain, result }) => [domain, result]));

    const valid: string[] = [];
    let cachedDomains = 0;

    for (const [domain, recipients] of domainMap.entries()) {
      const check = domainResultMap.get(domain);
      if (check?.cached) {
        cachedDomains += 1;
      }

      for (const recipient of recipients) {
        if (check?.status === 'invalid') {
          rejected.push({ email: recipient.email, reason: 'no_mx', detail: check.reason });
          continue;
        }

        if (check?.status === 'unknown') {
          warnings.push({
            email: recipient.email,
            reason: 'mx_check_timeout',
            detail: 'DNS timeout - allowed send but validation incomplete',
          });
        }

        if (this.disposableSet.has(domain)) {
          warnings.push({ email: recipient.email, reason: 'disposable_domain', detail: domain });
        }

        if (ROLE_BASED_LOCAL_PARTS.has(recipient.baseLocal)) {
          warnings.push({ email: recipient.email, reason: 'role_address', detail: recipient.baseLocal });
        }

        valid.push(recipient.email);
      }
    }

    return {
      valid,
      rejected,
      warnings,
      duration_ms: Date.now() - start,
      checked_domains: domainEntries.length,
      cached_domains: cachedDomains,
    };
  }

  private parseEmail(email: string): { email: string; local: string; baseLocal: string; domain: string } | null {
    const trimmed = email.trim();
    if (!trimmed) return null;

    const isValid = validator.isEmail(trimmed, {
      allow_utf8_local_part: false,
      allow_ip_domain: false,
      domain_specific_validation: false,
      allow_display_name: false,
    });

    if (!isValid) {
      return null;
    }

    const [localRaw, domainRaw] = trimmed.split('@');
    if (!localRaw || !domainRaw) return null;

    const local = localRaw.toLowerCase();
    const domain = normalizeDomain(domainRaw);

    if (local.length > 64 || domain.length > 255) return null;
    if (!validator.isFQDN(domain, { require_tld: true, allow_underscores: false })) return null;

    const baseLocal = local.split('+')[0];

    return {
      email: `${local}@${domain}`,
      local,
      baseLocal,
      domain,
    };
  }

  private async checkDomainMx(domain: string): Promise<DomainCheckResult> {
    const cached = await this.getCachedMx(domain);
    if (cached) {
      return { status: cached.valid ? 'valid' : 'invalid', cached: true };
    }

    try {
      const mxRecords = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
      if (Array.isArray(mxRecords) && mxRecords.length > 0) {
        await this.setCachedMx(domain, true);
        return { status: 'valid' };
      }

      const hasA = await this.checkARecords(domain);
      await this.setCachedMx(domain, hasA);
      return { status: hasA ? 'valid' : 'invalid', reason: 'no_mx_or_a' };
    } catch (error) {
      if (error instanceof Error && error.message === 'DNS_TIMEOUT') {
        return { status: 'unknown', reason: 'timeout' };
      }

      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === 'ENOTFOUND' || errorCode === 'ENODATA') {
        await this.setCachedMx(domain, false);
        return { status: 'invalid', reason: errorCode };
      }

      logger.warn('MX lookup failed', { domain, error: errorCode || error });
      return { status: 'unknown', reason: 'mx_lookup_error' };
    }
  }

  private async checkARecords(domain: string): Promise<boolean> {
    try {
      const [ipv4, ipv6] = await Promise.all([
        withTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS).catch(() => []),
        withTimeout(dns.resolve6(domain), DNS_TIMEOUT_MS).catch(() => []),
      ]);

      return (Array.isArray(ipv4) && ipv4.length > 0) || (Array.isArray(ipv6) && ipv6.length > 0);
    } catch {
      return false;
    }
  }

  private async getCachedMx(domain: string): Promise<{ valid: boolean } | null> {
    const now = Date.now();
    const memoryEntry = this.memoryCache.get(domain);
    if (memoryEntry && memoryEntry.expiresAt > now) {
      return { valid: memoryEntry.valid };
    }

    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      const cached = await redis.get(`mx:${domain}`);
      if (cached === '1' || cached === '0') {
        const valid = cached === '1';
        this.memoryCache.set(domain, { valid, expiresAt: now + MX_CACHE_TTL_SECONDS * 1000 });
        return { valid };
      }
    }

    return null;
  }

  private async setCachedMx(domain: string, valid: boolean): Promise<void> {
    const now = Date.now();
    // Evict oldest entries if cache is at capacity
    if (this.memoryCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(domain, { valid, expiresAt: now + MX_CACHE_TTL_SECONDS * 1000 });

    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      await redis.set(`mx:${domain}`, valid ? '1' : '0', 'EX', MX_CACHE_TTL_SECONDS);
    }
  }
}

export default EmailValidationService;
