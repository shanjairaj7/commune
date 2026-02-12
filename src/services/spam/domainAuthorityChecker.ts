import logger from '../../utils/logger';
import dns from 'dns';
import { promisify } from 'util';

const resolveTxt = promisify(dns.resolveTxt);
const resolveMx = promisify(dns.resolveMx);

interface DomainAuthorityResult {
  domain: string;
  is_suspicious: boolean;
  authority_score: number; // 0-1, lower is more suspicious
  reasons: string[];
  metadata: {
    has_mx_records: boolean;
    has_spf: boolean;
    has_dmarc: boolean;
    domain_age_days?: number;
    is_newly_registered: boolean;
    has_valid_ssl: boolean;
  };
}

export class DomainAuthorityChecker {
  private static instance: DomainAuthorityChecker;

  // Known legitimate domains cache (to avoid repeated checks)
  private legitimateDomainCache = new Set<string>([
    'google.com', 'amazon.com', 'microsoft.com', 'apple.com',
    'facebook.com', 'paypal.com', 'netflix.com', 'linkedin.com',
    'twitter.com', 'instagram.com', 'youtube.com', 'github.com'
  ]);

  private constructor() {}

  public static getInstance(): DomainAuthorityChecker {
    if (!DomainAuthorityChecker.instance) {
      DomainAuthorityChecker.instance = new DomainAuthorityChecker();
    }
    return DomainAuthorityChecker.instance;
  }

  public async checkDomainAuthority(domain: string): Promise<DomainAuthorityResult> {
    const reasons: string[] = [];
    let authorityScore = 0.5; // Start neutral
    let isSuspicious = false;

    // Quick check for known legitimate domains
    if (this.legitimateDomainCache.has(domain)) {
      return {
        domain,
        is_suspicious: false,
        authority_score: 1.0,
        reasons: ['Known legitimate domain'],
        metadata: {
          has_mx_records: true,
          has_spf: true,
          has_dmarc: true,
          is_newly_registered: false,
          has_valid_ssl: true,
        },
      };
    }

    const metadata = {
      has_mx_records: false,
      has_spf: false,
      has_dmarc: false,
      domain_age_days: undefined as number | undefined,
      is_newly_registered: false,
      has_valid_ssl: false,
    };

    try {
      // 1. Check MX records (legitimate domains have email servers)
      try {
        const mxRecords = await resolveMx(domain);
        metadata.has_mx_records = mxRecords && mxRecords.length > 0;
        
        if (metadata.has_mx_records) {
          authorityScore += 0.15;
        } else {
          authorityScore -= 0.2;
          reasons.push('No MX records found');
          isSuspicious = true;
        }
      } catch (error) {
        authorityScore -= 0.2;
        reasons.push('No MX records found');
        isSuspicious = true;
      }

      // 2. Check SPF record
      try {
        const txtRecords = await resolveTxt(domain);
        const spfRecord = txtRecords.find(record =>
          record.some(txt => txt.startsWith('v=spf1'))
        );
        
        metadata.has_spf = !!spfRecord;
        
        if (metadata.has_spf) {
          authorityScore += 0.1;
        } else {
          authorityScore -= 0.15;
          reasons.push('No SPF record');
        }
      } catch (error) {
        authorityScore -= 0.15;
        reasons.push('No SPF record');
      }

      // 3. Check DMARC record
      try {
        const dmarcDomain = `_dmarc.${domain}`;
        const dmarcRecords = await resolveTxt(dmarcDomain);
        const dmarcRecord = dmarcRecords.find(record =>
          record.some(txt => txt.startsWith('v=DMARC1'))
        );
        
        metadata.has_dmarc = !!dmarcRecord;
        
        if (metadata.has_dmarc) {
          authorityScore += 0.1;
        } else {
          authorityScore -= 0.1;
          reasons.push('No DMARC record');
        }
      } catch (error) {
        authorityScore -= 0.1;
        reasons.push('No DMARC record');
      }

      // 4. Check SSL certificate validity
      metadata.has_valid_ssl = await this.checkSSLCertificate(domain);
      
      if (metadata.has_valid_ssl) {
        authorityScore += 0.15;
      } else {
        authorityScore -= 0.2;
        reasons.push('No valid SSL certificate');
        isSuspicious = true;
      }

      // 5. Check domain structure
      const structureIssues = this.checkDomainStructure(domain);
      if (structureIssues.length > 0) {
        authorityScore -= 0.2;
        reasons.push(...structureIssues);
        isSuspicious = true;
      }

      // 6. Check for suspicious patterns
      const suspiciousPatterns = this.checkSuspiciousPatterns(domain);
      if (suspiciousPatterns.length > 0) {
        authorityScore -= 0.25;
        reasons.push(...suspiciousPatterns);
        isSuspicious = true;
      }

      // Normalize score
      authorityScore = Math.max(0, Math.min(1, authorityScore));

      // Determine if suspicious based on score
      if (authorityScore < 0.3) {
        isSuspicious = true;
      }

      return {
        domain,
        is_suspicious: isSuspicious,
        authority_score: authorityScore,
        reasons: reasons.length > 0 ? reasons : ['Domain appears legitimate'],
        metadata,
      };
    } catch (error) {
      logger.error('Domain authority check error:', error);
      
      return {
        domain,
        is_suspicious: true,
        authority_score: 0,
        reasons: ['Unable to verify domain'],
        metadata,
      };
    }
  }

