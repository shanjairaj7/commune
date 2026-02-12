import logger from '../../utils/logger';

interface BrandPattern {
  name: string;
  domains: string[];
  keywords: string[];
  commonTypos: string[];
}

interface PhishingAnalysis {
  is_phishing: boolean;
  confidence: number;
  reasons: string[];
  detected_brand?: string;
  suspicious_domains: string[];
}

export class PhishingDetector {
  private static instance: PhishingDetector;

  // Major brands that are commonly impersonated
  private brandPatterns: BrandPattern[] = [
    {
      name: 'Amazon',
      domains: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.ca', 'amazon.in'],
      keywords: ['amazon', 'aws', 'prime'],
      commonTypos: ['amaz0n', 'amazom', 'arnazon', 'amazan', 'amzon', 'amazone']
    },
    {
      name: 'PayPal',
      domains: ['paypal.com', 'paypal.me'],
      keywords: ['paypal', 'pay pal'],
      commonTypos: ['paypa1', 'paypai', 'paypa', 'paypall', 'paypel']
    },
    {
      name: 'Apple',
      domains: ['apple.com', 'icloud.com', 'me.com'],
      keywords: ['apple', 'icloud', 'appleid', 'itunes', 'app store'],
      commonTypos: ['app1e', 'appl3', 'appie', 'aple']
    },
    {
      name: 'Microsoft',
      domains: ['microsoft.com', 'outlook.com', 'live.com', 'hotmail.com', 'office.com', 'xbox.com'],
      keywords: ['microsoft', 'outlook', 'office', 'windows', 'azure'],
      commonTypos: ['micros0ft', 'microsft', 'micosoft', 'microsof']
    },
    {
      name: 'Google',
      domains: ['google.com', 'gmail.com', 'youtube.com', 'drive.google.com'],
      keywords: ['google', 'gmail', 'youtube', 'drive'],
      commonTypos: ['goog1e', 'gooogle', 'googel', 'gogle', 'googie']
    },
    {
      name: 'Facebook',
      domains: ['facebook.com', 'fb.com', 'messenger.com', 'instagram.com', 'whatsapp.com'],
      keywords: ['facebook', 'instagram', 'whatsapp', 'messenger'],
      commonTypos: ['faceb00k', 'facebok', 'facbook', 'fecebook']
    },
    {
      name: 'Bank of America',
      domains: ['bankofamerica.com', 'bofa.com'],
      keywords: ['bank of america', 'bofa'],
      commonTypos: ['bankofamerica', 'bankamerica']
    },
    {
      name: 'Chase',
      domains: ['chase.com', 'jpmorganchase.com'],
      keywords: ['chase', 'jpmorgan'],
      commonTypos: ['chas3', 'chasse']
    },
    {
      name: 'Wells Fargo',
      domains: ['wellsfargo.com'],
      keywords: ['wells fargo', 'wellsfargo'],
      commonTypos: ['wellsfarg0', 'welsfargo']
    },
    {
      name: 'Netflix',
      domains: ['netflix.com'],
      keywords: ['netflix'],
      commonTypos: ['netfl1x', 'netflex', 'netfix']
    },
    {
      name: 'LinkedIn',
      domains: ['linkedin.com'],
      keywords: ['linkedin'],
      commonTypos: ['linkedln', 'linkdin', 'linkedn']
    },
    {
      name: 'DHL',
      domains: ['dhl.com', 'dhl.de'],
      keywords: ['dhl', 'delivery'],
      commonTypos: ['dh1', 'dhI']
    },
    {
      name: 'FedEx',
      domains: ['fedex.com'],
      keywords: ['fedex', 'fed ex'],
      commonTypos: ['fedx', 'fed3x', 'fedexp']
    },
    {
      name: 'UPS',
      domains: ['ups.com'],
      keywords: ['ups', 'united parcel'],
      commonTypos: ['up5', 'upss']
    }
  ];

  private constructor() {}

  public static getInstance(): PhishingDetector {
    if (!PhishingDetector.instance) {
      PhishingDetector.instance = new PhishingDetector();
    }
    return PhishingDetector.instance;
  }

