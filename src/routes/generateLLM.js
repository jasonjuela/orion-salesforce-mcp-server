import { Router } from 'express';
import { sfClient } from '../services/salesforce.js';
import { generateLLMQuery, shouldUseSOSLWithLLM } from '../services/llmQueryGenerator.js';
import { buildEnhancedDescribeIndex } from '../services/enhancedDescribe.js';
import { loadOrgProfile, loadPersona, loadDefaults, loadBusinessContext } from '../config/configLoader.js';
import { SessionStore } from '../config/sessionStore.js';
import { TokenStore } from '../config/tokenStore.js';
import { buildTableSchema, validate } from '../utils/jsonSchema.js';
import { chatComplete } from '../services/llm/openaiAdapter.js';
import { withRetry } from '../utils/withRetry.js';
import { shouldRetryLLM } from '../utils/retryPolicies.js';
import { redactPII } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import { enforceFls, validateQuerySecurity } from '../utils/security.js';

const router = Router();

// Simple schema-intent detection (generic, no hardcoding of business logic)
function detectSchemaIntent(question = '') {
  const q = String(question).toLowerCase();
  const triggers = ['field', 'fields', 'columns', 'schema', 'describe'];
  return triggers.some(t => q.includes(t));
}

// Detect wine pairing expertise questions (configuration-driven)
function detectWinePairingExpertise(question = '', businessContext = {}) {
  const wineExpertise = businessContext?.wineExpertiseDetection || {
    enabled: true,
    pairingTriggers: ['goes with', 'pair with', 'best with', 'match with', 'complement', 'goes well with'],
    foodTriggers: ['steak', 'beef', 'lamb', 'chicken', 'fish', 'salmon', 'lobster', 'cheese', 'chocolate', 'dessert', 'dinner']
  };
  
  if (!wineExpertise.enabled) return false;
  
  const q = String(question).toLowerCase();
  const hasPairingTrigger = wineExpertise.pairingTriggers.some(t => q.includes(t));
  const hasFoodTrigger = wineExpertise.foodTriggers.some(f => q.includes(f));
  
  return hasPairingTrigger && hasFoodTrigger;
}

// Resolve an object API name from the MCP enhanced describe catalog using labels/plurals
function resolveObjectFromCatalog(question = '', enhancedDescribeIndex) {
  if (!enhancedDescribeIndex) return null;
  const q = String(question).toLowerCase();
  // Prefer the catalog if available
  const list = Array.isArray(enhancedDescribeIndex.objects)
    ? enhancedDescribeIndex.objects
    : Object.values(enhancedDescribeIndex.objects || {});
  for (const entry of list) {
    if (!entry) continue;
    const api = String(entry.apiName || '').toLowerCase();
    const label = String(entry.label || '').toLowerCase();
    const plural = String(entry.labelPlural || '').toLowerCase();
    if (!api && !label && !plural) continue;
    if (q.includes(api) || (label && q.includes(label)) || (plural && q.includes(plural))) {
      return entry.apiName || null;
    }
  }
  return null;
}

// LLM-based pairing intent detection (fallback when simple triggers miss)
async function detectWinePairingIntentLLM(question, chatFn) {
  try {
    const system = `You are a classifier. Determine if the user's question is asking for wine pairing with food.
Respond ONLY with JSON: { "isPairing": true|false }`;
    const res = await chatFn([
      { role: 'system', content: system },
      { role: 'user', content: question || '' }
    ], { temperature: 0.0, max_tokens: 50 });
    const parsed = JSON.parse(res?.choices?.[0]?.message?.content || '{}');
    return !!parsed.isPairing;
  } catch {
    return false;
  }
}

// Enforce status filter and limit on SOQL for wine expertise flows
function enforceWineSoqlConstraints(soql, statusFilter, limit) {
  if (!soql || typeof soql !== 'string') return soql;
  const lower = soql.toLowerCase();
  const idxOrderBy = lower.indexOf(' order by ');
  const idxLimit = lower.indexOf(' limit ');

  let head = soql;
  let tail = '';
  const splitIdx = idxOrderBy >= 0 ? idxOrderBy : (idxLimit >= 0 ? idxLimit : -1);
  if (splitIdx >= 0) {
    head = soql.substring(0, splitIdx);
    tail = soql.substring(splitIdx);
  }

  // Status filter
  const hasWhere = head.toLowerCase().includes(' where ');
  const hasStatus = head.toLowerCase().includes(statusFilter.toLowerCase());
  if (!hasStatus) {
    if (hasWhere) {
      head = head + ` AND ${statusFilter}`;
    } else {
      head = head + ` WHERE ${statusFilter}`;
    }
  }

  // Limit enforcement
  let newTail = tail;
  if (idxLimit >= 0) {
    // Replace any existing LIMIT with the configured limit
    const limitMatch = /limit\s+\d+/i;
    newTail = tail.replace(limitMatch, `LIMIT ${limit}`);
  } else {
    newTail = `${tail} LIMIT ${limit}`;
  }

  return head + newTail;
}

/**
 * NEW: LLM-Driven Query Generation Route
 * 
 * This route replaces hardcoded regex patterns and business logic with
 * intelligent LLM-based query planning using Salesforce describe metadata
 * and minimal business context configuration.
 */
