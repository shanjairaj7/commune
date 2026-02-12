import metricsCacheService from './metricsCacheService';
import logger from '../utils/logger';

// Track interval/timeout handles for proper shutdown
const activeTimers: { intervals: NodeJS.Timeout[]; timeouts: NodeJS.Timeout[] } = {
  intervals: [],
  timeouts: [],
};

// Start the metrics cache refresh scheduler
const startMetricsScheduler = (): void => {
  logger.info('Starting metrics cache scheduler');

  // Refresh cache every 30 minutes
  const refreshInterval = setInterval(async () => {
    try {
      logger.debug('Scheduled metrics cache refresh starting');
      await metricsCacheService.refreshAllActiveInboxes();
      logger.debug('Scheduled metrics cache refresh completed');
    } catch (error) {
      logger.error('Error in scheduled metrics refresh', { error });
    }
  }, 30 * 60 * 1000);
  activeTimers.intervals.push(refreshInterval);

  // Initial cache population on startup (after 5s to let DB connect)
  const initTimeout = setTimeout(async () => {
    try {
      logger.info('Initial metrics cache population starting');
      await metricsCacheService.refreshAllActiveInboxes();
      logger.info('Initial metrics cache population completed');
    } catch (error) {
      logger.error('Error in initial cache population', { error });
    }
  }, 5000);
  activeTimers.timeouts.push(initTimeout);
};

// Stop the scheduler — clears all intervals and pending timeouts
const stopMetricsScheduler = (): void => {
  logger.info('Stopping metrics cache scheduler');

  for (const interval of activeTimers.intervals) {
    clearInterval(interval);
  }
  for (const timeout of activeTimers.timeouts) {
    clearTimeout(timeout);
  }

  activeTimers.intervals = [];
  activeTimers.timeouts = [];

  logger.info('Metrics cache scheduler stopped');
};

export default {
  startMetricsScheduler,
  stopMetricsScheduler
};