  public async analyzeForPhishing(
    emailContent: string,
    emailSubject: string,
    urls: string[]
  ): Promise<PhishingAnalysis> {
    const reasons: string[] = [];
    const suspiciousDomains: string[] = [];
    let isPhishing = false;
    let confidence = 0;
    let detectedBrand: string | undefined;

    // Combine subject and content for analysis
    const fullText = `${emailSubject} ${emailContent}`.toLowerCase();

    // Check if this is a legitimate automated email
    if (this.isLegitimateAutomatedEmail(fullText, urls)) {
      return {
        is_phishing: false,
        confidence: 0,
        reasons: ['Legitimate automated email pattern detected'],
        suspicious_domains: [],
      };
    }

    // 1. Detect brand mentions in email
    const mentionedBrands = this.detectBrandMentions(fullText);

    // If no brands mentioned, skip brand-based phishing detection
    if (mentionedBrands.length === 0) {
      // Still check for generic phishing patterns
      const genericPhishingDomains = this.detectGenericPhishingPatterns(urls);
      if (genericPhishingDomains.length > 0) {
        isPhishing = true;
        confidence = 0.6; // Lower confidence without brand context
        suspiciousDomains.push(...genericPhishingDomains);
        reasons.push('Generic phishing patterns detected in domains');
      }

      // Check other indicators
      const suspiciousTLDs = this.checkSuspiciousTLDs(urls);
      if (suspiciousTLDs.length > 0) {
        confidence += 0.1;
        reasons.push(`Suspicious TLDs detected: ${suspiciousTLDs.join(', ')}`);
      }

      const ipUrls = urls.filter(url => this.containsIPAddress(url));
      if (ipUrls.length > 0) {
        isPhishing = true;
        confidence = Math.max(confidence, 0.85);
        suspiciousDomains.push(...ipUrls);
        reasons.push('URLs contain IP addresses instead of domain names');
      }

      const homographDomains = this.detectHomographAttacks(urls);
      if (homographDomains.length > 0) {
        isPhishing = true;
        confidence = 0.95;
        suspiciousDomains.push(...homographDomains);
        reasons.push('Homograph attack detected (Unicode lookalike characters)');
      }

      return {
        is_phishing: isPhishing,
        confidence: Math.min(confidence, 1),
        reasons: reasons.length > 0 ? reasons : [],
        suspicious_domains: [...new Set(suspiciousDomains)],
      };
    }

    // Brand-based phishing detection
    if (mentionedBrands.length > 0) {
      // 2. Check if URLs match the mentioned brands
      for (const brand of mentionedBrands) {
        const brandPattern = this.brandPatterns.find(b => b.name === brand);
        if (!brandPattern) continue;

        const legitimateDomains = brandPattern.domains;
        const urlDomains = urls.map(url => this.extractDomain(url)).filter(Boolean) as string[];

        // Check if any URL is from the legitimate brand domain
        const hasLegitDomain = urlDomains.some(domain =>
          legitimateDomains.some(legitDomain => domain === legitDomain || domain.endsWith(`.${legitDomain}`))
        );

        if (!hasLegitDomain && urlDomains.length > 0) {
          // Brand mentioned but no legitimate domain links
          // Check if this could be a legitimate third-party service
          const isLegitThirdParty = this.isLegitimateThirdPartyService(urlDomains, brand);
          
          if (isLegitThirdParty) {
            // Legitimate third-party service, not phishing
            continue;
          }

          isPhishing = true;
          confidence = 0.7; // Reduced from 0.8 to be more conservative
          detectedBrand = brand;
          reasons.push(`Email mentions ${brand} but contains no official ${brand} links`);

          // 3. Check for typosquatting
          const typosquattedDomains = this.detectTyposquatting(urlDomains, brandPattern);
          if (typosquattedDomains.length > 0) {
            isPhishing = true;
            confidence = 0.95;
            suspiciousDomains.push(...typosquattedDomains);
            reasons.push(`Typosquatted domains detected: ${typosquattedDomains.join(', ')}`);
          }

          // 4. Check for brand name in suspicious domains
          const brandInDomain = urlDomains.filter(domain =>
            brandPattern.keywords.some(keyword => domain.includes(keyword.replace(/\s/g, '')))
          );

          if (brandInDomain.length > 0) {
            isPhishing = true;
            confidence = 0.9;
            suspiciousDomains.push(...brandInDomain);
            reasons.push(`Suspicious domains containing brand name: ${brandInDomain.join(', ')}`);
          }
        }
      }
    }

    // 5. Check for generic phishing patterns in URLs
    const genericPhishingDomains = this.detectGenericPhishingPatterns(urls);
    if (genericPhishingDomains.length > 0) {
      isPhishing = true;
      confidence = Math.max(confidence, 0.75);
      suspiciousDomains.push(...genericPhishingDomains);
      reasons.push(`Generic phishing patterns detected in domains`);
    }

    // 6. Check for suspicious TLDs
    const suspiciousTLDs = this.checkSuspiciousTLDs(urls);
    if (suspiciousTLDs.length > 0) {
      confidence += 0.1;
      reasons.push(`Suspicious TLDs detected: ${suspiciousTLDs.join(', ')}`);
    }

    // 7. Check for IP addresses in URLs
    const ipUrls = urls.filter(url => this.containsIPAddress(url));
    if (ipUrls.length > 0) {
      isPhishing = true;
      confidence = Math.max(confidence, 0.85);
      suspiciousDomains.push(...ipUrls);
      reasons.push(`URLs contain IP addresses instead of domain names`);
    }

    // 8. Check for excessive subdomains (subdomain hijacking)
    const excessiveSubdomains = this.checkExcessiveSubdomains(urls);
    if (excessiveSubdomains.length > 0) {
      confidence += 0.15;
      reasons.push(`Suspicious subdomain structure detected`);
    }

    // 9. Check for homograph attacks (Unicode lookalikes)
    const homographDomains = this.detectHomographAttacks(urls);
    if (homographDomains.length > 0) {
      isPhishing = true;
      confidence = 0.95;
      suspiciousDomains.push(...homographDomains);
      reasons.push(`Homograph attack detected (Unicode lookalike characters)`);
    }

    return {
      is_phishing: isPhishing,
      confidence: Math.min(confidence, 1),
      reasons,
      detected_brand: detectedBrand,
      suspicious_domains: [...new Set(suspiciousDomains)],
    };
  }

