import { getRedisClient, isRedisAvailable } from '../lib/redis';
import logger from '../utils/logger';

export interface SendingHealth {
  status: 'healthy' | 'warning' | 'paused';
  can_send: boolean;
  sent_24h: number;
  bounced_24h: number;
  complained_24h: number;
  bounce_rate: number;
  complaint_rate: number;
  warnings: string[];
  paused_reason?: string;
  resume_at?: string;
}

// Lua script: atomically record a timestamp and return the count in window
const RECORD_AND_COUNT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return redis.call('ZCARD', key)
`;

// Lua script: count entries in window (read-only)
const COUNT_IN_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
return redis.call('ZCARD', key)
`;

class SendingHealthService {
  private static instance: SendingHealthService;

  // Thresholds — aligned with industry standards (Postmark, SendGrid, Mailgun)
  private readonly BOUNCE_RATE_PAUSE = 0.05;      // 5% -> pause
  private readonly BOUNCE_RATE_WARN = 0.03;        // 3% -> warning
  private readonly COMPLAINT_RATE_PAUSE = 0.003;   // 0.3% -> pause
  private readonly COMPLAINT_RATE_WARN = 0.001;    // 0.1% -> warning
  private readonly MIN_SENDS_FOR_RATE = 20;        // Need 20+ sends for meaningful rate
  private readonly WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour rolling window
  private readonly COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4-hour cooldown after pause