  private async checkSSLCertificate(domain: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok || response.status < 500;
    } catch (error) {
      return false;
    }
  }

  private checkDomainStructure(domain: string): string[] {
    const issues: string[] = [];

    // Check for excessive length
    if (domain.length > 50) {
      issues.push('Unusually long domain name');
    }

    // Check for excessive hyphens
    const hyphenCount = (domain.match(/-/g) || []).length;
    if (hyphenCount > 3) {
      issues.push('Excessive hyphens in domain');
    }

    // Check for numbers in suspicious positions
    if (/\d{3,}/.test(domain)) {
      issues.push('Contains multiple consecutive numbers');
    }

    // Check for mixed case (unusual for domains)
    if (domain !== domain.toLowerCase() && domain !== domain.toUpperCase()) {
      issues.push('Mixed case in domain');
    }

    return issues;
  }

  private checkSuspiciousPatterns(domain: string): string[] {
    const patterns: string[] = [];

    // Common phishing patterns
    const phishingPatterns = [
      /secure.*login/i,
      /verify.*account/i,
      /update.*payment/i,
      /confirm.*identity/i,
      /banking.*secure/i,
      /account.*suspended/i,
      /urgent.*action/i,
      /validate.*info/i,
    ];

    for (const pattern of phishingPatterns) {
      if (pattern.test(domain)) {
        patterns.push('Domain contains phishing-related keywords');
        break;
      }
    }

    // Check for random-looking strings
    const parts = domain.split('.');
    for (const part of parts) {
      if (part.length > 15 && this.looksRandom(part)) {
        patterns.push('Domain contains random-looking strings');
        break;
      }
    }

    // Check for character substitution patterns
    if (/[0-9]/.test(domain) && /[a-z]/i.test(domain)) {
      const substitutions = ['0' + 'o', '1' + 'l', '3' + 'e', '5' + 's', '8' + 'b'];
      for (const sub of substitutions) {
        if (domain.includes(sub[0])) {
          patterns.push('Possible character substitution detected');
          break;
        }
      }
    }

    return patterns;
  }

  private looksRandom(str: string): boolean {
    // Check for lack of vowels (random strings often have few vowels)
    const vowels = str.match(/[aeiou]/gi) || [];
    const vowelRatio = vowels.length / str.length;

    if (vowelRatio < 0.2) {
      return true;
    }

    // Check for repeating patterns
    const uniqueChars = new Set(str.split('')).size;
    if (uniqueChars / str.length < 0.4) {
      return true;
    }

    return false;
  }

  public async checkMultipleDomains(domains: string[]): Promise<DomainAuthorityResult[]> {
    // Check domains in parallel with a limit
    const results: DomainAuthorityResult[] = [];
    const batchSize = 5;

    for (let i = 0; i < domains.length; i += batchSize) {
      const batch = domains.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(domain => this.checkDomainAuthority(domain))
      );
      results.push(...batchResults);
    }

    return results;
  }
}
