import { getCollection } from '../db';
import type { SuppressionEntry } from '../types';
import suppressionStore from '../stores/suppressionStore';
import logger from '../utils/logger';

interface Alert {
  id: string;
  type: 'high_bounce_rate' | 'suppression_growth' | 'low_delivery_rate' | 'high_complaint_rate' | 'high_failure_rate';
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  time_window: string;
  calculated_at: string;
}

// Alert thresholds configuration
const ALERT_THRESHOLDS = {
  bounce_rate: { warning: 2, critical: 5 },
  complaint_rate: { warning: 0.05, critical: 0.1 },
  failure_rate: { warning: 5, critical: 10 },
  delivery_rate: { warning: 95, critical: 90 }
};

const SUPPRESSION_GROWTH_THRESHOLD = 10; // 10% growth in suppressions

const calculateSuppressionGrowth = (suppressions: any[]): number => {
  if (suppressions.length === 0) return 0;
  
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const recentSuppressions = suppressions.filter(s => 
    new Date(s.created_at) >= oneWeekAgo
  );
  
  const olderSuppressions = suppressions.filter(s => 
    new Date(s.created_at) < oneWeekAgo
  );
  
  if (olderSuppressions.length === 0) {
    return recentSuppressions.length > 5 ? 20 : 0; // High growth for new inboxes
  }
  
  const growthRate = ((recentSuppressions.length - olderSuppressions.length) / olderSuppressions.length) * 100;
  return Math.max(0, growthRate);
};

