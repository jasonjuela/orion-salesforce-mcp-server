import { Router } from 'express';
import { SessionStore } from '../config/sessionStore.js';

const router = Router();

// Simple in-memory metrics store
const metrics = {
  requests: {
    total: 0,
    successful: 0,
    failed: 0,
    byEndpoint: {}
  },
  queries: {
    total: 0,
    successful: 0,
    failed: 0,
    totalLatencyMs: 0
  },
  clarifications: {
    requested: 0,
    answered: 0
  },
  objects: {
    mostUsed: {},
    successRates: {}
  },
  startTime: Date.now()
};

// Middleware to track requests
export function trackRequest(endpoint, success = true, latencyMs = 0) {
  metrics.requests.total++;
  if (success) {
    metrics.requests.successful++;
  } else {
    metrics.requests.failed++;
  }
  
  if (!metrics.requests.byEndpoint[endpoint]) {
    metrics.requests.byEndpoint[endpoint] = { total: 0, successful: 0, failed: 0 };
  }
  
  const endpointMetrics = metrics.requests.byEndpoint[endpoint];
  endpointMetrics.total++;
  if (success) {
    endpointMetrics.successful++;
  } else {
    endpointMetrics.failed++;
  }
}

export function trackQuery(success = true, latencyMs = 0) {
  metrics.queries.total++;
  if (success) {
    metrics.queries.successful++;
  } else {
    metrics.queries.failed++;
  }
  metrics.queries.totalLatencyMs += latencyMs;
}

export function trackClarification(requested = false, answered = false) {
  if (requested) metrics.clarifications.requested++;
  if (answered) metrics.clarifications.answered++;
}

export function trackObjectUsage(objectApiName, success = true) {
  if (!metrics.objects.mostUsed[objectApiName]) {
    metrics.objects.mostUsed[objectApiName] = 0;
    metrics.objects.successRates[objectApiName] = { total: 0, successful: 0 };
  }
  
  metrics.objects.mostUsed[objectApiName]++;
  metrics.objects.successRates[objectApiName].total++;
  if (success) {
    metrics.objects.successRates[objectApiName].successful++;
  }
}

/**
 * GET /metrics - Return system metrics
 */
router.get('/', async (req, res) => {
  try {
    const uptimeMs = Date.now() - metrics.startTime;
    const uptimeHours = Math.round(uptimeMs / (1000 * 60 * 60) * 100) / 100;
    
    // Calculate derived metrics
    const requestErrorRate = metrics.requests.total > 0 
      ? Math.round((metrics.requests.failed / metrics.requests.total) * 10000) / 100 
      : 0;
      
    const queryErrorRate = metrics.queries.total > 0 
      ? Math.round((metrics.queries.failed / metrics.queries.total) * 10000) / 100 
      : 0;
      
    const avgQueryLatency = metrics.queries.total > 0 
      ? Math.round(metrics.queries.totalLatencyMs / metrics.queries.total) 
      : 0;
      
    const clarificationRate = metrics.clarifications.requested > 0 
      ? Math.round((metrics.clarifications.answered / metrics.clarifications.requested) * 10000) / 100 
      : 0;
    
    // Get top objects by usage
    const topObjects = Object.entries(metrics.objects.mostUsed)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([objectName, count]) => {
        const successRate = metrics.objects.successRates[objectName];
        const rate = successRate.total > 0 
          ? Math.round((successRate.successful / successRate.total) * 10000) / 100 
          : 0;
        return { object: objectName, usage: count, successRate: rate };
      });
    
    // Get session stats
    const activeSessions = Object.keys(metrics.sessions || {}).length;
    
    const response = {
      timestamp: new Date().toISOString(),
      uptime: {
        ms: uptimeMs,
        hours: uptimeHours
      },
      requests: {
        ...metrics.requests,
        errorRate: requestErrorRate,
        requestsPerHour: uptimeHours > 0 ? Math.round(metrics.requests.total / uptimeHours) : 0
      },
      queries: {
        ...metrics.queries,
        errorRate: queryErrorRate,
        avgLatencyMs: avgQueryLatency,
        queriesPerHour: uptimeHours > 0 ? Math.round(metrics.queries.total / uptimeHours) : 0
      },
      clarifications: {
        ...metrics.clarifications,
        answerRate: clarificationRate
      },
      objects: {
        topUsed: topObjects,
        totalUniqueObjects: Object.keys(metrics.objects.mostUsed).length
      },
      sessions: {
        active: activeSessions
      }
    };
    
    res.json(response);
    
  } catch (err) {
    res.status(500).json({ error: 'metrics_error', message: err?.message });
  }
});

/**
 * POST /metrics/reset - Reset all metrics (admin only)
 */
router.post('/reset', async (req, res) => {
  try {
    // Reset metrics
    metrics.requests = { total: 0, successful: 0, failed: 0, byEndpoint: {} };
    metrics.queries = { total: 0, successful: 0, failed: 0, totalLatencyMs: 0 };
    metrics.clarifications = { requested: 0, answered: 0 };
    metrics.objects = { mostUsed: {}, successRates: {} };
    metrics.startTime = Date.now();
    
    res.json({ success: true, message: 'Metrics reset successfully' });
    
  } catch (err) {
    res.status(500).json({ error: 'reset_error', message: err?.message });
  }
});

export default router;
