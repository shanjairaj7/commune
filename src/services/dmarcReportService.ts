import { getCollection } from '../db';
import { randomUUID } from 'crypto';
import logger from '../utils/logger';
import { Readable } from 'stream';
import zlib from 'zlib';

// ─── Types ──────────────────────────────────────────────────────────────────
interface DmarcReportRecord {
  _id?: string;
  report_id: string;
  org_name: string;
  email: string;
  domain: string;
  date_begin: Date;
  date_end: Date;
  policy: {
    domain: string;
    adkim: string;
    aspf: string;
    p: string;
    sp: string;
    pct: number;
  };
  records: DmarcRecord[];
  raw_xml?: string;
  received_at: Date;
  our_domain_id?: string;
  org_id?: string;
}

interface DmarcRecord {
  source_ip: string;
  count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  header_from: string;
  dkim_domain?: string;
  dkim_selector?: string;
  spf_domain?: string;
}

interface DmarcSummary {
  domain: string;
  period: { begin: Date; end: Date };
  total_messages: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  dkim_pass: number;
  spf_pass: number;
  top_sources: Array<{ ip: string; count: number; pass: boolean }>;
  policy_overrides: number;
}

// ─── Simple XML parser for DMARC reports ────────────────────────────────────
// DMARC aggregate reports follow RFC 7489 Appendix C schema.
// Rather than pulling in a full XML dependency, we parse the well-known
// structure with regex. This handles all standard DMARC XML reports.

const extractTag = (xml: string, tag: string): string => {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
};

const extractAllTags = (xml: string, tag: string): string[] => {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
};

const parseDmarcXml = (xml: string): Omit<DmarcReportRecord, '_id' | 'received_at' | 'our_domain_id' | 'org_id'> | null => {
  try {
    const reportMetadata = extractTag(xml, 'report_metadata');
    const policyPublished = extractTag(xml, 'policy_published');
    const recordBlocks = extractAllTags(xml, 'record');

    const reportId = extractTag(reportMetadata, 'report_id');
    const orgName = extractTag(reportMetadata, 'org_name');
    const email = extractTag(reportMetadata, 'email');
    const dateRange = extractTag(reportMetadata, 'date_range');
    const dateBegin = parseInt(extractTag(dateRange, 'begin'), 10);
    const dateEnd = parseInt(extractTag(dateRange, 'end'), 10);

    const domain = extractTag(policyPublished, 'domain');
    const adkim = extractTag(policyPublished, 'adkim') || 'r';
    const aspf = extractTag(policyPublished, 'aspf') || 'r';
    const p = extractTag(policyPublished, 'p') || 'none';
    const sp = extractTag(policyPublished, 'sp') || p;
    const pct = parseInt(extractTag(policyPublished, 'pct') || '100', 10);

    const records: DmarcRecord[] = recordBlocks.map((block) => {
      const row = extractTag(block, 'row');
      const sourceIp = extractTag(row, 'source_ip');
      const count = parseInt(extractTag(row, 'count') || '0', 10);
      const policyEval = extractTag(row, 'policy_evaluated');
      const disposition = extractTag(policyEval, 'disposition');
      const dkimResult = extractTag(policyEval, 'dkim');
      const spfResult = extractTag(policyEval, 'spf');

      const identifiers = extractTag(block, 'identifiers');
      const headerFrom = extractTag(identifiers, 'header_from');

      const authResults = extractTag(block, 'auth_results');
      const dkimAuth = extractTag(authResults, 'dkim');
      const spfAuth = extractTag(authResults, 'spf');

      return {
        source_ip: sourceIp,
        count,
        disposition,
        dkim_result: dkimResult,
        spf_result: spfResult,
        header_from: headerFrom,
        dkim_domain: extractTag(dkimAuth, 'domain'),
        dkim_selector: extractTag(dkimAuth, 'selector'),
        spf_domain: extractTag(spfAuth, 'domain'),
      };
    });

    return {
      report_id: reportId,
      org_name: orgName,
      email,
      domain,
      date_begin: new Date(dateBegin * 1000),
      date_end: new Date(dateEnd * 1000),
      policy: { domain, adkim, aspf, p, sp, pct },
      records,
    };
  } catch (err) {
    logger.error('Failed to parse DMARC XML', { error: err });
    return null;
  }
};

// ─── Service ────────────────────────────────────────────────────────────────
export class DmarcReportService {
  private static instance: DmarcReportService;

  private constructor() {}

  public static getInstance(): DmarcReportService {
    if (!DmarcReportService.instance) {
      DmarcReportService.instance = new DmarcReportService();
    }
    return DmarcReportService.instance;
  }