// Calculate alerts only when requested via API
const calculateAlerts = async (inboxId: string, timeWindow: string): Promise<Alert[]> => {
  try {
    // Import monitoringService dynamically to avoid circular dependency
    const monitoringService = await import('./monitoringService');
    const suppressionStore = await import('../stores/suppressionStore');
    
    const [metrics, suppressions] = await Promise.all([
      monitoringService.default.calculateMetrics(inboxId, timeWindow),
      suppressionStore.default.getInboxSuppressions(inboxId)
    ]);
    
    const alerts: Alert[] = [];
    
    // Traditional threshold checks
    if (metrics.bounce_rate > ALERT_THRESHOLDS.bounce_rate.critical) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_bounce_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_bounce_rate',
        severity: 'critical',
        value: metrics.bounce_rate,
        threshold: ALERT_THRESHOLDS.bounce_rate.critical,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    } else if (metrics.bounce_rate > ALERT_THRESHOLDS.bounce_rate.warning) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_bounce_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_bounce_rate',
        severity: 'warning',
        value: metrics.bounce_rate,
        threshold: ALERT_THRESHOLDS.bounce_rate.warning,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    }
    
    if (metrics.complaint_rate > ALERT_THRESHOLDS.complaint_rate.critical) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_complaint_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_complaint_rate',
        severity: 'critical',
        value: metrics.complaint_rate,
        threshold: ALERT_THRESHOLDS.complaint_rate.critical,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    } else if (metrics.complaint_rate > ALERT_THRESHOLDS.complaint_rate.warning) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_complaint_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_complaint_rate',
        severity: 'warning',
        value: metrics.complaint_rate,
        threshold: ALERT_THRESHOLDS.complaint_rate.warning,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    }
    
    if (metrics.failure_rate > ALERT_THRESHOLDS.failure_rate.critical) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_failure_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_failure_rate',
        severity: 'critical',
        value: metrics.failure_rate,
        threshold: ALERT_THRESHOLDS.failure_rate.critical,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    } else if (metrics.failure_rate > ALERT_THRESHOLDS.failure_rate.warning) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-high_failure_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'high_failure_rate',
        severity: 'warning',
        value: metrics.failure_rate,
        threshold: ALERT_THRESHOLDS.failure_rate.warning,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    }
    
    if (metrics.delivery_rate < ALERT_THRESHOLDS.delivery_rate.critical) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-low_delivery_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'low_delivery_rate',
        severity: 'critical',
        value: metrics.delivery_rate,
        threshold: ALERT_THRESHOLDS.delivery_rate.critical,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    } else if (metrics.delivery_rate < ALERT_THRESHOLDS.delivery_rate.warning) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-low_delivery_rate-${calculatedAt}`;
      alerts.push({
        id,
        type: 'low_delivery_rate',
        severity: 'warning',
        value: metrics.delivery_rate,
        threshold: ALERT_THRESHOLDS.delivery_rate.warning,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    }
    
    // Context-aware calculations
    const recentSuppressionGrowth = calculateSuppressionGrowth(suppressions);
    if (recentSuppressionGrowth > SUPPRESSION_GROWTH_THRESHOLD) {
      const calculatedAt = new Date().toISOString();
      const id = `${inboxId}-suppression_growth-${calculatedAt}`;
      alerts.push({
        id,
        type: 'suppression_growth',
        severity: 'warning', 
        value: recentSuppressionGrowth,
        threshold: SUPPRESSION_GROWTH_THRESHOLD,
        time_window: timeWindow,
        calculated_at: calculatedAt
      });
    }
    
    // Store alerts for historical tracking
    if (alerts.length > 0) {
      await storeCalculatedAlerts(inboxId, alerts);
    }
    
    return alerts;
  } catch (error) {
    logger.error('Error calculating alerts', { error, inboxId });
    return [];
  }
};

// Store calculated alerts in database
const storeCalculatedAlerts = async (inboxId: string, alerts: Alert[]): Promise<void> => {
  try {
    const collection = await getCollection('calculated_alerts');
    if (!collection) return;
    
    // Log critical alerts
    const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
    if (criticalAlerts.length > 0) {
      logger.error('CRITICAL ALERT(S) detected', {
        inboxId,
        alerts: criticalAlerts,
      });
    }

    // Log warning alerts
    const warningAlerts = alerts.filter((a) => a.severity === 'warning');
    if (warningAlerts.length > 0) {
      logger.warn('Warning alert(s) detected', {
        inboxId,
        alerts: warningAlerts,
      });
    }
    
    // Use upsert to avoid duplicates within 5 minutes
    for (const alert of alerts) {
      await collection.updateOne(
        { 
          inbox_id: inboxId,
          alert_type: alert.type,
          calculated_at: { 
            $gte: new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
          }
        },
        { 
          $set: { 
            ...alert, 
            inbox_id: inboxId,
            expires_at: new Date(Date.now() + 60 * 60 * 1000) // 1 hour TTL
          }
        },
        { upsert: true }
      );
    }
  } catch (error) {
    logger.error('Error storing alerts', { error });
  }
};

// Get stored alerts for an inbox
const getStoredAlerts = async (inboxId: string, timeWindow?: string): Promise<Alert[]> => {
  try {
    const collection = await getCollection('calculated_alerts');
    if (!collection) return [];
    
    const query: any = { inbox_id: inboxId };
    
    if (timeWindow) {
      const startDate = new Date();
      switch (timeWindow) {
        case '1h':
          startDate.setHours(startDate.getHours() - 1);
          break;
        case '24h':
          startDate.setDate(startDate.getDate() - 1);
          break;
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
      }
      query.calculated_at = { $gte: startDate };
    }
    
    const alerts = await collection
      .find(query)
      .sort({ calculated_at: -1 })
      .limit(50)
      .toArray();
    
    return alerts.map((alert: any): Alert => ({
      id: alert.id || `${alert.inbox_id}-${alert.alert_type}-${alert.calculated_at}`,
      type: alert.alert_type,
      severity: alert.severity,
      value: alert.value,
      threshold: alert.threshold,
      time_window: alert.time_window,
      calculated_at: alert.calculated_at
    }));
  } catch (error) {
    logger.error('Error getting stored alerts', { error, inboxId });
    return [];
  }
};

export default {
  calculateAlerts,
  getStoredAlerts
};
