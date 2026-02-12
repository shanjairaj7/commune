import { ContentAnalyzer } from './contentAnalyzer';
import { URLValidator } from './urlValidator';
import { DNSBLChecker } from './dnsblChecker';
import { ReputationCalculator } from './reputationCalculator';
import { MassEmailDetector } from './massEmailDetector';
import reputationStore from '../../stores/reputationStore';
import blockedSpamStore from '../../stores/blockedSpamStore';
import { SpamAnalysisResult, IncomingEmail } from '../../types/spam';
import logger from '../../utils/logger';

export class SpamDetectionService {
  private static instance: SpamDetectionService;
  private contentAnalyzer: ContentAnalyzer;
  private urlValidator: URLValidator;
  private dnsblChecker: DNSBLChecker;
  private reputationCalculator: ReputationCalculator;
  private massEmailDetector: MassEmailDetector;

  private REJECT_THRESHOLD = 0.8;
  private FLAG_THRESHOLD = 0.5;

  private constructor() {
    this.contentAnalyzer = ContentAnalyzer.getInstance();
    this.urlValidator = URLValidator.getInstance();
    this.dnsblChecker = DNSBLChecker.getInstance();
    this.reputationCalculator = ReputationCalculator.getInstance();
    this.massEmailDetector = MassEmailDetector.getInstance();
  }

  public static getInstance(): SpamDetectionService {
    if (!SpamDetectionService.instance) {
      SpamDetectionService.instance = new SpamDetectionService();
    }
    return SpamDetectionService.instance;
  }

  public async analyzeEmail(email: IncomingEmail, orgId?: string): Promise<SpamAnalysisResult> {
    const startTime = Date.now();

    try {
      // Check if sender is blocked
      const isBlocked = await reputationStore.isBlocked(email.from);
      if (isBlocked) {
        return {
          action: 'reject',
          spam_score: 1.0,
          confidence: 1.0,
          reasons: ['Sender is blocked'],
          details: {
            content_score: 0,
            link_score: 0,
            sender_reputation: 1.0,
            domain_reputation: 0,
          },
          processing_time_ms: Date.now() - startTime,
        };
      }

      // Run all analyses in parallel
      const [contentScore, linkScore, senderScore] = await Promise.all([
        this.contentAnalyzer.analyze(email.content || email.html || '', email.subject),
        this.urlValidator.validateUrls(email.content || email.html || '', email.subject),
        this.getSenderReputation(email.from),
      ]);

      // Get domain reputation
      const domain = email.from.split('@')[1] || '';
      const domainScore = await this.getDomainReputation(domain, email.headers);

      // Check for mass email attack
      let massAttackResult;
      if (orgId) {
        massAttackResult = await this.massEmailDetector.checkMassEmailAttack(
          orgId,
          email.from,
          contentScore.spam_score,
          domainScore
        );

        // If mass attack detected and should reject this email
        if (massAttackResult.shouldReject) {
          return {
            action: 'reject',
            spam_score: 0.9,
            confidence: 0.95,
            reasons: [massAttackResult.reason || 'Mass email attack detected'],
            details: {
              content_score: contentScore.spam_score,
              link_score: linkScore.spam_score,
              sender_reputation: senderScore,
              domain_reputation: domainScore,
            },
            processing_time_ms: Date.now() - startTime,
          };
        }
      }

      // High-confidence phishing detection bypass
      // If phishing is detected with high confidence, reject immediately
      if (linkScore.spam_score >= 0.7) {
        const hasPhishingIndicator = linkScore.reasons.some(r => 
          r.toLowerCase().includes('phishing') || 
          r.toLowerCase().includes('impersonation') ||
          r.toLowerCase().includes('typosquat') ||
          r.toLowerCase().includes('low-authority')
        );
        
        if (hasPhishingIndicator) {
          logger.warn('High-confidence phishing detected, bypassing sender reputation', {
            from: email.from,
            linkScore: linkScore.spam_score,
            reasons: linkScore.reasons
          });
          
          return {
            spam_score: linkScore.spam_score,
            confidence: linkScore.spam_score,
            action: 'reject',
            reasons: linkScore.reasons,
            details: {
              content_score: contentScore.spam_score,
              link_score: linkScore.spam_score,
              sender_reputation: senderScore,
              domain_reputation: domainScore,
            },
            processing_time_ms: Date.now() - startTime,
          };
        }
      }

      // Calculate final spam score (weighted average)
      // Increased link score weight from 0.2 to 0.4 for better phishing detection
      const finalScore = (
        contentScore.spam_score * 0.25 +
        linkScore.spam_score * 0.4 +
        senderScore * 0.2 +
        domainScore * 0.15
      );

      // Collect all reasons
      const reasons = [
        ...contentScore.reasons,
        ...linkScore.reasons,
      ];

      // Add mass attack warning if detected
      if (massAttackResult?.isAttack) {
        reasons.push(`Mass email attack in progress (${massAttackResult.burstStats.emailCount} emails in 5 min)`);
      }

      if (senderScore > 0.5) {
        reasons.push(`Poor sender reputation (${(senderScore * 100).toFixed(0)}%)`);
      }

      if (domainScore > 0.5) {
        reasons.push(`Poor domain reputation (${(domainScore * 100).toFixed(0)}%)`);
      }

      // Determine action
      let action: 'reject' | 'flag' | 'accept';
      if (finalScore >= this.REJECT_THRESHOLD) {
        action = 'reject';
      } else if (finalScore >= this.FLAG_THRESHOLD) {
        action = 'flag';
      } else {
        action = 'accept';
      }

      // Update sender statistics
      await this.updateSenderStats(email.from, contentScore.spam_score, linkScore.spam_score);

      const processingTime = Date.now() - startTime;

      logger.info('Spam analysis completed', {
        from: email.from,
        action,
        score: finalScore,
        processing_time: processingTime,
      });

      return {
        action,
        spam_score: finalScore,
        confidence: 0.85, // Fixed confidence for now
        reasons,
        details: {
          content_score: contentScore.spam_score,
          link_score: linkScore.spam_score,
          sender_reputation: senderScore,
          domain_reputation: domainScore,
        },
        processing_time_ms: processingTime,
      };
    } catch (error) {
      logger.error('Spam analysis error:', error);
      
      // On error, default to accept to avoid false positives
      return {
        action: 'accept',
        spam_score: 0,
        confidence: 0,
        reasons: ['Analysis error - defaulting to accept'],
        details: {
          content_score: 0,
          link_score: 0,
          sender_reputation: 0,
          domain_reputation: 0,
        },
        processing_time_ms: Date.now() - startTime,
      };
    }
  }