  private detectBrandMentions(text: string): string[] {
    const mentioned: string[] = [];

    for (const brand of this.brandPatterns) {
      // Check for strong brand signals (not just casual mentions)
      const strongSignals = [
        // Brand name explicitly mentioned with action words
        new RegExp(`(from|dear|hello)\\s+${brand.name}`, 'i'),
        new RegExp(`${brand.name}\\s+(team|support|security|account|customer service)`, 'i'),
        new RegExp(`your\\s+${brand.name}\\s+(account|order|payment|subscription)`, 'i'),
      ];

      // Check brand-specific keywords with strong context
      // Exclude generic terms that might appear in device descriptions
      const contextualKeywords = brand.keywords.filter(k => {
        // Skip generic OS names unless in strong context
        if (['windows', 'office'].includes(k.toLowerCase())) {
          return false;
        }
        return true;
      });

      const keywordSignals = contextualKeywords.map(k => 
        new RegExp(`\\b${k}\\b.*\\b(account|order|payment|verify|confirm|subscription)`, 'i')
      );

      const hasStrongSignal = strongSignals.some(pattern => pattern.test(text)) ||
                              keywordSignals.some(pattern => pattern.test(text));
      
      if (hasStrongSignal) {
        mentioned.push(brand.name);
      }
    }

    return mentioned;
  }

  private extractDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private detectTyposquatting(domains: string[], brandPattern: BrandPattern): string[] {
    const typosquatted: string[] = [];

    for (const domain of domains) {
      // Check against known typos
      const hasTypo = brandPattern.commonTypos.some(typo =>
        domain.includes(typo)
      );

      if (hasTypo) {
        typosquatted.push(domain);
        continue;
      }

      // Check for character substitution (0 for o, 1 for l, etc.)
      for (const legitDomain of brandPattern.domains) {
        const similarity = this.calculateLevenshteinDistance(domain, legitDomain);
        if (similarity <= 2 && similarity > 0) {
          typosquatted.push(domain);
          break;
        }
      }

      // Check for brand name with extra characters
      for (const keyword of brandPattern.keywords) {
        const cleanKeyword = keyword.replace(/\s/g, '');
        if (domain.includes(cleanKeyword) && !brandPattern.domains.some(d => domain === d)) {
          // Brand name in domain but not official domain
          typosquatted.push(domain);
          break;
        }
      }
    }

    return typosquatted;
  }

  private isLegitimateAutomatedEmail(fullText: string, urls: string[]): boolean {
    // Patterns that indicate legitimate automated emails
    const legitimatePatterns = [
      // Verification codes (no clickable links, just codes)
      /verification code.*\d{4,8}/i,
      /your code is.*\d{4,8}/i,
      /enter.*code.*\d{4,8}/i,
      
      // OTP/2FA without suspicious links
      /one-time password/i,
      /two-factor authentication/i,
      /2fa code/i,
    ];

    // If email matches legitimate patterns and has few/no URLs, it's likely legitimate
    const hasLegitPattern = legitimatePatterns.some(pattern => pattern.test(fullText));
    
    if (hasLegitPattern && urls.length <= 1) {
      return true;
    }

    // Check for legitimate service domains
    const legitimateServiceDomains = [
      'sendgrid.net', 'mailgun.org', 'amazonses.com', 'postmarkapp.com',
      'mailchimp.com', 'constantcontact.com', 'hubspot.com',
      'intercom.io', 'zendesk.com', 'freshdesk.com',
      'auth0.com', 'okta.com', 'firebase.google.com',
      'twilio.com', 'plivo.com', 'nexmo.com'
    ];

    const urlDomains = urls.map(url => this.extractDomain(url)).filter(Boolean) as string[];
    const hasLegitServiceDomain = urlDomains.some(domain =>
      legitimateServiceDomains.some(legitDomain => 
        domain === legitDomain || domain.endsWith(`.${legitDomain}`)
      )
    );

    if (hasLegitServiceDomain) {
      return true;
    }

    return false;
  }