router.post('/', async (req, res) => {
  try {
    const { user_question, org_id, sessionId = 'dev', request_hints, persona: personaName } = req.body || {};
    if (!user_question || !org_id) return res.status(400).json({ error: 'user_question and org_id required' });

    // Setup Salesforce client
    let tokenCtx = TokenStore.get(sessionId, org_id) || req.sfToken;
    if (!tokenCtx) tokenCtx = { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) return res.status(401).json({ error: 'missing_salesforce_token' });
    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });

    // Load configuration and session
    const [orgProfile, persona, defaults, businessContext] = await Promise.all([
      loadOrgProfile(org_id),
      loadPersona(personaName),
      loadDefaults(),
      loadBusinessContext(org_id)
    ]);
    const session = SessionStore.get(sessionId);

    logger.info({ sessionId, orgId: org_id, question: user_question }, 'Starting LLM-driven query generation');

    // STEP 0: Defer conversational detection until after metadata load (to reduce false positives)

    // STEP 1: Build comprehensive Salesforce metadata for LLM
    const enhancedDescribeIndex = await buildEnhancedDescribeIndex(sf, org_id, {
      maxObjects: 50, // Limit for LLM context window
      includeAllCustom: true
    });

    logger.info({ 
      objects: enhancedDescribeIndex.objects.length,
      relationships: enhancedDescribeIndex.relationships.length 
    }, 'Enhanced describe index built');

    // STEP 1.5: Now safely check if this is conversational (after we have context)
    try {
      // Heuristic: derive SF object tokens from metadata to detect data questions
      const sfTokens = new Set();
      try {
        for (const obj of enhancedDescribeIndex.objects || []) {
          const api = obj.apiName || '';
          // strip namespace and suffix
          const noNs = api.replace(/^.*__/, '').replace(/__c$/i, '');
          const parts = noNs.split(/[_\s]+/).map(p => p.toLowerCase()).filter(Boolean);
          for (const p of parts) {
            sfTokens.add(p);
            sfTokens.add(p + 's'); // simple plural
          }
        }
      } catch {}

      const conversationalCheck = await detectConversationalQuery({
        question: user_question,
        businessContext: businessContext,
        orgId: org_id
      });

      // Only treat as conversational if confidence is high and no obvious Salesforce cues
      const ql = user_question.toLowerCase();
      const hasOrgPhrase = /\bin (this|my) org\b/.test(ql);
      const hasSqlish = /(select\s+|from\s+|where\s+|order by|count\(|limit\b|soql|sosl)/i.test(ql);
      const hasSfToken = Array.from(sfTokens).some(t => t && ql.includes(t));
      const looksLikeSF = hasOrgPhrase || hasSqlish || hasSfToken;
      if (conversationalCheck.isConversational && conversationalCheck.confidence >= 0.8 && !looksLikeSF) {
        logger.info({ 
          reasoning: conversationalCheck.reasoning,
          confidence: conversationalCheck.confidence 
        }, 'Detected conversational query - responding naturally');
        
        return await handleConversationalQuery({
          question: user_question,
          persona: persona,
          sessionId,
          orgId: org_id,
          res,
          businessContext
        });
      }
      
      logger.info({ isConversational: false, confidence: conversationalCheck.confidence, looksLikeSF }, 'Proceeding with Salesforce processing');
    } catch (conversationalError) {
      logger.warn({ error: conversationalError.message }, 'Conversational detection failed, proceeding with Salesforce processing');
    }

    // EARLY: Schema intent shortcut - handle before LLM planning to avoid dependency on queryType
    if (detectSchemaIntent(user_question)) {
      try {
        // Resolve target object from catalog (handles plurals/labels)
        let resolvedApi = resolveObjectFromCatalog(user_question, enhancedDescribeIndex);
        // Fallback: if not resolved, use global describe to match label/plural
        if (!resolvedApi) {
          try {
            const allObjects = await sf.listSObjects();
            const qLower = String(user_question || '').toLowerCase();
            const candidates = allObjects.filter(o => {
              const label = String(o.label || '').toLowerCase();
              const plural = String(o.labelPlural || '').toLowerCase();
              return (label && qLower.includes(label)) || (plural && qLower.includes(plural));
            });
            candidates.sort((a, b) => (b.custom === true) - (a.custom === true));
            if (candidates[0]?.name) resolvedApi = candidates[0].name;
          } catch (e) {
            logger.warn({ error: e.message }, 'Global describe fallback failed');
          }
        }
        if (!resolvedApi) throw new Error('Unable to resolve target object for schema intent');

        // Use MCP-enhanced describe index first (no extra API call)
        let objectData = null;
        try {
          const container = enhancedDescribeIndex.objects;
          if (Array.isArray(container)) {
            objectData = container.find(o => o?.apiName === resolvedApi);
          } else if (container && typeof container === 'object') {
            objectData = container[resolvedApi] || null;
          }
        } catch {}

        let fieldsSource = Array.isArray(objectData?.fields) ? objectData.fields : null;

        if (!fieldsSource) {
          // On-demand fetch describe for the specific target object (expand context as needed)
          try {
            const liveDescribe = await sf.describeSObject(resolvedApi);
            if (liveDescribe && Array.isArray(liveDescribe.fields)) {
              fieldsSource = (liveDescribe.fields || []).map(f => ({
                name: f.name,
                label: f.label,
                type: f.type,
                nillable: f.nillable,
                updateable: f.updateable,
                createable: f.createable,
                relationshipName: f.relationshipName,
                referenceTo: f.referenceTo,
                length: f.length,
                precision: f.precision,
                scale: f.scale
              }));
            }
          } catch (e) {
            logger.warn({ error: e.message, object: resolvedApi }, 'On-demand describe fetch failed');
          }
        }

        if (!fieldsSource) {
          throw new Error('Describe not available');
        }

        logger.info({ targetObject: resolvedApi }, 'Schema mode engaged - returning fields from describe');

        const fields = fieldsSource.map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: f.nillable === false,
          updateable: f.updateable !== false,
          createable: f.createable !== false,
          relationshipName: f.relationshipName || null,
          referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo.join(', ') : (f.referenceTo || ''),
          length: f.length ?? null,
          precision: f.precision ?? null,
          scale: f.scale ?? null
        }));

        const columns = ['name','label','type','required','updateable','createable','relationshipName','referenceTo','length','precision','scale'];
        const rows = fields.map(f => columns.map(c => (f[c] !== undefined && f[c] !== null) ? f[c] : null));
        const payload = {
          type: 'table',
          content: { columns, rows },
          metadata: {
            objects: [resolvedApi],
            schema: true,
            source: fieldsSource === objectData?.fields ? 'enhancedDescribeIndex' : 'liveDescribe',
            total: rows.length,
            confidence: 1.0
          }
        };

        const schema = buildTableSchema(columns);
        const { ok } = validate(schema, payload);
        if (!ok) {
          return res.json({ type: 'text', content: `Fields for ${resolvedApi} (first 20):\n` + fields.slice(0,20).map(f=>`- ${f.name} (${f.type})`).join('\n'), metadata: payload.metadata });
        }
        return res.json(payload);
      } catch (e) {
        logger.warn({ error: e.message }, 'Schema mode failed; proceeding to LLM planning as fallback');
      }
    }

    // STEP 2: Let LLM determine if this needs cross-object search (SOSL)
    const soslDecision = await shouldUseSOSLWithLLM({ 
      question: user_question, 
      describeIndex: enhancedDescribeIndex, 
      orgId: org_id 
    });

    logger.info({ 
      useSOSL: soslDecision.useSOSL, 
      reasoning: soslDecision.reasoning 
    }, 'SOSL decision made by LLM');

    // STEP 3: Generate optimized query using LLM
    const queryPlan = await generateLLMQuery({
      question: user_question,
      describeIndex: enhancedDescribeIndex,
      orgId: org_id,
      session: session
    });

    logger.info({ 
      queryType: queryPlan.queryType,
      targetObject: queryPlan.targetObject,
      confidence: queryPlan.confidence,
      businessContext: queryPlan.businessContext
    }, 'LLM query plan generated');

    // NEW: Schema intent shortcut - return Describe fields from MCP index (or on-demand) instead of running data query
    if (detectSchemaIntent(user_question)) {
      try {
        // Resolve target object from catalog (handles plurals/labels)
        let resolvedApi = resolveObjectFromCatalog(user_question, enhancedDescribeIndex) || queryPlan?.targetObject;
        // Fallback: search full global describe if not present in limited enhanced index
        if (!resolvedApi) {
          try {
            const allObjects = await sf.listSObjects();
            const qLower = String(user_question || '').toLowerCase();
            // Prefer custom/business objects whose label or plural appears in the question
            const candidates = allObjects.filter(o => {
              const label = String(o.label || '').toLowerCase();
              const plural = String(o.labelPlural || '').toLowerCase();
              return (label && qLower.includes(label)) || (plural && qLower.includes(plural));
            });
            // If multiple, prefer custom ones
            candidates.sort((a, b) => (b.custom === true) - (a.custom === true));
            if (candidates[0]?.name) resolvedApi = candidates[0].name;
          } catch (e) {
            logger.warn({ error: e.message }, 'Global describe fallback failed');
          }
        }
        if (!resolvedApi) throw new Error('Unable to resolve target object for schema intent');

        // Use MCP-enhanced describe index first (no extra API call)
        let objectData = null;
        try {
          const container = enhancedDescribeIndex.objects;
          if (Array.isArray(container)) {
            objectData = container.find(o => o?.apiName === resolvedApi);
          } else if (container && typeof container === 'object') {
            objectData = container[resolvedApi] || null;
          }
        } catch {}

        // Prefer fields from MCP index if present
        let fieldsSource = Array.isArray(objectData?.fields) ? objectData.fields : null;

        if (!fieldsSource) {
          // On-demand fetch describe for the specific target object (expand context as needed)
          try {
            const liveDescribe = await sf.describeSObject(resolvedApi);
            if (liveDescribe && Array.isArray(liveDescribe.fields)) {
              // Map raw describe fields to the same shape processFieldsForLLM provides
              fieldsSource = (liveDescribe.fields || []).map(f => ({
                name: f.name,
                label: f.label,
                type: f.type,
                nillable: f.nillable,
                updateable: f.updateable,
                createable: f.createable,
                relationshipName: f.relationshipName,
                referenceTo: f.referenceTo,
                length: f.length,
                precision: f.precision,
                scale: f.scale
              }));
            }
          } catch (e) {
            logger.warn({ error: e.message, object: queryPlan.targetObject }, 'On-demand describe fetch failed');
          }
        }

        if (!fieldsSource) {
          throw new Error('Describe not available');
        }

        logger.info({ targetObject: resolvedApi }, 'Schema mode engaged - returning fields from describe');

        const fields = fieldsSource.map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: f.nillable === false,
          updateable: f.updateable !== false,
          createable: f.createable !== false,
          relationshipName: f.relationshipName || null,
          referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo.join(', ') : (f.referenceTo || ''),
          length: f.length ?? null,
          precision: f.precision ?? null,
          scale: f.scale ?? null
        }));

        const columns = ['name','label','type','required','updateable','createable','relationshipName','referenceTo','length','precision','scale'];
        const rows = fields.map(f => columns.map(c => (f[c] !== undefined && f[c] !== null) ? f[c] : null));
        const payload = {
          type: 'table',
          content: { columns, rows },
          metadata: {
            objects: [resolvedApi],
            schema: true,
            source: fieldsSource === objectData?.fields ? 'enhancedDescribeIndex' : 'liveDescribe',
            total: rows.length,
            confidence: queryPlan.confidence,
            businessContext: queryPlan.businessContext
          }
        };

        // Validate
        const schema = buildTableSchema(columns);
        const { ok } = validate(schema, payload);
        if (!ok) {
          return res.json({ type: 'text', content: `Fields for ${queryPlan.targetObject} (first 20):\n` + fields.slice(0,20).map(f=>`- ${f.name} (${f.type})`).join('\n'), metadata: payload.metadata });
        }
        return res.json(payload);
      } catch (e) {
        logger.warn({ error: e.message, object: queryPlan.targetObject }, 'Enhanced describe index missing; falling back to data path');
      }
    }

    // Pairing intent detection: favor LLM classification, use config triggers as backup
    let needsWineExpertise = await detectWinePairingIntentLLM(user_question, chatComplete).catch(() => false);
    if (!needsWineExpertise) {
      needsWineExpertise = detectWinePairingExpertise(user_question, businessContext);
    }

    // STEP 4: Validate security and permissions
    const securityCheck = await validateQuerySecurity(sf, queryPlan.targetObject, queryPlan.fields, orgProfile);
    if (!securityCheck.allowed) {
      logger.warn('Query blocked by security policy', { 
        sessionId, 
        orgId: org_id, 
        object: queryPlan.targetObject, 
        reasons: securityCheck.blockedReasons 
      });
      
      return res.status(403).json({ 
        error: 'access_denied', 
        message: 'Query not allowed by security policy',
        reasons: securityCheck.blockedReasons,
        suggestions: [
          'Contact your administrator to request access',
          'Try querying a different object',
          'Check if you have the necessary permissions'
        ]
      });
    }

    // STEP 5: Execute the query
    let data;
    let querySuccess = true;
    const queryToExecute = queryPlan.queryType === 'SOQL' ? queryPlan.soql : queryPlan.sosl;
    
    try {
      if (queryPlan.queryType === 'SOSL') {
        data = await sf.search(queryPlan.sosl);
        // Flatten SOSL results
        const allRecords = [];
        const searchRecords = data.searchRecords || [];
        
        if (Array.isArray(searchRecords)) {
          for (const record of searchRecords) {
            allRecords.push({
              ...record,
              _objectType: record.attributes?.type || 'Unknown',
              _searchScore: 1.0
            });
          }
        }
        
        data = { records: allRecords, totalSize: allRecords.length };
      } else {
        // DEBUG: Log before SOQL execution
        logger.info({ soql: queryPlan.soql }, 'About to execute SOQL query');
        let soqlToRun = queryPlan.soql;
        if (needsWineExpertise) {
          const limit = businessContext?.wineExpertiseDetection?.queryLimit || 200;
          const statusFilter = businessContext?.wineExpertiseDetection?.statusFilter || "owsc__Item_Status__c = 'Active'";
          soqlToRun = enforceWineSoqlConstraints(soqlToRun, statusFilter, limit);
          logger.info({ soql: soqlToRun }, 'Wine expertise constraints applied to SOQL');
        }
        // Update displayed SOQL so UI reflects the executed query (limit/status)
        queryPlan.soql = soqlToRun;
        data = await sf.query(soqlToRun);
        // DEBUG: Log after SOQL execution
        logger.info({ 
          recordCount: data?.records?.length || 0,
          totalSize: data?.totalSize || 0 
        }, 'SOQL query completed successfully');
      }

      // Track successful object usage for preference learning
      SessionStore.trackObjectUsage(sessionId, user_question, queryPlan.targetObject, true);
      
    } catch (e) {
      querySuccess = false;
      SessionStore.trackObjectUsage(sessionId, user_question, queryPlan.targetObject, false);
      
      // DEBUG: Log the exact error
      logger.error({ 
        error: e.message, 
        stack: e.stack,
        query: queryToExecute, 
        attempt: 1 
      }, 'Initial query failed - DETAILED ERROR INFO');
      
      // Smart retry mechanism
      logger.warn({ error: e.message, query: queryToExecute, attempt: 1 }, 'Initial query failed, attempting intelligent retry');
      
      try {
        const retryResult = await attemptIntelligentRetry(sf, queryPlan, user_question, businessContext, logger);
        data = retryResult.data;
        querySuccess = true;
        logger.info({ 
          retryAttempt: retryResult.successfulAttempt, 
          finalQuery: retryResult.finalQuery 
        }, 'Query succeeded on retry');
      } catch (retryError) {
        logger.error({ error: retryError.message, originalError: e.message }, 'All retry attempts failed');
        
        return res.status(400).json({ 
          error: 'query_execution_failed', 
          message: `Original error: ${e?.message}. Retry error: ${retryError?.message}`,
          originalQuery: queryToExecute,
          llmReasoning: queryPlan.reasoning,
          suggestions: [
            'Try a more specific question',
            'Check if the object or fields exist in your Salesforce org',
            'Verify you have the necessary permissions',
            ...queryPlan.alternatives || []
          ]
        });
      }
    }

    // STEP 6: Apply field-level security
    const fieldPermissions = securityCheck.fieldPermissions;
    
    // DEBUG: Log the fields being passed to enforceFls
    logger.info({ 
      queryPlanFields: queryPlan.fields,
      hasSubquery: queryPlan.soql?.includes('SELECT') && queryPlan.soql?.includes('FROM') && queryPlan.soql?.includes('__r)'),
      soqlQuery: queryPlan.soql
    }, 'DEBUG: Fields before FLS enforcement');
    
    const flsResult = enforceFls(queryPlan.targetObject, data.records || [], queryPlan.fields, fieldPermissions);
    let { rows: safeRows, droppedFields, securityReasons, flsRestricted } = flsResult;

    // STEP 6.5: Check for 0 results and attempt wildcard retry strategies
    let totalRecords = safeRows?.length || 0;
    if (totalRecords === 0 && querySuccess) {
      logger.info({ 
        originalQuery: queryPlan.soql,
        recordCount: totalRecords 
      }, 'Query succeeded but returned 0 results, attempting wildcard retry strategies');
      
      try {
        const retryResult = await attemptIntelligentRetry(sf, queryPlan, user_question, businessContext, logger, data);
        if (retryResult && retryResult.data?.records?.length > 0) {
          logger.info({ 
            strategy: retryResult.strategy,
            recordCount: retryResult.data.records.length,
            finalQuery: retryResult.finalQuery
          }, 'Wildcard retry strategy succeeded');
          
          // Update data with retry results
          data = retryResult.data;
          const retryFlsResult = enforceFls(queryPlan.targetObject, data.records || [], queryPlan.fields, fieldPermissions);
          safeRows = retryFlsResult.rows;
          totalRecords = safeRows?.length || 0;
          
          // Update metadata to reflect the successful retry
          const originalQuerySoql = queryPlan.soql;
          queryPlan.retryInfo = {
            originalQuery: originalQuerySoql,
            retryStrategy: retryResult.strategy,
            finalQuery: retryResult.finalQuery,
            searchTerm: retryResult.searchTerm || 'N/A'
          };
          
          // Update the displayed SOQL to show the successful query
          queryPlan.soql = retryResult.finalQuery;
        }
      } catch (retryError) {
        logger.warn({ 
          error: retryError.message 
        }, 'Wildcard retry strategies failed, continuing with 0 results');
        // Continue with 0 results - don't fail the entire request
      }
    }

    // STEP 7: Use LLM for intelligent response generation
    const dataPreview = (safeRows || []).slice(0, 10);

    // Check if aggregation is needed based on query plan
    const needsAggregation = queryPlan.aggregationContext?.needsAggregation;
    const aggregationRules = queryPlan.aggregationContext?.rules;
    
    let aggregationInstructions = '';
    if (needsAggregation && aggregationRules) {
      aggregationInstructions = `

IMPORTANT - AGGREGATION REQUIRED:
The user asked for system counts/totals, so you must aggregate this data:
- GROUP BY: ${aggregationRules.aggregateBy?.join(', ') || 'location and item'}
- SUM FIELDS: ${aggregationRules.sumFields?.join(', ') || 'quantity fields'}
- INSTRUCTIONS: ${aggregationRules.instructions || 'Aggregate data by specified fields'}

Instead of showing individual records, calculate totals by location and item. Present the aggregated results in a clear table format.`;
    }

    const system = `You are Kaomi, a Salesforce data assistant. You have successfully retrieved ${totalRecords} records using ${queryPlan.queryType} query generation.

QUERY PLAN DETAILS:
- Query Type: ${queryPlan.queryType}
- Target Object: ${queryPlan.targetObject}
- LLM Reasoning: ${queryPlan.reasoning}
- Business Context: ${queryPlan.businessContext}
- Confidence: ${queryPlan.confidence}${aggregationInstructions}

Use this retrieved data to provide specific, data-driven answers. Focus on insights from the actual Salesforce data.`;

    const queryInfo = `${queryPlan.queryType} QUERY: ${queryToExecute}`;
    const dataContext = totalRecords > 0 ? 
      `\n\nRETRIEVED SALESFORCE DATA (${totalRecords} total records, showing first ${Math.min(10, totalRecords)}):\n${JSON.stringify(dataPreview, null, 2)}\n\n${queryInfo}` : 
      `\n\nNo data was retrieved from Salesforce. The query executed successfully but returned no results.\n\n${queryInfo}`;

    const contextMsg = { 
      role: 'assistant', 
      content: JSON.stringify({ 
        llm_query_plan: queryPlan,
        security_info: { flsRestricted, droppedFields, securityReasons },
        data_summary: { total: totalRecords, queryType: queryPlan.queryType }
      }) 
    };

    const messages = [
      { role: 'system', content: system + dataContext },
      contextMsg,
      { role: 'user', content: user_question }
    ];

    // DEBUG: Log LLM call
    logger.info({ 
      messageCount: messages?.length || 0,
      needsAggregation,
      totalRecords
    }, 'About to call LLM');
    
    const llmResponse = await withRetry(() => chatComplete({ messages, stream: false }), {
      retries: 2,
      delayMs: 600,
      shouldRetry: shouldRetryLLM
    });
    
    // DEBUG: Log LLM response
    logger.info({ 
      hasResponse: !!llmResponse,
      hasChoices: !!llmResponse?.choices?.length,
      responseLength: llmResponse?.choices?.[0]?.message?.content?.length || 0
    }, 'LLM call completed');

    // STEP 8: Intelligent response routing - aggregation vs raw data
    const llmContent = llmResponse?.choices?.[0]?.message?.content || 'Unable to generate response';
    
    // DEBUG: Log the actual LLM response content
    logger.info({ 
      llmContentPreview: llmContent?.substring(0, 300) || 'No content',
      llmContentLength: llmContent?.length || 0,
      needsAggregation
    }, 'LLM response content preview');
    
    // Build shared metadata
    const metadata = {
      objects: [queryPlan.targetObject],
      llmGenerated: true,
      queryPlan: queryPlan,
      soql: queryPlan.queryType === 'SOQL' ? queryPlan.soql : undefined,
      sosl: queryPlan.queryType === 'SOSL' ? queryPlan.sosl : undefined,
      prompt_version: defaults.prompt_version, 
      persona: persona.name, 
      total: totalRecords,
      confidence: queryPlan.confidence,
      businessContext: queryPlan.businessContext,
      aggregationApplied: needsAggregation,
      rawDataRows: totalRecords,
      security: { 
        flsRestricted,
        droppedFields,
        securityReasons,
        objectPermissions: securityCheck.objectPermissions,
        fieldPermissions: fieldPermissions,
        warnings: securityCheck.warnings || []
      }
    };

    // Check if the query results contain subquery/hierarchical data
    const hasSubqueryData = detectSubqueryResults(safeRows);
    
    // If aggregation is needed OR subquery results detected OR wine expertise needed, return LLM response with analysis
    if (needsAggregation || hasSubqueryData || needsWineExpertise) {
      // For hierarchical data, use LLM formatting with special instructions
      let finalContent = llmContent;
      
      if (hasSubqueryData && !needsAggregation) {
        // Generate hierarchical formatting for subquery results
        finalContent = await formatSubqueryResults({
          data: safeRows,
          queryPlan: queryPlan,
          businessContext: businessContext,
          userQuestion: user_question
        });
      }
      
      const payload = { 
        type: 'text', 
        content: finalContent,
        metadata: {
          ...metadata,
          note: needsWineExpertise ? 'Wine pairing expertise analysis - sommelier recommendations from inventory' : 
                (hasSubqueryData ? 'Hierarchical data with parent-child relationships' : 'Aggregated analysis from LLM - contains grouped totals by location and item'),
          hasSubqueryData: hasSubqueryData,
          needsWineExpertise: needsWineExpertise
        }
      };
      
      // DEBUG: Log what we're returning for analysis/expertise data
      logger.info({ 
        responseType: payload.type,
        contentLength: payload.content?.length || 0,
        contentPreview: payload.content?.substring(0, 200) || 'No content',
        hasSubqueryData: hasSubqueryData,
        needsAggregation: needsAggregation,
        needsWineExpertise: needsWineExpertise
      }, 'Returning analysis/expertise response to frontend');
      
      return res.json(payload);
    }

    // Default to text unless the user explicitly asks for a table/CSV/grid
    const wantsTable = /\b(table|csv|grid)\b/i.test(user_question || '');
    if (!wantsTable) {
      return res.json({ type: 'text', content: llmContent, metadata });
    }

    // Otherwise, return table data (for queries like "what are items in this org?")
    // For aggregate queries (COUNT, SUM, etc.), use the actual column names from the data
    let columns;
    if (safeRows.length > 0 && Object.keys(safeRows[0]).some(key => /^expr\d+$/.test(key))) {
      // This is an aggregate query - use actual column names from the data
      columns = Object.keys(safeRows[0]).filter(key => key !== 'attributes');
    } else {
      // Regular query - use mapped field names
      columns = queryPlan.fields.map(f => (f.endsWith('.Name') ? f.split('.').slice(-1)[0] : f));
    }
    const rows = (safeRows || []).map(r => {
      const row = [];
      
      // For aggregate queries, use the actual column names from the data
      if (columns.some(col => /^expr\d+$/.test(col))) {
        for (const col of columns) {
          row.push(r[col] !== undefined ? r[col] : null);
        }
      } else {
        // Regular query - use field mapping logic
        for (const f of queryPlan.fields) {
          // Handle subquery relationship fields (e.g., owsc__Action_Items__r)
          if (f.endsWith('__r')) {
            const relVal = r[f];
            let cell = null;
            if (Array.isArray(relVal)) {
              cell = relVal.length;
            } else if (relVal && typeof relVal === 'object' && Array.isArray(relVal.records)) {
              cell = relVal.records.length;
            }
            row.push(cell);
            continue;
          }

          if (f.includes('.')) {
            const [rel, leaf] = f.split('.');
            row.push(r[rel]?.[leaf]);
          } else {
            row.push(r[f]);
          }
        }
      }
      return row;
    });

    // DEBUG: verify subquery rendering
    try {
      const subqField = (queryPlan.fields || []).find(f => f.endsWith('__r'));
      const subqLen = subqField
        ? (Array.isArray(safeRows?.[0]?.[subqField])
            ? safeRows[0][subqField].length
            : (safeRows?.[0]?.[subqField]?.records?.length ?? null))
        : null;
      logger.info({ columns, firstRow: rows?.[0], subqField, subqLen }, 'DEBUG: Output table sample');
    } catch {}

    const payload = { 
      type: 'table', 
      content: { columns, rows },
      metadata: metadata
    };

    // Validate structured output
    const schema = buildTableSchema(columns);
    const { ok } = validate(schema, payload);
    if (!ok) {
      return res.json({ 
        type: 'text', 
        content: 'Unable to produce a valid table. Here is a summary:\n' + redactPII(JSON.stringify(rows.slice(0, 5))), 
        metadata: metadata 
      });
    }

    logger.info({
      sessionId,
      orgId: org_id,
      queryType: queryPlan.queryType,
      totalRecords,
      success: true
    }, 'LLM-driven query completed successfully');

    return res.json(payload);
    
  } catch (err) {
    logger.error({ err, sessionId: req.body?.sessionId, orgId: req.body?.org_id }, 'LLM-driven query generation failed');
    return res.status(500).json({ 
      error: 'internal_error', 
      message: err?.message,
      type: 'llm_generation_failure'
    });
  }
});

