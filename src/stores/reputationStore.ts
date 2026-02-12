import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import { SpamScore, SpamReport, DomainReputation } from '../types/spam';
import logger from '../utils/logger';

const ensureIndexes = async () => {
  try {
    const spamScores = await getCollection<SpamScore>('spam_scores');
    if (spamScores) {
      await spamScores.createIndex({ email: 1 }, { unique: true });
      await spamScores.createIndex({ domain: 1 });
      await spamScores.createIndex({ spam_score: -1 });
      await spamScores.createIndex({ blocked: 1 });
      await spamScores.createIndex({ last_email_at: -1 });
    }

    const spamReports = await getCollection<SpamReport>('spam_reports');
    if (spamReports) {
      await spamReports.createIndex({ message_id: 1 });
      await spamReports.createIndex({ sender_email: 1 });
      await spamReports.createIndex({ reporter_org_id: 1 });
      await spamReports.createIndex({ reported_at: -1 });
    }

    const domainReputation = await getCollection<DomainReputation>('domain_reputation');
    if (domainReputation) {
      await domainReputation.createIndex({ domain: 1 }, { unique: true });
      await domainReputation.createIndex({ reputation_score: -1 });
      await domainReputation.createIndex({ is_blacklisted: 1 });
    }
  } catch (error) {
    logger.error('Failed to ensure reputation indexes:', error);
  }
};

const getSpamScore = async (email: string): Promise<SpamScore | null> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) return null;

  return collection.findOne({ email: email.toLowerCase() });
};

const createSpamScore = async (email: string): Promise<SpamScore> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) throw new Error('Collection not available');

  const domain = email.split('@')[1] || '';
  const doc: SpamScore = {
    _id: randomUUID(),
    email: email.toLowerCase(),
    domain: domain.toLowerCase(),
    spam_score: 0,
    total_emails: 0,
    spam_reports: 0,
    legitimate_emails: 0,
    last_email_at: new Date(),
    first_seen_at: new Date(),
    blocked: false,
    metadata: {
      bounce_rate: 0,
      complaint_rate: 0,
      avg_content_score: 0,
      avg_link_score: 0,
    },
  };

  await collection.insertOne(doc as any);
  return doc;
};

const updateSpamScore = async (
  email: string,
  update: Partial<SpamScore>
): Promise<void> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) return;

  await collection.updateOne(
    { email: email.toLowerCase() },
    { $set: update }
  );
};

const incrementEmailCount = async (email: string): Promise<void> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) return;

  const normalizedEmail = email.toLowerCase();
  
  // Get or create spam score
  let score = await getSpamScore(normalizedEmail);
  if (!score) {
    score = await createSpamScore(normalizedEmail);
  }

  await collection.updateOne(
    { email: normalizedEmail },
    {
      $inc: { total_emails: 1 },
      $set: { last_email_at: new Date() },
    }
  );
};

const reportSpam = async (
  messageId: string,
  senderEmail: string,
  reporterOrgId: string,
  reporterInboxId: string,
  reason?: string,
  classification: 'spam' | 'phishing' | 'malware' | 'other' = 'spam'
): Promise<void> => {
  const reportsCollection = await getCollection<SpamReport>('spam_reports');
  const scoresCollection = await getCollection<SpamScore>('spam_scores');
  
  if (!reportsCollection || !scoresCollection) return;

  // Create spam report
  const report: SpamReport = {
    _id: randomUUID(),
    message_id: messageId,
    reporter_org_id: reporterOrgId,
    reporter_inbox_id: reporterInboxId,
    sender_email: senderEmail.toLowerCase(),
    reported_at: new Date(),
    reason,
    auto_detected: false,
    classification,
  };

  await reportsCollection.insertOne(report as any);

  // Update spam score
  await scoresCollection.updateOne(
    { email: senderEmail.toLowerCase() },
    {
      $inc: { spam_reports: 1 },
      $set: { last_email_at: new Date() },
    },
    { upsert: true }
  );
};

const blockSender = async (email: string, reason: string): Promise<void> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) return;

  await collection.updateOne(
    { email: email.toLowerCase() },
    {
      $set: {
        blocked: true,
        blocked_at: new Date(),
        blocked_reason: reason,
      },
    },
    { upsert: true }
  );

  logger.info('Sender blocked', { email, reason });
};

const unblockSender = async (email: string): Promise<void> => {
  const collection = await getCollection<SpamScore>('spam_scores');
  if (!collection) return;

  await collection.updateOne(
    { email: email.toLowerCase() },
    {
      $set: {
        blocked: false,
      },
      $unset: {
        blocked_at: '',
        blocked_reason: '',
      },
    }
  );

  logger.info('Sender unblocked', { email });
};

const isBlocked = async (email: string): Promise<boolean> => {
  const score = await getSpamScore(email);
  return score?.blocked || false;
};

const getDomainReputation = async (domain: string): Promise<DomainReputation | null> => {
  const collection = await getCollection<DomainReputation>('domain_reputation');
  if (!collection) return null;

  return collection.findOne({ domain: domain.toLowerCase() });
};

const updateDomainReputation = async (
  domain: string,
  data: Partial<DomainReputation>
): Promise<void> => {
  const collection = await getCollection<DomainReputation>('domain_reputation');
  if (!collection) return;

  await collection.updateOne(
    { domain: domain.toLowerCase() },
    { $set: { ...data, last_checked_at: new Date() } },
    { upsert: true }
  );
};

const getSpamStats = async (orgId: string, days: number = 7): Promise<any> => {
  const reportsCollection = await getCollection<SpamReport>('spam_reports');
  if (!reportsCollection) return null;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const reports = await reportsCollection
    .find({
      reporter_org_id: orgId,
      reported_at: { $gte: startDate },
    })
    .toArray();

  const senderCounts = new Map<string, number>();
  reports.forEach(report => {
    const count = senderCounts.get(report.sender_email) || 0;
    senderCounts.set(report.sender_email, count + 1);
  });

  const topSpamSenders = Array.from(senderCounts.entries())
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total_reports: reports.length,
    top_spam_senders: topSpamSenders,
    by_classification: {
      spam: reports.filter(r => r.classification === 'spam').length,
      phishing: reports.filter(r => r.classification === 'phishing').length,
      malware: reports.filter(r => r.classification === 'malware').length,
      other: reports.filter(r => r.classification === 'other').length,
    },
  };
};

export default {
  ensureIndexes,
  getSpamScore,
  createSpamScore,
  updateSpamScore,
  incrementEmailCount,
  reportSpam,
  blockSender,
  unblockSender,
  isBlocked,
  getDomainReputation,
  updateDomainReputation,
  getSpamStats,
};
