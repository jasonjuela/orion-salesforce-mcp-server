import { Router } from 'express';
import { sfClient } from '../services/salesforce.js';
import { buildSOSLPlan, shouldUseSOSL } from '../services/planner.js';
import { loadOrgProfile } from '../config/configLoader.js';
import { TokenStore } from '../config/tokenStore.js';
import { SessionStore } from '../config/sessionStore.js';
import { buildDescribeIndex } from '../services/schemaIndex.js';
import { resolveObjectsIntelligently } from '../services/intelligentResolver.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * POST /search/cross-object
 * Perform cross-object search using SOSL
 */
router.post('/cross-object', async (req, res) => {
  try {
    const { search_term, org_id, sessionId = 'dev', objects, limit = 200 } = req.body || {};
    
    if (!search_term || !org_id) {
      return res.status(400).json({ 
        error: 'search_term and org_id required',
        example: {
          search_term: "Cockburn's wine",
          org_id: "default",
          objects: ["owsc__Item__c", "Account", "Contact"], // optional
          limit: 100 // optional
        }
      });
    }

    // Get Salesforce client
    let tokenCtx = TokenStore.get(sessionId, org_id) || req.sfToken;
    if (!tokenCtx) tokenCtx = { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) {
      return res.status(401).json({ error: 'missing_salesforce_token' });
    }
    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });

    // Load org configuration
    const orgProfile = await loadOrgProfile(org_id);

    // Build describe index for specified objects or intelligent resolution
    let targetObjects = objects;
    if (!targetObjects || targetObjects.length === 0) {
      // Use intelligent resolver to find relevant objects
      const resolution = await resolveObjectsIntelligently(search_term, sf, orgProfile, {
        sessionId,
        threshold: 0.3,
        maxSuggestions: 10
      });
      
      targetObjects = resolution.suggestions?.map(s => s.apiName) || ['Account', 'Contact'];
    }

    // Build describe index for all target objects
    const describeIndex = await buildDescribeIndex(sf, targetObjects, { orgId: org_id });

    // Build SOSL plan
    const plan = buildSOSLPlan({
      question: search_term,
      entities: targetObjects,
      orgProfile,
      describeIndex,
      session: {},
      limit: parseInt(limit) || 200
    });

    logger.info('SOSL search plan created', { 
      sessionId, 
      searchTerm: search_term, 
      targetObjects,
      sosl: plan.query 
    });

    // Execute SOSL search
    const startTime = Date.now();
    const data = await sf.search(plan.query);
    const executionTime = Date.now() - startTime;

    // Process SOSL results
    const results = {};
    let totalRecords = 0;

    for (const [objectType, records] of Object.entries(data.searchRecords || {})) {
      results[objectType] = (records || []).map(record => ({
        ...record,
        _searchScore: record.score || 1.0
      }));
      totalRecords += results[objectType].length;
    }

    // Track usage
    SessionStore.trackObjectUsage(sessionId, search_term, targetObjects[0], true);

    res.json({
      success: true,
      searchTerm: search_term,
      sosl: plan.query,
      results,
      metadata: {
        totalRecords,
        objectsSearched: Object.keys(results),
        executionTimeMs: executionTime,
        targetObjects: plan.targetObjects,
        searchTerms: plan.searchTerms
      }
    });

  } catch (error) {
    logger.error('SOSL search failed', { error: error.message, stack: error.stack });
    
    // Track failure
    if (req.body?.sessionId && req.body?.search_term) {
      SessionStore.trackObjectUsage(req.body.sessionId, req.body.search_term, 'unknown', false);
    }

    const sfError = error?.response?.data || error?.message || String(error);
    res.status(500).json({
      success: false,
      error: 'search_failed',
      message: sfError,
      sosl: req.body?.sosl
    });
  }
});

/**
 * GET /search/capabilities
 * Get search capabilities and configuration
 */
router.get('/capabilities', async (req, res) => {
  try {
    const { org_id, sessionId = 'dev' } = req.query;
    
    if (!org_id) {
      return res.status(400).json({ error: 'org_id required' });
    }

    // Get Salesforce client
    let tokenCtx = TokenStore.get(sessionId, org_id) || req.sfToken;
    if (!tokenCtx) tokenCtx = { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) {
      return res.status(401).json({ error: 'missing_salesforce_token' });
    }
    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });

    // Load org configuration
    const orgProfile = await loadOrgProfile(org_id);

    // Get available objects
    const allObjects = await sf.listSObjects();
    const searchableObjects = allObjects
      .filter(obj => obj.searchable && obj.queryable && !obj.deprecatedAndHidden)
      .map(obj => ({
        apiName: obj.name,
        label: obj.label,
        searchable: obj.searchable,
        custom: obj.custom
      }))
      .slice(0, 50); // Limit for performance

    res.json({
      success: true,
      capabilities: {
        soslSupported: true,
        crossObjectSearch: true,
        maxObjects: 10,
        maxLimit: 2000,
        defaultLimit: 200
      },
      searchableObjects,
      orgProfile: {
        objectSynonyms: orgProfile?.objectSynonyms || {},
        guardrails: orgProfile?.guardrails || {}
      },
      examples: [
        {
          description: "Search for a specific product across objects",
          request: {
            search_term: "Cockburn's wine",
            objects: ["owsc__Item__c", "Product2"],
            limit: 50
          }
        },
        {
          description: "Global search across all objects",
          request: {
            search_term: "John Smith",
            limit: 100
          }
        }
      ]
    });

  } catch (error) {
    logger.error('Search capabilities query failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'capabilities_query_failed',
      message: error.message
    });
  }
});

export default router;
