import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
} from '@aws-sdk/client-sesv2';
import { SESClient, CreateReceiptRuleCommand, DeleteReceiptRuleCommand } from '@aws-sdk/client-ses';
import sesClient from './sesClient';
import logger from '../utils/logger';
import domainStore from '../stores/domainStore';
import { getRedisClient } from '../lib/redis';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const CONFIG_SET = 'commune-sending';
const RECEIPT_RULE_SET = 'commune-receipt-rules';
const INBOUND_SNS_ARN = `arn:aws:sns:${AWS_REGION}:265230572969:commune-email-inbound`;
const INBOUND_S3_BUCKET = process.env.SES_INBOUND_BUCKET || 'commune-inbound-emails';

// Classic SES SDK (v1) needed for Receipt Rules — SESv2 doesn't have receipt rule API
const sesV1 = new SESClient({ region: AWS_REGION });

// ─── DNS Record Helpers ───────────────────────────────────────────────────────

/**
 * Build the full set of DNS records a user needs to add for their custom domain.
 * Returns records in the same shape as Resend's domain records, so the frontend
 * doesn't need changes.
 *
 * Records:
 *  - 3 CNAME records for DKIM (Easy DKIM)
 *  - 1 TXT for SPF
 *  - 1 MX for inbound routing
 *  - 1 TXT for DMARC (recommended, not required)
 */
const buildDnsRecords = (domain: string, dkimTokens: string[]) => {
  const records: Array<{
    record: string;
    name: string;
    type: string;
    value?: string;
    ttl?: string;
    priority?: number;
    status?: string;
  }> = [];

  // DKIM CNAME records
  for (const token of dkimTokens) {
    records.push({
      record: 'DKIM',
      name: `${token}._domainkey.${domain}`,
      type: 'CNAME',
      value: `${token}.dkim.amazonses.com`,
      ttl: 'Auto',
      status: 'not_started',
    });
  }

  // SPF TXT
  records.push({
    record: 'SPF',
    name: domain,
    type: 'TXT',
    value: 'v=spf1 include:amazonses.com ~all',
    ttl: 'Auto',
    status: 'not_started',
  });

  // MX for inbound
  records.push({
    record: 'MX',
    name: domain,
    type: 'MX',
    priority: 10,
    value: `inbound-smtp.${AWS_REGION}.amazonaws.com`,
    ttl: 'Auto',
    status: 'not_started',
  });

  // DMARC TXT (recommended)
  records.push({
    record: 'DMARC',
    name: `_dmarc.${domain}`,
    type: 'TXT',
    value: 'v=DMARC1; p=none;',
    ttl: 'Auto',
    status: 'not_started',
  });

  return records;
};

// ─── Map SES status → our status strings ─────────────────────────────────────

const mapSesStatus = (sesStatus: string | undefined, verifiedForSending: boolean): string => {
  if (verifiedForSending) return 'verified';
  switch (sesStatus) {
    case 'SUCCESS': return 'verified';
    case 'PENDING': return 'pending';
    case 'FAILED': return 'failed';
    case 'TEMPORARY_FAILURE': return 'temporary_failure';
    default: return 'not_started';
  }
};

// ─── Receipt Rule Management ──────────────────────────────────────────────────

const addReceiptRuleForDomain = async (domain: string) => {
  try {
    await sesV1.send(new CreateReceiptRuleCommand({
      RuleSetName: RECEIPT_RULE_SET,
      Rule: {
        Name: `route-${domain.replace(/\./g, '-')}`,
        Enabled: true,
        TlsPolicy: 'Optional',
        Recipients: [domain],
        Actions: [
          {
            S3Action: {
              BucketName: INBOUND_S3_BUCKET,
              ObjectKeyPrefix: 'inbound/',
              TopicArn: INBOUND_SNS_ARN,
            },
          },
        ],
        ScanEnabled: false,
      },
    }));
    logger.info('Receipt rule added for domain', { domain });
  } catch (err) {
    logger.warn('Failed to add receipt rule for domain', { domain, error: err });
  }
};

const removeReceiptRuleForDomain = async (domain: string) => {
  try {
    await sesV1.send(new DeleteReceiptRuleCommand({
      RuleSetName: RECEIPT_RULE_SET,
      RuleName: `route-${domain.replace(/\./g, '-')}`,
    }));
    logger.info('Receipt rule removed for domain', { domain });
  } catch (err) {
    logger.warn('Failed to remove receipt rule for domain', { domain, error: err });
  }
};

// ─── Domain Service ───────────────────────────────────────────────────────────

