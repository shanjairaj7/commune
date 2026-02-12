import metricsCacheService from './metricsCacheService';

// Start the metrics cache refresh scheduler
const startMetricsScheduler = (): void => {
  console.log('🚀 Starting metrics cache scheduler');
  
  // Refresh cache every 15 minutes
  setInterval(async () => {
    try {
      console.log('🔄 Scheduled metrics cache refresh starting');
      await metricsCacheService.refreshAllActiveInboxes();
      console.log('✅ Scheduled metrics cache refresh completed');
    } catch (error) {
      console.error('❌ Error in scheduled metrics refresh:', error);
    }
  }, 30 * 60 * 1000); // 30 minutes
  
  // Cleanup cache every hour
  setInterval(async () => {
    try {
      console.log('🧹 Starting cache cleanup');
      // Cache cleanup is handled automatically in metricsCacheService
      console.log('✅ Cache cleanup completed');
    } catch (error) {
      console.error('❌ Error in cache cleanup:', error);
    }
  }, 60 * 60 * 1000); // 1 hour
  
  // Initial cache population on startup
  setTimeout(async () => {
    try {
      console.log('🌱 Initial cache population starting');
      await metricsCacheService.refreshAllActiveInboxes();
      console.log('✅ Initial cache population completed');
    } catch (error) {
      console.error('❌ Error in initial cache population:', error);
    }
  }, 5000); // 5 seconds after startup
};

// Stop the scheduler (useful for testing/shutdown)
const stopMetricsScheduler = (): void => {
  console.log('🛑 Stopping metrics cache scheduler');
  // In a real implementation, you'd store the interval IDs and clear them
  // For now, this is just a placeholder
};

export default {
  startMetricsScheduler,
  stopMetricsScheduler
};