  // In-memory fallback stores
  private memoryStore = new Map<string, number[]>();
  private pauseStore = new Map<string, number>(); // orgId -> paused_at timestamp

  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    // Periodic cleanup of expired in-memory entries every 60s
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entries] of this.memoryStore.entries()) {
        const cleaned = entries.filter(ts => now - ts < this.WINDOW_MS);
        if (cleaned.length === 0) {
          this.memoryStore.delete(key);
        } else {
          this.memoryStore.set(key, cleaned);
        }
      }
      // Clean stale pause entries (older than window + cooldown)
      const maxPauseAge = this.WINDOW_MS + this.COOLDOWN_MS;
      for (const [orgId, pausedAt] of this.pauseStore.entries()) {
        if (now - pausedAt > maxPauseAge) {
          this.pauseStore.delete(orgId);
        }
      }
    }, 60_000);
  }

  public static getInstance(): SendingHealthService {
    if (!SendingHealthService.instance) {
      SendingHealthService.instance = new SendingHealthService();
    }
    return SendingHealthService.instance;
  }

  async recordSend(orgId: string): Promise<void> {
    const key = `health:${orgId}:sent`;
    await this.recordEvent(key);
  }

  async recordBounce(orgId: string): Promise<void> {
    const key = `health:${orgId}:bounced`;
    await this.recordEvent(key);
  }

  async recordComplaint(orgId: string): Promise<void> {
    const key = `health:${orgId}:complained`;
    await this.recordEvent(key);
  }

  async checkHealth(orgId: string): Promise<SendingHealth> {
    const [sent, bounced, complained] = await Promise.all([
      this.getCount(`health:${orgId}:sent`),
      this.getCount(`health:${orgId}:bounced`),
      this.getCount(`health:${orgId}:complained`),
    ]);

    const warnings: string[] = [];
    let status: 'healthy' | 'warning' | 'paused' = 'healthy';
    let canSend = true;
    let pausedReason: string | undefined;
    let resumeAt: string | undefined;

    // Need minimum sends for meaningful rate calculation
    const bounceRate = sent >= this.MIN_SENDS_FOR_RATE ? bounced / sent : 0;
    const complaintRate = sent >= this.MIN_SENDS_FOR_RATE ? complained / sent : 0;

    if (sent >= this.MIN_SENDS_FOR_RATE) {
      // Check complaint rate first (more serious)
      if (complaintRate >= this.COMPLAINT_RATE_PAUSE) {
        status = 'paused';
        canSend = false;
        pausedReason = `Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds ${(this.COMPLAINT_RATE_PAUSE * 100).toFixed(2)}% threshold`;
        await this.setPaused(orgId);
      } else if (bounceRate >= this.BOUNCE_RATE_PAUSE) {
        status = 'paused';
        canSend = false;
        pausedReason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeds ${(this.BOUNCE_RATE_PAUSE * 100).toFixed(2)}% threshold`;
        await this.setPaused(orgId);
      } else {
        // Check warning thresholds
        if (complaintRate >= this.COMPLAINT_RATE_WARN) {
          status = 'warning';
          warnings.push(`Complaint rate ${(complaintRate * 100).toFixed(2)}% approaching pause threshold`);
        }
        if (bounceRate >= this.BOUNCE_RATE_WARN) {
          status = 'warning';
          warnings.push(`Bounce rate ${(bounceRate * 100).toFixed(2)}% approaching pause threshold`);
        }
      }
    }

    // Check cooldown for paused orgs
    if (status === 'paused') {
      const pausedAt = await this.getPausedAt(orgId);
      if (pausedAt) {
        const cooldownEnd = pausedAt + this.COOLDOWN_MS;
        resumeAt = new Date(cooldownEnd).toISOString();

        if (Date.now() >= cooldownEnd) {
          // Cooldown elapsed — check if rates have recovered
          if (bounceRate < this.BOUNCE_RATE_PAUSE && complaintRate < this.COMPLAINT_RATE_PAUSE) {
            status = bounceRate >= this.BOUNCE_RATE_WARN || complaintRate >= this.COMPLAINT_RATE_WARN ? 'warning' : 'healthy';
            canSend = true;
            pausedReason = undefined;
            resumeAt = undefined;
            await this.clearPaused(orgId);
            logger.info('Org auto-resumed after cooldown', { orgId, bounceRate, complaintRate });
          }
        }
      }
    }

    return {
      status,
      can_send: canSend,
      sent_24h: sent,
      bounced_24h: bounced,
      complained_24h: complained,
      bounce_rate: Math.round(bounceRate * 10000) / 10000,
      complaint_rate: Math.round(complaintRate * 10000) / 10000,
      warnings,
      paused_reason: pausedReason,
      resume_at: resumeAt,
    };
  }

  // ── Redis operations with in-memory fallback ──────────────────────

  private async recordEvent(key: string): Promise<void> {
    const now = Date.now();
    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        await redis.eval(RECORD_AND_COUNT_SCRIPT, 1, key, now.toString(), this.WINDOW_MS.toString(), member);
        return;
      }
    } catch (err) {
      logger.warn('Health service Redis error, using memory fallback', { error: err });
    }

    // In-memory fallback
    const entries = (this.memoryStore.get(key) || []).filter(ts => now - ts < this.WINDOW_MS);
    entries.push(now);
    this.memoryStore.set(key, entries);
  }

  private async getCount(key: string): Promise<number> {
    const now = Date.now();
    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const count = await redis.eval(COUNT_IN_WINDOW_SCRIPT, 1, key, now.toString(), this.WINDOW_MS.toString());
        return Number(count) || 0;
      }
    } catch (err) {
      logger.warn('Health service Redis count error, using memory fallback', { error: err });
    }

    // In-memory fallback
    const entries = (this.memoryStore.get(key) || []).filter(ts => now - ts < this.WINDOW_MS);
    this.memoryStore.set(key, entries);
    return entries.length;
  }

  private async setPaused(orgId: string): Promise<void> {
    const now = Date.now();
    const key = `health:${orgId}:paused_at`;
    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        // Only set if not already paused (NX = set if not exists)
        await redis.set(key, now.toString(), 'PX', this.WINDOW_MS, 'NX');
        return;
      }
    } catch (err) {
      // fallback below
    }
    if (!this.pauseStore.has(orgId)) {
      this.pauseStore.set(orgId, now);
    }
  }

  private async getPausedAt(orgId: string): Promise<number | null> {
    const key = `health:${orgId}:paused_at`;
    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const val = await redis.get(key);
        return val ? parseInt(val, 10) : null;
      }
    } catch (err) {
      // fallback below
    }
    return this.pauseStore.get(orgId) || null;
  }

  private async clearPaused(orgId: string): Promise<void> {
    const key = `health:${orgId}:paused_at`;
    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        await redis.del(key);
        return;
      }
    } catch (err) {
      // fallback below
    }
    this.pauseStore.delete(orgId);
  }
}

export default SendingHealthService;