  private async getSenderReputation(email: string): Promise<number> {
    try {
      const score = await reputationStore.getSpamScore(email);
      
      if (!score) {
        // New sender, neutral reputation
        return 0;
      }

      // Calculate current spam score
      return this.reputationCalculator.calculateSpamScore(score);
    } catch (error) {
      logger.error('Error getting sender reputation:', error);
      return 0;
    }
  }

  private async getDomainReputation(domain: string, headers: Record<string, string>): Promise<number> {
    try {
      // Check DNSBL
      const ip = this.dnsblChecker.extractIPFromHeaders(headers);
      if (ip) {
        const blacklistResult = await this.dnsblChecker.checkBlacklists(ip, domain);
        if (blacklistResult.is_blacklisted) {
          return 0.8; // High spam score for blacklisted domains
        }
      }

      // Check stored domain reputation
      const domainRep = await reputationStore.getDomainReputation(domain);
      if (domainRep) {
        if (domainRep.is_blacklisted) {
          return 0.9;
        }
        return 1 - domainRep.reputation_score;
      }

      return 0; // Neutral for unknown domains
    } catch (error) {
      logger.error('Error getting domain reputation:', error);
      return 0;
    }
  }

  private async updateSenderStats(
    email: string,
    contentScore: number,
    linkScore: number
  ): Promise<void> {
    try {
      const score = await reputationStore.getSpamScore(email);
      
      if (!score) {
        // Create new score entry
        await reputationStore.createSpamScore(email);
        return;
      }

      // Update average scores
      const newAvgContent = this.reputationCalculator.updateAverageScore(
        score.metadata.avg_content_score,
        score.total_emails,
        contentScore
      );

      const newAvgLink = this.reputationCalculator.updateAverageScore(
        score.metadata.avg_link_score,
        score.total_emails,
        linkScore
      );

      await reputationStore.updateSpamScore(email, {
        metadata: {
          ...score.metadata,
          avg_content_score: newAvgContent,
          avg_link_score: newAvgLink,
        },
      });

      // Check if sender should be blocked
      const newSpamScore = this.reputationCalculator.calculateSpamScore({
        ...score,
        metadata: {
          ...score.metadata,
          avg_content_score: newAvgContent,
          avg_link_score: newAvgLink,
        },
      });

      if (this.reputationCalculator.shouldBlock(newSpamScore, score.spam_reports)) {
        await reputationStore.blockSender(email, 'High spam score');
      }
    } catch (error) {
      logger.error('Error updating sender stats:', error);
    }
  }
}
