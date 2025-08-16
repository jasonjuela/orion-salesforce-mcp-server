import { Router } from 'express';
import { sfClient } from '../services/salesforce.js';
import { detectIntent, resolveEntities, buildSoqlPlan, planRelationshipPath } from '../services/planner.js';
import { loadOrgProfile, loadPersona, loadDefaults } from '../config/configLoader.js';
import { SessionStore } from '../config/sessionStore.js';
import { TokenStore } from '../config/tokenStore.js';
import { buildTableSchema, validate } from '../utils/jsonSchema.js';
import { chatComplete } from '../services/llm/openaiAdapter.js';
import { withRetry } from '../utils/withRetry.js';
import { shouldRetryLLM } from '../utils/retryPolicies.js';
import { redactPII } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import { buildDescribeIndex, expandDescribeIndex, filterAllowedFields, chooseOrderBy, pickLookupNameFields, findLookupNameFieldsByKeywords, findLookupNameFieldsByTargets, buildObjectCatalog, pickGroupByLookup } from '../services/schemaIndex.js';
import { resolveDateRange, needsDateClarification, normalizeDateMacro } from '../utils/dateUtils.js';
import { resolveObjectsIntelligently, isProblematicSystemObject } from '../services/intelligentResolver.js';
import { buildObjectClarification, buildDateClarification } from '../utils/clarify.js';
import { enforceFls, validateQuerySecurity, checkFieldPermissions } from '../utils/security.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { user_question, org_id, sessionId = 'dev', request_hints, persona: personaName } = req.body || {};
    if (!user_question || !org_id) return res.status(400).json({ error: 'user_question and org_id required' });

    // Prefer OAuth tokens from TokenStore; fall back to env for dev.
    let tokenCtx = TokenStore.get(sessionId, org_id) || req.sfToken;
    if (!tokenCtx) tokenCtx = { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) return res.status(401).json({ error: 'missing_salesforce_token' });
    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });

    const [orgProfile, persona, defaults] = await Promise.all([
      loadOrgProfile(org_id),
      loadPersona(personaName),
      loadDefaults()
    ]);
    const session = SessionStore.get(sessionId);

    // Enhanced object resolution with intelligent matching
    const intent = detectIntent(user_question);
    const userPreferences = SessionStore.getObjectPreferences(sessionId);
    
    // Check for cached clarification answers first
    const existingClarification = SessionStore.getClarification(sessionId, user_question);
    let entities = [];
    
    if (existingClarification) {
      // Use previously clarified answer
      entities = [existingClarification.answer.object];
      logger.info('Using cached clarification', { sessionId, question: user_question, object: entities[0] });
    } else {
      // Use intelligent resolver
      const resolution = await resolveObjectsIntelligently(user_question, sf, orgProfile, {
        sessionId,
        userPreferences,
        threshold: 0.5,
        maxSuggestions: 3
      });
      
      if (!resolution.success || resolution.needsClarification) {
        const clarify = buildObjectClarification(resolution.suggestions || [], user_question);
        return res.json({ 
          type: 'clarify', 
          content: clarify.question, 
          metadata: {
            ...clarify,
            suggestions: resolution.suggestions,
            confidence: resolution.confidence,
            usedPreferences: resolution.usedPreferences
          }
        });
      }
      
      entities = [resolution.primaryMatch.apiName];
      logger.info('Resolved object intelligently', { 
        sessionId, 
        question: user_question, 
        object: entities[0], 
        confidence: resolution.confidence,
        matchType: resolution.primaryMatch.matchType 
      });
    }

    // Build describe index for allowlists
    let targetObject = entities[0] || 'Account';
    let describeIndex = await buildDescribeIndex(sf, [targetObject], {});
    // Opportunistic neighbor expansion to improve path planning without hardcoding
    describeIndex = await expandDescribeIndex(sf, describeIndex, targetObject, 2, { orgId: org_id });

    // Optional: compute a related path candidate and, if it suggests a better focus, switch the target
    if (intent === 'aggregate' || intent === 'list_related_records') {
      // Use tokens from the question as unbiased hints (no hardcoding)
      const relHint = (user_question || '').toLowerCase().match(/[a-z][a-z0-9_]+/g) || [];
      const path = planRelationshipPath(describeIndex, targetObject, relHint);
      if (path && path.objectApiName && path.objectApiName !== targetObject) {
        targetObject = path.objectApiName;
        describeIndex = await buildDescribeIndex(sf, [targetObject], {});
        describeIndex = await expandDescribeIndex(sf, describeIndex, targetObject, 1, { orgId: org_id });
      }
      // For aggregates specifically: if no good GROUP BY lookup on the current object, try pivoting to a child object that has one
      if (intent === 'aggregate') {
        const keywords = relHint;
        let gb = pickGroupByLookup(describeIndex, targetObject, keywords);
        if (!gb) {
          const obj = describeIndex.objects[targetObject];
          const childCandidates = [];
          for (const [childRelName, childApi] of obj?.childRelationships || []) {
            // Skip problematic system objects completely
            if (isProblematicSystemObject(childApi)) continue;
            // de-prioritize meta objects
            if (/(__Feed|__History|__Share|Feed|History|Share)$/i.test(childApi)) continue;
            childCandidates.push(childApi);
          }
          // Score children to prefer those that look like the bridge entity between item and location
          let bestChild = undefined;
          let bestChildScore = -1;
          for (const childApi of childCandidates) {
            if (!describeIndex.objects[childApi]) {
              const addIdx = await buildDescribeIndex(sf, [childApi], { orgId: org_id });
              if (addIdx?.objects?.[childApi]) describeIndex.objects[childApi] = addIdx.objects[childApi];
            }
            const lowerApi = String(childApi).toLowerCase();
            let score = 0;
            if (lowerApi.includes('item')) score += 2;
            if (lowerApi.includes('lot')) score += 2;
            if (lowerApi.includes('location')) score += 1;
            if (lowerApi.includes('minimum') || lowerApi.includes('on_hand')) score -= 3;
            const childGb = pickGroupByLookup(describeIndex, childApi, keywords);
            if (childGb) {
              score += 2;
              const displayLower = String(childGb.displayField || '').toLowerCase();
              if (displayLower.includes('location')) score += 2;
            }
            // Bonus if child has a lookup back to the current target object
            const objEntry = describeIndex.objects[childApi];
            let hasBackRef = false;
            for (const f of objEntry?.describe?.fields || []) {
              if (f.relationshipName && (f.referenceTo || []).includes(targetObject)) { hasBackRef = true; break; }
            }
            if (hasBackRef) score += 2;
            if (score > bestChildScore) { bestChildScore = score; bestChild = childApi; }
          }
          if (bestChild) {
            targetObject = bestChild;
            describeIndex = await expandDescribeIndex(sf, describeIndex, targetObject, 1, { orgId: org_id });
          }
        }
      }
    }

    // Pre-count for large datasets
    let dateRange = normalizeDateMacro(resolveDateRange(user_question, orgProfile, session));
    if (needsDateClarification(user_question)) {
      const clarify = buildDateClarification(orgProfile);
      return res.json({ type: 'clarify', content: clarify.question, metadata: clarify });
    }
    const countPlan = buildSoqlPlan({ intent, entities: [targetObject], orgProfile, describeIndex, session, countOnly: true, dateRange, question: user_question });
    // Defensive: COUNT() queries must not include ORDER BY/LIMIT
    countPlan.soql = countPlan.soql.replace(/\sORDER BY[\s\S]*$/i, '');
    let countResp;
    try {
      countResp = await sf.query(countPlan.soql);
    } catch (e) {
      return res.status(400).json({ error: 'soql_count_failed', message: e?.message, soql: countPlan.soql });
    }
    const total = countResp.totalSize ?? (countResp.records?.[0]?.expr0 || 0);

    // MVP: cap results; prod would ask user to summarize/export when large
    const plan = buildSoqlPlan({ intent, entities: [targetObject], orgProfile, describeIndex, session, countOnly: false, dateRange, question: user_question });
    // Expose relationship path in plan metadata (after plan exists)
    if (intent === 'aggregate' || intent === 'list_related_records') {
      const relHint = (user_question || '').toLowerCase().match(/[a-z][a-z0-9_]+/g) || [];
      const path = planRelationshipPath(describeIndex, targetObject, relHint);
      if (path) plan.path = path;
    }

    // For aggregates, just do a simple query - SOQL doesn't support GROUP BY aggregation
    if (intent === 'aggregate') {
      // Keep the original simple query plan
    }
    // If the chosen object is custom and has lookups, include up to two relationship Name fields
    if (plan.object.endsWith('__c')) {
      const keywords = (user_question || '').toLowerCase().match(/[a-z][a-z0-9_]+/g) || [];
      const keywordBased = findLookupNameFieldsByKeywords(describeIndex, plan.object, keywords, 2);
      const picked = keywordBased.length ? keywordBased : pickLookupNameFields(describeIndex, plan.object, 2);
      const expanded = [];
      for (const rel of picked) {
        expanded.push(rel);
        if (rel.endsWith('__r.Name')) expanded.push(rel.replace(/__r\.Name$/, '.Name'));
        else if (rel.endsWith('.Name')) expanded.push(rel.replace(/\.Name$/, '__r.Name'));
      }
      plan.fields = Array.from(new Set([...plan.fields, ...expanded]));
    }
    // Add up to two parent lookup names from relationship path (if present)
    try {
      const tentative = [];
      const path = planRelationshipPath(describeIndex, plan.object, []);
      for (const step of path?.path || []) {
        if (step.type === 'parent' && step.relName) tentative.push(`${step.relName}__r.Name`);
      }
      if (tentative.length) plan.fields = Array.from(new Set([...plan.fields, ...tentative.slice(0, 2)]));
    } catch {}
    // Comprehensive security validation
    const securityCheck = await validateQuerySecurity(sf, targetObject, plan.fields, orgProfile);
    if (!securityCheck.allowed) {
      logger.warn('Query blocked by security policy', { 
        sessionId, 
        orgId: org_id, 
        object: targetObject, 
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
    
    // Get detailed field permissions for enhanced FLS
    const fieldPermissions = securityCheck.fieldPermissions;
    
    plan.fields = filterAllowedFields(describeIndex, plan.object, plan.fields);
    if (!plan.aggregate) {
      if (!plan.fields.includes('Id')) plan.fields.unshift('Id');
      plan.soql = plan.soql.replace(/^SELECT\s+[^F]+FROM/i, `SELECT ${plan.fields.join(', ')} FROM`);
      const orderBy = chooseOrderBy(describeIndex, plan.object);
      plan.soql = plan.soql.replace(/ORDER BY[^L]+LIMIT/, `ORDER BY ${orderBy} DESC LIMIT`);
    }
    // Large dataset handling: if too many rows, return prompt to export
    const threshold = Number(process.env.LARGE_DATA_THRESHOLD || 1000);
    if (total > threshold) {
      return res.json({
        type: 'text',
        content: `This will return about ${total} rows. Do you want a summary, a CSV export, or the first 200 in chat?`,
        metadata: { suggestExport: true, total, soql: countPlan.soql }
      });
    }

    let data;
    let querySuccess = true;
    try {
      data = await sf.query(plan.soql);
      // Track successful object usage for preference learning
      SessionStore.trackObjectUsage(sessionId, user_question, targetObject, true);
    } catch (e) {
      querySuccess = false;
      SessionStore.trackObjectUsage(sessionId, user_question, targetObject, false);
      return res.status(400).json({ error: 'soql_query_failed', message: e?.message, soql: plan.soql });
    }

    // For aggregate intent, let the LLM summarize the data instead of trying GROUP BY

    // Enhanced FLS filtering with detailed security reporting
    const flsResult = enforceFls(plan.object, data.records || [], plan.fields, fieldPermissions);
    const { rows: safeRows, droppedFields, securityReasons, flsRestricted } = flsResult;

    // Build LLM messages
    const system = 'You are a Salesforce architecture and data assistant. Use Describe to resolve objects/fields; return markdown or JSON as requested.';
    const contextMsg = { role: 'assistant', content: JSON.stringify({ metadata_summary: { intent, entities, plan, total, dateRange } }) };
    const messages = [ { role: 'system', content: system }, contextMsg, { role: 'user', content: user_question } ];

    const llmData = await withRetry(() => chatComplete({ messages, stream: false }), {
      retries: 2,
      delayMs: 600,
      shouldRetry: shouldRetryLLM
    });

    // Minimal parse: return table with SF rows and include SOQL in metadata
    const columns = plan.fields.map(f => (f.endsWith('.Name') ? f.split('.').slice(-1)[0] : f));
    const rows = (safeRows || []).map(r => {
      const row = [];
      for (const f of plan.fields) {
        if (f.includes('.')) {
          const [rel, leaf] = f.split('.');
          row.push(r[rel]?.[leaf]);
        } else {
          row.push(r[f]);
        }
      }
      return row;
    });
    const payload = { 
      type: 'table', 
      content: { columns, rows }, 
      metadata: { 
        objects: [plan.object], 
        intent, 
        soql: plan.soql, 
        prompt_version: defaults.prompt_version, 
        persona: persona.name, 
        total,
        security: { 
          flsRestricted,
          droppedFields,
          securityReasons,
          objectPermissions: securityCheck.objectPermissions,
          fieldPermissions: fieldPermissions,
          warnings: securityCheck.warnings || []
        }
      } 
    };

    // Validate structured output
    const schema = buildTableSchema(columns);
    const { ok } = validate(schema, payload);
    if (!ok) {
      return res.json({ type: 'text', content: 'Unable to produce a valid table. Here is a summary:\n' + redactPII(JSON.stringify(rows.slice(0, 5))), metadata: payload.metadata });
    }

    return res.json(payload);
  } catch (err) {
    logger.error({ err }, 'generate failed');
    return res.status(500).json({ error: 'internal_error', message: err?.message });
  }
});

export default router;