/**
 * Attempts intelligent retry strategies when a query fails
 */
async function attemptIntelligentRetry(sf, originalPlan, userQuestion, businessContext, logger, originalData = null) {
  const attempts = [];
  
  // SPECIAL CASE: If original query succeeded but returned 0 results, try wildcard strategies first
  if (originalData && originalData.records?.length === 0) {
    const wildcardAttempts = buildWildcardRetryStrategies(originalPlan, userQuestion, businessContext);
    attempts.push(...wildcardAttempts);
  }
  
  // RETRY 1: Try namespace variations for object names
  if (originalPlan.targetObject && !originalPlan.targetObject.includes('__c')) {
    const namespacedObject = `owsc__${originalPlan.targetObject}__c`;
    attempts.push({
      strategy: 'namespace_variation',
      targetObject: namespacedObject,
      soql: originalPlan.soql.replace(originalPlan.targetObject, namespacedObject)
    });
  }
  
  // RETRY 2: Try guessed object names based on question keywords (configuration-driven)
  const retryStrategies = businessContext?.retryStrategies?.keywordMatching || {};
  const questionLower = userQuestion.toLowerCase();
  
  for (const [keyword, objects] of Object.entries(retryStrategies)) {
    if (questionLower.includes(keyword)) {
      for (const targetObject of objects) {
        attempts.push({
          strategy: 'keyword_matching',
          targetObject: targetObject,
          soql: `SELECT Id, Name FROM ${targetObject} LIMIT 200`,
          keyword: keyword
        });
      }
      break; // Only match first keyword to avoid too many attempts
    }
  }
  
  // RETRY 3: Minimal query on original object (just Id, Name)
  attempts.push({
    strategy: 'minimal_fields',
    targetObject: originalPlan.targetObject,
    soql: `SELECT Id, Name FROM ${originalPlan.targetObject} LIMIT 200`
  });
  
  // RETRY 4: Try alternative objects from business context
  if (businessContext?.primaryBusinessObjects) {
    const altObjects = Object.keys(businessContext.primaryBusinessObjects)
      .filter(obj => obj !== originalPlan.targetObject)
      .slice(0, 2); // Try top 2 alternatives
      
    for (const altObject of altObjects) {
      attempts.push({
        strategy: 'alternative_object',
        targetObject: altObject,
        soql: `SELECT Id, Name FROM ${altObject} LIMIT 200`
      });
    }
  }
  
  // Execute retry attempts
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    logger.info({ 
      strategy: attempt.strategy, 
      targetObject: attempt.targetObject, 
      keyword: attempt.keyword,
      attempt: i + 2 
    }, 'Attempting retry strategy');
    
    try {
      const data = await sf.query(attempt.soql);
      logger.info({ 
        strategy: attempt.strategy, 
        targetObject: attempt.targetObject,
        keyword: attempt.keyword,
        recordCount: data.records?.length 
      }, 'Retry strategy succeeded');
      
      return {
        data,
        successfulAttempt: i + 2,
        strategy: attempt.strategy,
        finalQuery: attempt.soql
      };
    } catch (retryError) {
      logger.warn({ 
        strategy: attempt.strategy, 
        error: retryError.message, 
        attempt: i + 2 
      }, 'Retry strategy failed');
      continue;
    }
  }
  
  throw new Error('All retry strategies exhausted');
}

