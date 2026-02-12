import metricsScheduler from './services/metricsScheduler';

// Initialize monitoring system on server startup
const initializeMonitoring = (): void => {
  console.log('🚀 Initializing monitoring system...');
  
  // Start the metrics cache scheduler
  metricsScheduler.startMetricsScheduler();
  
  console.log('✅ Monitoring system initialized successfully');
};

export default {
  initializeMonitoring
};
