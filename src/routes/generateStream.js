import { Router } from 'express';
import { sseHeaders, chatCompleteStream } from '../services/llm/openaiAdapter.js';
import { detectIntent, resolveEntities, buildSoqlPlan, planRelationshipPath, isQuestionTimeSensitive, shouldUseSOSL, buildSOSLPlan } from '../services/planner.js';
import { loadOrgProfile, loadPersona, loadDefaults } from '../config/configLoader.js';
import { TokenStore } from '../config/tokenStore.js';
import { SessionStore } from '../config/sessionStore.js';
import { sfClient } from '../services/salesforce.js';
import { buildDescribeIndex, expandDescribeIndex, filterAllowedFields, chooseOrderBy, buildObjectCatalog, pickGroupByLookup } from '../services/schemaIndex.js';
import { resolveDateRange, normalizeDateMacro } from '../utils/dateUtils.js';
import { resolveObjectsIntelligently, isProblematicSystemObject } from '../services/intelligentResolver.js';
import { validateQuerySecurity } from '../utils/security.js';
import { logger } from '../utils/logger.js';

const router = Router();

async function handleGenerateStream(req, res, isGet = false) {
  sseHeaders(res);
  try {
    // Send an immediate readiness event so the client UI shows activity
    try { res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`); } catch {}
    const source = isGet ? (req.query || {}) : (req.body || {});
    const user_question = String(source.user_question || source.q || '');
    const org_id = String(source.org_id || source.orgId || '');
    const sessionId = String(source.sessionId || 'dev');
    if (!user_question || !org_id) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'user_question and org_id required' })}\n\n`);
      return res.end();
    }
    const tokenCtx = TokenStore.get(sessionId, org_id) || { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'missing_salesforce_token' })}\n\n`);
      return res.end();
    }

    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });
    const orgProfile = await loadOrgProfile(org_id);
    const userPreferences = SessionStore.getObjectPreferences(sessionId);
    
    // Check DML capabilities from org configuration
    const dmlConfig = orgProfile.features?.dmlOperations || {};
    const capabilities = {
      read: true, // Always allow read operations
      dml: {
        enabled: dmlConfig.enabled || false,
        insert: dmlConfig.allowedOperations?.insert || false,
        update: dmlConfig.allowedOperations?.update || false,
        upsert: dmlConfig.allowedOperations?.upsert || false,
        delete: dmlConfig.allowedOperations?.delete || false,
        undelete: dmlConfig.allowedOperations?.undelete || false,
        merge: dmlConfig.allowedOperations?.merge || false
      }
    };
    
    // Check for cached clarification answers first
    const existingClarification = SessionStore.getClarification(sessionId, user_question);
    let resolution;
    
    if (existingClarification) {
      // Use previously clarified answer
      resolution = {
        success: true,
        primaryMatch: { apiName: existingClarification.answer.object },
        confidence: 1.0,
        needsClarification: false
      };
      logger.info('Using cached clarification in stream', { sessionId, question: user_question, object: resolution.primaryMatch.apiName });
    } else {
      // Use intelligent resolver for rock-solid object detection
      resolution = await resolveObjectsIntelligently(user_question, sf, orgProfile, {
        sessionId,
        userPreferences,
        threshold: 0.5,
        maxSuggestions: 3
      });
    }
    
    const intent = detectIntent(user_question);
    
    // Check if this should be a cross-object search (SOSL) before requiring object resolution
    const useSOSL = shouldUseSOSL(user_question, intent);
    
    // For non-SOSL queries, we need successful object resolution
    if (!useSOSL && !resolution.success) {
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        error: 'needs_object', 
        message: resolution.clarificationMessage 
      })}\n\n`);
      return res.end();
    }
    
    // Handle clarification needed (only for non-SOSL queries)
    if (!useSOSL && resolution.needsClarification) {
      const suggestions = resolution.suggestions.map(s => ({
        apiName: s.apiName,
        label: s.label,
        confidence: Math.round(s.confidence * 100)
      }));
      
      res.write(`data: ${JSON.stringify({ 
        type: 'clarification', 
        message: resolution.clarificationMessage,
        suggestions 
      })}\n\n`);
      return res.end();
    }
    
    let targetObject = resolution.success ? resolution.primaryMatch.apiName : 'Account'; // Default for SOSL
    let describeIndex;
    
    // Build initial describe index only for non-SOSL queries
    if (!useSOSL) {
      describeIndex = await buildDescribeIndex(sf, [targetObject]);
      describeIndex = await expandDescribeIndex(sf, describeIndex, targetObject, 2, { orgId: org_id });
    }
    let plan;
    
    if (useSOSL) {
      // For SOSL, we don't need a specific target object - build with minimal objects first
      const soslPlan = buildSOSLPlan({ 
        question: user_question, 
        entities: resolution.success ? [targetObject] : [], 
        orgProfile, 
        describeIndex: {}, // Start with empty index 
        session: {},
        capabilities
      });
      
      // Build describe index with SOSL target objects
      describeIndex = await buildDescribeIndex(sf, soslPlan.targetObjects, { orgId: org_id });
      
      plan = soslPlan;
    } else {
      // Only resolve dateRange if the question is time-sensitive
      let dateRange;
      if (isQuestionTimeSensitive(user_question)) {
        dateRange = normalizeDateMacro(resolveDateRange(user_question, orgProfile, {}));
      }
      if (intent === 'aggregate' || intent === 'list_related_records') {
        const relHint = (user_question || '').toLowerCase().match(/[a-z][a-z0-9_]+/g) || [];
        const path = planRelationshipPath(describeIndex, targetObject, relHint);
        if (path && path.objectApiName && path.objectApiName !== targetObject) {
          targetObject = path.objectApiName;
          describeIndex = await buildDescribeIndex(sf, [targetObject]);
          describeIndex = await expandDescribeIndex(sf, describeIndex, targetObject, 1, { orgId: org_id });
        }
      }
      plan = buildSoqlPlan({ intent, entities: [targetObject], orgProfile, describeIndex, session: {}, countOnly: false, dateRange, question: user_question, capabilities });
    }
    // Security validation for streaming (skip for SOSL as it has built-in security)
    if (!useSOSL) {
      const securityCheck = await validateQuerySecurity(sf, targetObject, plan.fields || [], orgProfile);
      if (!securityCheck.allowed) {
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          error: 'access_denied',
          message: 'Query not allowed by security policy',
          reasons: securityCheck.blockedReasons 
        })}\n\n`);
        return res.end();
      }
    }
    
    // Apply field filtering and query refinement only for SOQL queries
    if (!useSOSL) {
      plan.fields = filterAllowedFields(describeIndex, plan.object, plan.fields);
      // Only rewrite SELECT/ORDER for non-aggregate flows
      if (intent !== 'aggregate') {
        if (!plan.fields.includes('Id')) plan.fields.unshift('Id');
        plan.soql = plan.soql.replace(/^SELECT\s+[^F]+FROM/i, `SELECT ${plan.fields.join(', ')} FROM`);
        const orderBy = chooseOrderBy(describeIndex, plan.object);
        plan.soql = plan.soql.replace(/ORDER BY[^L]+LIMIT/, `ORDER BY ${orderBy} DESC LIMIT`);
      }
      // For aggregates, just do a simple query - SOQL doesn't support GROUP BY
      if (intent === 'aggregate') {
        // Keep the original simple query plan
      } else {
        try {
          const tentative = [];
          const path = planRelationshipPath(describeIndex, plan.object, []);
          for (const step of path?.path || []) {
            if (step.type === 'parent' && step.relName) tentative.push(`${step.relName}__r.Name`);
          }
          if (tentative.length) plan.fields = Array.from(new Set([...plan.fields, ...tentative.slice(0, 2)]));
        } catch {}
      }
    }
    res.write(`data: ${JSON.stringify({ type: 'plan', plan })}\n\n`);

    let data;
    try {
      if (useSOSL) {
        // Execute SOSL search
        data = await sf.search(plan.query);
        
        // Flatten SOSL results for easier consumption
        const allRecords = [];
        
        // SOSL returns searchRecords as an array of objects
        const searchRecords = data.searchRecords || [];
        
        if (Array.isArray(searchRecords)) {
          for (const record of searchRecords) {
            allRecords.push({
              ...record,
              _objectType: record.attributes?.type || 'Unknown',
              _searchScore: 1.0 // SOSL doesn't provide scores like SOQL
            });
          }
        }
        
        data = { records: allRecords, totalSize: allRecords.length };
        res.write(`data: ${JSON.stringify({ type: 'data', rows: data.records?.length || 0, searchType: 'SOSL' })}\n\n`);
      } else {
        // Execute SOQL query
        data = await sf.query(plan.soql);
        res.write(`data: ${JSON.stringify({ type: 'data', rows: data.records?.length || 0, searchType: 'SOQL' })}\n\n`);
      }
      // Track successful object usage for preference learning
      const trackingObject = useSOSL ? 'SOSL_SEARCH' : targetObject;
      SessionStore.trackObjectUsage(sessionId, user_question, trackingObject, true);
    } catch (e) {
      const sfErr = e?.response?.data || e?.message || String(e);
      const queryInfo = useSOSL ? { sosl: plan.query } : { soql: plan.soql };
      res.write(`data: ${JSON.stringify({ type: 'error', error: sfErr, ...queryInfo })}\n\n`);
      // Track failed object usage
      const trackingObject = useSOSL ? 'SOSL_SEARCH' : targetObject;
      SessionStore.trackObjectUsage(sessionId, user_question, trackingObject, false);
      return res.end();
    }

    // Build enhanced LLM prompt with data context for hybrid approach
    const dataPreview = data.records?.slice(0, 10) || []; // Show first 10 records for context
    const totalRecords = data.records?.length || 0;
    
    const system = `You are a Salesforce data assistant. When you have retrieved data from Salesforce, use it to provide specific, data-driven answers. When data is insufficient or unavailable, provide general knowledge while clearly stating the limitation.