/**
 * Builds wildcard retry strategies for queries that returned 0 results
 */
function buildWildcardRetryStrategies(originalPlan, userQuestion, businessContext) {
  const attempts = [];
  const wildcardConfig = businessContext?.retryStrategies?.wildcardStrategies || {};
  
  // Extract potential search terms from the original SOQL query
  const searchTerms = extractSearchTermsFromSOQL(originalPlan.soql);
  
  if (searchTerms.length === 0) {
    return attempts; // No search terms found to wildcard
  }
  
  // Get wildcard field patterns from configuration  
  const fieldPatterns = wildcardConfig.fieldPatterns || [
    { fields: ['Name'], priority: 1 },
    { fields: ['owsc__Brand_Family__c'], priority: 2 },
    { fields: ['Name', 'owsc__Brand_Family__c'], priority: 3 }
  ];
  
  // Build wildcard attempts for each search term and field pattern
  for (const searchTerm of searchTerms) {
    for (const pattern of fieldPatterns) {
      const wildcardQuery = buildWildcardQuery(originalPlan, searchTerm, pattern.fields);
      if (wildcardQuery) {
        attempts.push({
          strategy: 'wildcard_search',
          targetObject: originalPlan.targetObject,
          soql: wildcardQuery,
          searchTerm: searchTerm,
          fields: pattern.fields,
          priority: pattern.priority
        });
      }
    }
  }
  
  // Sort by priority (lower number = higher priority)
  attempts.sort((a, b) => a.priority - b.priority);
  
  return attempts;
}