  /**
   * Process a raw DMARC aggregate report.
   * Accepts XML string, gzipped XML, or zip file buffer.
   */
  public async processReport(
    input: string | Buffer,
    orgId?: string,
    domainId?: string
  ): Promise<DmarcReportRecord | null> {
    let xml: string;

    if (Buffer.isBuffer(input)) {
      // Try to decompress gzip
      try {
        const decompressed = zlib.gunzipSync(input);
        xml = decompressed.toString('utf8');
      } catch {
        // Not gzipped, try as plain text
        xml = input.toString('utf8');
      }
    } else {
      xml = input;
    }

    if (!xml.includes('<feedback>')) {
      logger.warn('Input does not appear to be a DMARC aggregate report');
      return null;
    }

    const parsed = parseDmarcXml(xml);
    if (!parsed) return null;

    const record: DmarcReportRecord = {
      _id: randomUUID(),
      ...parsed,
      raw_xml: xml,
      received_at: new Date(),
      our_domain_id: domainId,
      org_id: orgId,
    };

    // Store in MongoDB
    const collection = await getCollection<DmarcReportRecord>('dmarc_reports');
    if (collection) {
      await collection.updateOne(
        { report_id: record.report_id, domain: record.domain },
        { $set: record },
        { upsert: true }
      );
    }

    logger.info('DMARC report processed', {
      reportId: record.report_id,
      domain: record.domain,
      orgName: record.org_name,
      recordCount: record.records.length,
      totalMessages: record.records.reduce((sum, r) => sum + r.count, 0),
    });

    // Check for authentication failures and alert
    await this.checkForFailures(record);

    return record;
  }

  /**
   * Get a summary of DMARC reports for a domain over a time period.
   */
  public async getDomainSummary(
    domain: string,
    startDate: Date,
    endDate: Date,
    orgId?: string
  ): Promise<DmarcSummary | null> {
    const collection = await getCollection<DmarcReportRecord>('dmarc_reports');
    if (!collection) return null;

    const filter: Record<string, any> = {
      domain: domain.toLowerCase(),
      date_begin: { $gte: startDate },
      date_end: { $lte: endDate },
    };
    if (orgId) filter.org_id = orgId;

    const reports = await collection.find(filter).toArray();
    if (reports.length === 0) return null;

    let totalMessages = 0;
    let passCount = 0;
    let failCount = 0;
    let dkimPass = 0;
    let spfPass = 0;
    let policyOverrides = 0;
    const sourceMap = new Map<string, { count: number; pass: boolean }>();

    for (const report of reports) {
      for (const record of report.records) {
        totalMessages += record.count;

        const dkimOk = record.dkim_result === 'pass';
        const spfOk = record.spf_result === 'pass';
        const passed = dkimOk || spfOk;

        if (passed) {
          passCount += record.count;
        } else {
          failCount += record.count;
        }

        if (dkimOk) dkimPass += record.count;
        if (spfOk) spfPass += record.count;

        if (record.disposition !== 'none' && !passed) {
          policyOverrides += record.count;
        }

        const existing = sourceMap.get(record.source_ip);
        if (existing) {
          existing.count += record.count;
          if (!passed) existing.pass = false;
        } else {
          sourceMap.set(record.source_ip, { count: record.count, pass: passed });
        }
      }
    }

    const topSources = Array.from(sourceMap.entries())
      .map(([ip, data]) => ({ ip, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      domain,
      period: {
        begin: startDate,
        end: endDate,
      },
      total_messages: totalMessages,
      pass_count: passCount,
      fail_count: failCount,
      pass_rate: totalMessages > 0 ? passCount / totalMessages : 0,
      dkim_pass: dkimPass,
      spf_pass: spfPass,
      top_sources: topSources,
      policy_overrides: policyOverrides,
    };
  }

  /**
   * List all DMARC reports for a domain.
   */
  public async listReports(
    domain: string,
    limit = 50,
    orgId?: string
  ): Promise<DmarcReportRecord[]> {
    const collection = await getCollection<DmarcReportRecord>('dmarc_reports');
    if (!collection) return [];

    const filter: Record<string, any> = { domain: domain.toLowerCase() };
    if (orgId) filter.org_id = orgId;

    return collection
      .find(filter)
      .sort({ received_at: -1 })
      .limit(limit)
      .project({ raw_xml: 0 }) // Exclude raw XML from listings
      .toArray() as any;
  }

  /**
   * Check for authentication failures and log warnings.
   */
  private async checkForFailures(report: DmarcReportRecord): Promise<void> {
    const totalMessages = report.records.reduce((sum, r) => sum + r.count, 0);
    const failures = report.records.filter(
      (r) => r.dkim_result !== 'pass' && r.spf_result !== 'pass'
    );
    const failCount = failures.reduce((sum, r) => sum + r.count, 0);

    if (failCount > 0) {
      const failRate = failCount / totalMessages;
      const level = failRate > 0.1 ? 'warn' : 'info';

      logger[level]('DMARC authentication failures detected', {
        domain: report.domain,
        reportId: report.report_id,
        orgName: report.org_name,
        totalMessages,
        failCount,
        failRate: `${(failRate * 100).toFixed(1)}%`,
        failingSources: failures.map((f) => ({
          ip: f.source_ip,
          count: f.count,
          dkim: f.dkim_result,
          spf: f.spf_result,
        })),
      });
    }
  }

  /**
   * Ensure MongoDB indexes for DMARC reports.
   */
  public async ensureIndexes(): Promise<void> {
    const collection = await getCollection<DmarcReportRecord>('dmarc_reports');
    if (collection) {
      await collection.createIndex({ report_id: 1, domain: 1 }, { unique: true });
      await collection.createIndex({ domain: 1, date_begin: -1 });
      await collection.createIndex({ org_id: 1, domain: 1 });
      await collection.createIndex({ received_at: -1 });
      // TTL: auto-delete reports older than 1 year
      await collection.createIndex(
        { received_at: 1 },
        { expireAfterSeconds: 365 * 24 * 60 * 60 }
      );
    }
  }
}