  private isLegitimateThirdPartyService(domains: string[], brand: string): boolean {
    // Known legitimate third-party services used by brands
    const legitimateThirdPartyPatterns = [
      // Email service providers
      'sendgrid.net', 'mailgun.org', 'amazonses.com', 'postmarkapp.com',
      'mailchimp.com', 'constantcontact.com', 'sparkpostmail.com',
      
      // Authentication services
      'auth0.com', 'okta.com', 'onelogin.com',
      
      // Support/CRM platforms
      'zendesk.com', 'freshdesk.com', 'intercom.io', 'helpscout.net',
      
      // Payment processors
      'stripe.com', 'braintreegateway.com', 'checkout.com',
      
      // CDN/hosting
      'cloudfront.net', 'amazonaws.com', 'azurewebsites.net',
      'herokuapp.com', 'vercel.app', 'netlify.app',
      
      // Analytics/tracking
      'click.', 'track.', 'email.', 'go.', 'links.',
    ];

    return domains.some(domain =>
      legitimateThirdPartyPatterns.some(pattern => 
        domain.includes(pattern) || domain.startsWith(pattern)
      )
    );
  }

  private detectGenericPhishingPatterns(urls: string[]): string[] {
    const suspicious: string[] = [];
    const phishingKeywords = [
      'verify', 'account', 'secure', 'update', 'confirm', 'login',
      'signin', 'banking', 'suspended', 'locked', 'unusual', 'activity',
      'validate', 'restore', 'recover', 'urgent', 'action', 'required'
    ];

    for (const url of urls) {
      const domain = this.extractDomain(url);
      if (!domain) continue;

      // Skip known legitimate services
      if (this.isLegitimateThirdPartyService([domain], '')) {
        continue;
      }

      // Check if domain contains multiple phishing keywords (increased threshold)
      const keywordCount = phishingKeywords.filter(keyword =>
        domain.includes(keyword)
      ).length;

      if (keywordCount >= 3) { // Increased from 2 to 3
        suspicious.push(domain);
      }

      // Check for suspicious patterns like "brand-verify-account.com"
      // But allow single keyword with hyphen (common in legitimate services)
      const hyphenCount = (domain.match(/-/g) || []).length;
      const hasPhishingKeyword = phishingKeywords.some(k => domain.includes(k));
      
      if (hyphenCount >= 2 && hasPhishingKeyword && keywordCount >= 2) {
        suspicious.push(domain);
      }
    }

    return suspicious;
  }

  private checkSuspiciousTLDs(urls: string[]): string[] {
    const suspiciousTLDs = [
      '.tk', '.ml', '.ga', '.cf', '.gq', // Free TLDs often used for phishing
      '.xyz', '.top', '.work', '.click', '.link',
      '.pw', '.cc', '.info', '.biz'
    ];

    const suspicious: string[] = [];

    for (const url of urls) {
      const domain = this.extractDomain(url);
      if (!domain) continue;

      if (suspiciousTLDs.some(tld => domain.endsWith(tld))) {
        suspicious.push(domain);
      }
    }

    return suspicious;
  }

  private containsIPAddress(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // Check for IPv4
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (ipv4Regex.test(hostname)) {
        return true;
      }

      // Check for IPv6
      if (hostname.includes(':') && hostname.includes('[')) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private checkExcessiveSubdomains(urls: string[]): string[] {
    const suspicious: string[] = [];

    for (const url of urls) {
      const domain = this.extractDomain(url);
      if (!domain) continue;

      const parts = domain.split('.');
      // More than 4 parts is suspicious (e.g., login.secure.verify.amazon.fake.com)
      if (parts.length > 4) {
        suspicious.push(domain);
      }
    }

    return suspicious;
  }

  private detectHomographAttacks(urls: string[]): string[] {
    const suspicious: string[] = [];

    for (const url of urls) {
      const domain = this.extractDomain(url);
      if (!domain) continue;

      // Check for non-ASCII characters that look like ASCII
      // Common homograph characters: а (Cyrillic a), е (Cyrillic e), о (Cyrillic o), etc.
      const hasNonASCII = /[^\x00-\x7F]/.test(domain);

      if (hasNonASCII) {
        suspicious.push(domain);
      }
    }

    return suspicious;
  }

  private calculateLevenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }
}