/**
 * Extracts search terms from SOQL WHERE clauses
 */
function extractSearchTermsFromSOQL(soql) {
  const searchTerms = [];
  
  if (!soql || typeof soql !== 'string') {
    return searchTerms;
  }
  
  // Find WHERE clauses with quoted string values
  const whereMatch = soql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/i);
  if (!whereMatch) {
    return searchTerms;
  }
  
  const whereClause = whereMatch[1];
  
  // Extract quoted strings that look like search terms (handle escaped quotes properly)
  const quotedStrings = whereClause.match(/'(?:[^'\\]|\\.)*'/g) || [];
  
  for (const quoted of quotedStrings) {
    const term = quoted.slice(1, -1); // Remove quotes
    
    // Skip common SQL operators and values
    const skipTerms = ['Active', 'Inactive', 'true', 'false', 'null'];
    if (!skipTerms.includes(term) && term.length > 1) {
      // Remove escape characters for wildcard search (convert \' to ')
      const cleanTerm = term.replace(/\\'/g, "'");
      searchTerms.push(cleanTerm);
    }
  }
  
  return searchTerms;
}

/**
 * Builds a wildcard SOQL query for given search term and fields
 */
function buildWildcardQuery(originalPlan, searchTerm, fields) {
  if (!originalPlan.soql || !searchTerm || !fields || fields.length === 0) {
    return null;
  }
  
  // Build LIKE conditions for each field (escape apostrophes for SOQL)
  const escapedSearchTerm = searchTerm.replace(/'/g, "\\'");
  const likeConditions = fields.map(field => `${field} LIKE '%${escapedSearchTerm}%'`);
  const wildcardWhere = likeConditions.join(' OR ');
  
  // Replace the original WHERE clause with wildcard search
  let wildcardQuery = originalPlan.soql;
  
  // Find and replace WHERE clause while preserving ORDER BY and LIMIT
  const whereMatch = wildcardQuery.match(/WHERE\s+(.+?)(?=\s+ORDER\s+BY|\s+LIMIT|\s*$)/i);
  if (whereMatch) {
    // Replace the WHERE clause content, keeping ORDER BY and LIMIT intact
    const beforeWhere = wildcardQuery.substring(0, whereMatch.index);
    const afterWhere = wildcardQuery.substring(whereMatch.index + whereMatch[0].length);
    wildcardQuery = `${beforeWhere}WHERE ${wildcardWhere}${afterWhere}`;
  } else {
    // Add WHERE clause if none exists
    const orderByMatch = wildcardQuery.match(/(\s+ORDER\s+BY.+)/i);
    const limitMatch = wildcardQuery.match(/(\s+LIMIT.+)/i);
    
    if (orderByMatch) {
      const beforeOrderBy = wildcardQuery.substring(0, orderByMatch.index);
      const orderByPart = orderByMatch[0];
      wildcardQuery = `${beforeOrderBy} WHERE ${wildcardWhere}${orderByPart}`;
    } else if (limitMatch) {
      const beforeLimit = wildcardQuery.substring(0, limitMatch.index);
      const limitPart = limitMatch[0];
      wildcardQuery = `${beforeLimit} WHERE ${wildcardWhere}${limitPart}`;
    } else {
      wildcardQuery = `${wildcardQuery.trim()} WHERE ${wildcardWhere}`;
    }
  }
  
  return wildcardQuery;
}

/**
 * Detects if a user question is conversational rather than Salesforce data-related
 */
async function detectConversationalQuery({ question, businessContext, orgId }) {
  const conversationalConfig = businessContext?.conversationalDetection || {};
  
  const prompt = `You are an intelligent query classifier for a Salesforce assistant named Kaomi.

TASK: Determine if the user's question is conversational/social OR if they want Salesforce data.

EXAMPLES OF CONVERSATIONAL QUERIES:
- Greetings: "Hello", "Hi there", "How are you?"
- Social: "How's your day?", "What's your favorite color?"
- Personal: "Tell me about yourself", "What can you do?"
- Casual chat: "Nice weather today", "Good morning!"
- General knowledge NOT about Salesforce: "What's 2+2?", "Tell me a joke"

EXAMPLES OF SALESFORCE QUERIES:
- Data requests: "Show me all accounts", "How many items are there?"
- Business questions: "What are our sales numbers?", "Show inventory"
- Specific searches: "Find Dow's wines", "List all opportunities"
- Any question about business data, objects, records, or Salesforce functionality

BUSINESS CONTEXT:
This is a ${businessContext?.description || 'business data'} system with objects like: ${Object.keys(businessContext?.primaryBusinessObjects || {}).slice(0, 5).join(', ')}

USER QUESTION: "${question}"

Respond in JSON format:
{
  "isConversational": boolean,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your decision"
}`;

  try {
    const response = await chatComplete([
      { role: 'system', content: prompt }
    ], {
      temperature: 0.1,
      max_tokens: 150
    });

    const result = JSON.parse(response.choices[0].message.content);
    return {
      isConversational: result.isConversational,
      confidence: result.confidence,
      reasoning: result.reasoning
    };
  } catch (error) {
    logger.warn({ error: error.message }, 'LLM-based conversational detection failed, trying fallback keywords');
    
    // Fallback: Use configured keywords for basic conversational detection
    const fallbackKeywords = businessContext?.conversationalDetection?.fallback_keywords || {};
    const questionLower = question.toLowerCase();
    
    // Check all keyword categories
    for (const [category, keywords] of Object.entries(fallbackKeywords)) {
      for (const keyword of keywords) {
        if (questionLower.includes(keyword.toLowerCase())) {
          return {
            isConversational: true,
            confidence: 0.8,
            reasoning: `Fallback detection: matched "${keyword}" in ${category} category`
          };
        }
      }
    }
    
    // No conversational keywords found
    return {
      isConversational: false,
      confidence: 0.5,
      reasoning: 'LLM detection failed and no fallback keywords matched - defaulting to Salesforce mode'
    };
  }
}

/**
 * Handles conversational queries with Kaomi's personality
 */
async function handleConversationalQuery({ question, persona, sessionId, orgId, res, businessContext }) {
  const kaomiPersonality = businessContext?.conversationalPersonality || {
    name: "Kaomi",
    role: "Your friendly Salesforce assistant",
    traits: ["helpful", "professional", "approachable", "knowledgeable"],
    greeting_style: "warm and welcoming",
    response_style: "conversational but informative"
  };

  const systemPrompt = `You are ${kaomiPersonality.name}, ${kaomiPersonality.role}.

PERSONALITY TRAITS: ${kaomiPersonality.traits.join(', ')}
COMMUNICATION STYLE: ${kaomiPersonality.response_style}
${kaomiPersonality.specialties ? `SPECIALTIES: ${kaomiPersonality.specialties.join(', ')}` : ''}

PERSONALITY NOTES: ${kaomiPersonality.personality_notes || 'Be helpful, professional, and approachable.'}

IMPORTANT CONTEXT:
- You are a Salesforce data assistant with a warm, helpful personality
- You can chat naturally but also help with business data when needed
- Keep responses friendly and conversational
- If users want to switch to business questions, encourage them naturally
- You work with wholesale/wine distribution data systems

CONVERSATIONAL GUIDELINES:
- Be warm and personable, but professional
- Show interest in the user's question
- Keep responses concise but engaging
- If appropriate, mention that you're also here to help with their business data

USER QUESTION: "${question}"

Respond naturally as ${kaomiPersonality.name} with personality!`;

  try {
    const response = await chatComplete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ], {
      temperature: 0.7, // Higher temperature for more personality
      max_tokens: 300
    });

    const conversationalResponse = response.choices[0].message.content;

    return res.json({
      type: 'text',
      content: conversationalResponse,
      metadata: {
        queryType: 'conversational',
        personality: kaomiPersonality.name,
        sessionId,
        orgId
      }
    });

  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate conversational response, using personality fallback');
    
    // Configuration-driven personality fallback responses
    const personalityResponses = getPersonalityFallbackResponse(question, kaomiPersonality);
    
    return res.json({
      type: 'text',
      content: personalityResponses,
      metadata: {
        queryType: 'conversational_fallback',
        personality: kaomiPersonality.name,
        note: 'Using fallback personality responses (LLM unavailable)'
      }
    });
  }
}