const createDomain = async ({
  name,
  region,
  orgId,
}: {
  name: string;
  region?: string;
  capabilities?: { sending?: string; receiving?: string };
  orgId?: string | null;
}) => {
  try {
    const res = await sesClient.send(new CreateEmailIdentityCommand({
      EmailIdentity: name,
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      ConfigurationSetName: CONFIG_SET,
    }));

    const dkimTokens = res.DkimAttributes?.Tokens || [];
    const records = buildDnsRecords(name, dkimTokens);
    const status = mapSesStatus(res.DkimAttributes?.Status, res.VerifiedForSendingStatus || false);

    const entry = {
      id: name,          // SES identity ID is the domain name itself
      name,
      status,
      region: region || AWS_REGION,
      records,
      createdAt: new Date().toISOString(),
      orgId: orgId || undefined,
    };
    await domainStore.upsertDomain(entry);

    // Register in spam filter allowlist
    const redis = getRedisClient();
    if (redis) {
      redis.sadd('commune:verified:domains', name).catch((err) => {
        logger.warn('Failed to add domain to verified allowlist', { error: err });
      });
    }

    // Add inbound receipt rule so emails to *@domain are routed to S3
    await addReceiptRuleForDomain(name);

    const data = {
      id: name,
      name,
      status,
      region: region || AWS_REGION,
      records,
      created_at: entry.createdAt,
    };

    return { data, entry, webhook: null };
  } catch (err: any) {
    logger.error('Failed to create SES domain identity', { name, error: err?.message });
    if (err?.name === 'AlreadyExistsException') {
      return { error: { message: `Domain ${name} already exists in SES. Check your dashboard.` } };
    }
    return { error: { message: err?.message || 'Failed to create domain' } };
  }
};

const getDomain = async (domainId: string) => {
  // domainId may be the domain name (SES) or a UUID (legacy Resend)
  // First check our DB to get the actual domain name
  const entry = await domainStore.getDomain(domainId);
  const domainName = entry?.name || domainId;

  try {
    const res = await sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: domainName }));
    const dkimTokens = res.DkimAttributes?.Tokens || [];
    const records = dkimTokens.length > 0 ? buildDnsRecords(domainName, dkimTokens) : (entry?.records || []);
    const status = mapSesStatus(res.VerificationStatus, res.VerifiedForSendingStatus || false);

    // Update DB with fresh status
    await domainStore.upsertDomain({ id: domainId, status, records });

    const data = {
      id: domainId,
      name: domainName,
      status,
      records,
      region: entry?.region || AWS_REGION,
      created_at: entry?.createdAt,
    };
    return { data, error: null };
  } catch (err: any) {
    if (err?.name === 'NotFoundException') {
      return { data: null, error: { message: 'Domain not found in SES' } };
    }
    return { data: null, error: { message: err?.message || 'Failed to get domain' } };
  }
};

const verifyDomain = async (domainId: string) => {
  // SES verifies automatically when DNS records propagate — this triggers a status refresh
  return getDomain(domainId);
};

const listDomains = async () => {
  try {
    const res = await sesClient.send(new ListEmailIdentitiesCommand({ PageSize: 100 }));
    const domains = (res.EmailIdentities || []).filter(id => id.IdentityType === 'DOMAIN');
    return { data: domains, error: null };
  } catch (err: any) {
    return { data: null, error: { message: err?.message || 'Failed to list domains' } };
  }
};

const deleteDomain = async (domainId: string) => {
  const entry = await domainStore.getDomain(domainId);
  const domainName = entry?.name || domainId;
  try {
    await sesClient.send(new DeleteEmailIdentityCommand({ EmailIdentity: domainName }));
    await removeReceiptRuleForDomain(domainName);
    logger.info('Domain identity deleted', { domainName });
    return { data: { deleted: true }, error: null };
  } catch (err: any) {
    return { data: null, error: { message: err?.message || 'Failed to delete domain' } };
  }
};

const refreshDomainRecords = async (domainId: string) => {
  return getDomain(domainId);
};

// No-ops kept for API compatibility — SES uses centralized SNS, not per-domain webhooks
const createInboundWebhook = async (_domainId: string, _endpoint?: string, _events?: string[]) => {
  return { data: { note: 'SES uses centralized SNS delivery events, no per-domain webhook needed' }, error: null };
};

const storeWebhookSecret = async (domainId: string, secret: string) => {
  const entry = { id: domainId, webhook: { secret } };
  await domainStore.upsertDomain(entry);
  return entry;
};

const buildWebhookEndpoint = (_domainId: string) => null;

export default {
  createDomain,
  listDomains,
  getDomain,
  verifyDomain,
  deleteDomain,
  createInboundWebhook,
  refreshDomainRecords,
  buildWebhookEndpoint,
  storeWebhookSecret,
};