IMPORTANT: You have retrieved ${totalRecords} records from Salesforce using ${useSOSL ? 'cross-object search (SOSL)' : 'object query (SOQL)'}. Use this data to answer the user's question with specific details and insights from their actual data.

AVAILABLE CAPABILITIES:
- Read Operations: ${capabilities.read ? 'ENABLED' : 'DISABLED'} - Query and retrieve Salesforce data
- DML Operations: ${capabilities.dml.enabled ? 'ENABLED' : 'DISABLED'}${capabilities.dml.enabled ? `
  - Insert: ${capabilities.dml.insert ? 'ENABLED' : 'DISABLED'}
  - Update: ${capabilities.dml.update ? 'ENABLED' : 'DISABLED'}
  - Upsert: ${capabilities.dml.upsert ? 'ENABLED' : 'DISABLED'}
  - Delete: ${capabilities.dml.delete ? 'ENABLED' : 'DISABLED'}
  - Undelete: ${capabilities.dml.undelete ? 'ENABLED' : 'DISABLED'}
  - Merge: ${capabilities.dml.merge ? 'ENABLED' : 'DISABLED'}` : ' - All DML operations are currently disabled'}

${!capabilities.dml.enabled ? 'NOTE: You can only provide information and insights based on existing data. You cannot create, modify, or delete records.' : 'NOTE: When suggesting data modifications, consider the enabled DML operations listed above.'}`;

    const queryInfo = useSOSL ? `SOSL SEARCH: ${plan.query}` : `SOQL QUERY: ${plan.soql || plan.query}`;
    const dataContext = totalRecords > 0 ? 
      `\n\nRETRIEVED SALESFORCE DATA (${totalRecords} total records, showing first ${Math.min(10, totalRecords)}):\n${JSON.stringify(dataPreview, null, 2)}\n\n${queryInfo}` : 
      `\n\nNo data was retrieved from Salesforce. Provide general guidance.`;

    const messages = [ 
      { role: 'system', content: system }, 
      { role: 'user', content: user_question + dataContext } 
    ];
    await chatCompleteStream({
      messages,
      onDelta: (delta) => {
        res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`);
      },
      onDone: () => {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
    });
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err?.message })}\n\n`);
    res.end();
  }
}

router.post('/generate/stream', (req, res) => handleGenerateStream(req, res, false));
router.get('/generate/stream', (req, res) => handleGenerateStream(req, res, true));

export default router;