/**
 * Detects if query results contain subquery/hierarchical data
 */
function detectSubqueryResults(rows) {
  if (!rows || rows.length === 0) return false;
  
  // Check if any row contains nested objects that look like Salesforce subquery results
  return rows.some(row => {
    return Object.keys(row).some(key => {
      const value = row[key];
      // Look for relationship objects with 'records' array (typical Salesforce subquery structure)
      return value && 
             typeof value === 'object' && 
             !Array.isArray(value) &&
             value.records && 
             Array.isArray(value.records) &&
             key.endsWith('__r');
    });
  });
}

/**
 * Formats subquery results using LLM with hierarchical formatting instructions
 */
async function formatSubqueryResults({ data, queryPlan, businessContext, userQuestion }) {
  const formattingInstructions = businessContext?.llmFormattingInstructions || {};
  const subqueryPatterns = businessContext?.subqueryPatterns || {};
  
  const systemPrompt = `You are an expert at presenting hierarchical Salesforce data in a beautiful, user-friendly format.

## HIERARCHICAL DATA FORMATTING INSTRUCTIONS:
${JSON.stringify(formattingInstructions, null, 2)}

## SUBQUERY PATTERNS CONTEXT:
${JSON.stringify(subqueryPatterns, null, 2)}

## YOUR TASK:
Format this hierarchical Salesforce query result data for the user. The data contains parent records with nested child records from subqueries.

FORMATTING GUIDELINES:
1. Present each parent record as a clear header section with key information
2. List child records under each parent in an organized, readable format
3. Use emojis and visual separators for better readability
4. Group related fields logically (e.g., quantities together, dates together)
5. Show the most important information prominently
6. Use the responsePatterns from the configuration for consistent formatting

The user asked: "${userQuestion}"
Make sure your response directly answers their question with clear, organized hierarchical data.`;

  const userPrompt = `Here is the hierarchical Salesforce query result data to format:

${JSON.stringify(data, null, 2)}

Please format this data in a beautiful, hierarchical way that clearly shows the parent-child relationships and answers the user's question: "${userQuestion}"`;

  try {
    const response = await chatComplete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.3, // Lower temperature for consistent formatting
      max_tokens: 1000
    });

    return response.choices?.[0]?.message?.content || 'Unable to format hierarchical data';
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to format subquery results');
    
    // Deterministic fallback: Render parent and enumerate child rows generically (no hardcoding)
    try {
      const sections = [];
      for (let i = 0; i < data.length; i++) {
        const parent = data[i] || {};
        const parentHeaderTitle = parent.Name || parent.Id || `Record ${i + 1}`;

        // Build a concise parent summary from primitive fields and related .Name values (generic)
        const parentSummaryParts = [];
        const seen = new Set(['attributes']);
        for (const [pk, pv] of Object.entries(parent)) {
          if (seen.has(pk)) continue;
          seen.add(pk);
          if (pk.endsWith('__r')) {
            // Include related Name for single-relationship objects
            if (pv && typeof pv === 'object' && pv.Name) {
              parentSummaryParts.push(`${pk}.Name: ${pv.Name}`);
            }
            continue;
          }
          if (pk === 'Id' || pk === 'Name') continue;
          if (pv === null || pv === undefined) continue;
          if (typeof pv === 'string' || typeof pv === 'number' || typeof pv === 'boolean') {
            parentSummaryParts.push(`${pk}: ${pv}`);
          }
          if (parentSummaryParts.length >= 8) break;
        }
        const childBlocks = [];
        for (const [key, value] of Object.entries(parent)) {
          // Look for Salesforce subquery objects: { totalSize, done, records: [...] } and relationship keys ending with __r
          if (
            key.endsWith('__r') &&
            value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.records)
          ) {
            const records = value.records;
            const lines = [];
            for (let j = 0; j < records.length; j++) {
              const rec = records[j] || {};
              const parts = [];
              if (rec.Name) parts.push(`Name: ${rec.Name}`);
              // Include selected primitive fields and related .Name fields
              for (const [ck, cv] of Object.entries(rec)) {
                if (ck === 'attributes' || ck === 'Id' || ck === 'Name') continue;
                if (cv === null || cv === undefined) continue;
                if (typeof cv === 'string' || typeof cv === 'number' || typeof cv === 'boolean') {
                  parts.push(`${ck}: ${cv}`);
                } else if (cv && typeof cv === 'object' && cv.Name) {
                  parts.push(`${ck}.Name: ${cv.Name}`);
                }
                if (parts.length >= 8) break; // keep concise
              }
              lines.push(`- ${j + 1}. ${parts.join(' | ')}`);
            }
            const header = `${key} (${records.length})`;
            childBlocks.push(`${header}\n${lines.join('\n')}`);
          }
        }
        const headerLine = parentSummaryParts.length ? `\n${parentSummaryParts.join(' | ')}` : '';
        const block = `### ${parentHeaderTitle}${headerLine}\n${childBlocks.join('\n\n') || 'No child records found.'}`;
        sections.push(block);
      }
      return sections.join('\n\n');
    } catch (e) {
      // Last-resort minimal fallback
      return `The query returned ${data.length} parent record(s) with nested child data, but I couldn't format it. First parent: ${data[0]?.Name || data[0]?.Id || 'Unknown'}.`;
    }
  }
}

/**
 * Provides personality-driven fallback responses when LLM is unavailable
 */
function getPersonalityFallbackResponse(question, personality) {
  const questionLower = question.toLowerCase();
  const name = personality.name || 'Kaomi';
  const traits = personality.traits || ['helpful', 'professional'];
  const specialties = personality.specialties || ['data'];
  
  // Configuration-driven response patterns
  const responsePatterns = {
    greeting: [
      `Hello! I'm ${name}, your ${personality.role || 'Salesforce assistant'}. Nice to meet you!`,
      `Hi there! ${name} here, ready to help with your ${specialties[0]} needs!`,
      `Hey! Great to connect with you. I'm ${name}, and I love helping with ${specialties.join(' and ')}.`
    ],
    
    about: [
      `I'm ${name}! I'm ${traits.includes('wine-savvy') ? 'a wine-loving' : 'a'} Salesforce assistant specializing in ${specialties.join(', ')}. I'm ${traits.join(' and ')}, and I'm here to help you with both your business data and casual conversation!`,
      `Great question! I'm ${name}, your friendly assistant for ${specialties.join(' and ')}. I pride myself on being ${traits.join(', ')}, and I love both analyzing data and having good conversations!`,
      `I'm ${name}! Think of me as your ${traits.includes('wine-savvy') ? 'wine-savvy' : 'knowledgeable'} companion for all things ${specialties.join(' and ')}. I'm here to make working with your business data both effective and enjoyable.`
    ],
    
    day: [
      `Thanks for asking! I'm having a great day helping people like you with their ${specialties[0]} questions. How about you?`,
      `My day's going wonderfully! I've been busy helping with ${specialties.join(' and ')} - it's what I love doing. How's your day treating you?`,
      `It's been a fantastic day! I'm always energized when I get to use my ${specialties.join(' and ')} expertise. What brings you here today?`
    ],
    
    favorite: [
      `Great question! ${traits.includes('wine-savvy') ? 'As someone who loves wine, I have to say I appreciate a good Pinot Noir - elegant and complex, just like good data analysis!' : 'I love helping people discover insights in their data - it\'s like finding hidden treasures!'}`,
      `${traits.includes('wine-savvy') ? 'I\'m partial to wines from regions with great stories - just like how every dataset tells a story!' : 'My favorite thing is when someone has that \'aha!\' moment with their data.'}`,
      `${traits.includes('wine-savvy') ? 'I enjoy both bold reds and crisp whites - variety is the spice of life! What about you?' : 'I love it when we can turn complex business questions into clear, actionable insights!'}`
    ],
    
    default: [
      `That's an interesting question! I'm ${name}, your ${traits.join(' and ')} assistant. While I love chatting, I'm also here to help with your ${specialties.join(' and ')} needs. What would you like to explore?`,
      `Thanks for asking! As your ${personality.role || 'assistant'}, I'm always happy to chat. I specialize in ${specialties.join(', ')} and I'm ${traits.join(' and ')}. How can I help you today?`
    ]
  };
  
  // Pattern matching for response selection
  if (questionLower.includes('hello') || questionLower.includes('hi ') || questionLower.includes('hey')) {
    return getRandomResponse(responsePatterns.greeting);
  } else if (questionLower.includes('about yourself') || questionLower.includes('who are you') || questionLower.includes('tell me about')) {
    return getRandomResponse(responsePatterns.about);
  } else if (questionLower.includes('your day') || questionLower.includes('how are you')) {
    return getRandomResponse(responsePatterns.day);
  } else if (questionLower.includes('favorite') || questionLower.includes('like best')) {
    return getRandomResponse(responsePatterns.favorite);
  } else {
    return getRandomResponse(responsePatterns.default);
  }
}

/**
 * Gets a random response from an array to add variety
 */
function getRandomResponse(responses) {
  return responses[Math.floor(Math.random() * responses.length)];
}

export default router;
