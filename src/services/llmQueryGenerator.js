import { chatComplete } from './llm/openaiAdapter.js';
import { withRetry } from '../utils/withRetry.js';
import { shouldRetryLLM } from '../utils/retryPolicies.js';
import { logger } from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * LLM-Driven Query Generation Service
 * 
 * This service replaces hardcoded regex patterns and business logic with
 * intelligent LLM-based query planning using Salesforce describe metadata
 * and minimal business context configuration.
 */

/**
 * Load business context configuration
 */
async function loadBusinessContext(orgId = 'default') {
  try {
    const contextPath = path.join('data', 'configs', 'business-context.json');
    const guidelinesPath = path.join('data', 'configs', 'query-guidelines.json');
    
    const [contextData, guidelinesData] = await Promise.all([
      fs.readFile(contextPath, 'utf8'),
      fs.readFile(guidelinesPath, 'utf8')
    ]);
    
    return {
      businessContext: JSON.parse(contextData),
      queryGuidelines: JSON.parse(guidelinesData)
    };
  } catch (error) {
    logger.warn({ error: error.message }, 'Failed to load business context, using defaults');
    return {
      businessContext: { primaryBusinessObjects: {}, fieldMeanings: {} },
      queryGuidelines: { queryPreferences: { defaultLimit: 200 } }
    };
  }
}

/**
 * Extract comprehensive metadata from Salesforce describe results
 */
function extractMetadataForLLM(describeIndex) {
  const metadata = {
    objects: [],
    relationships: [],
    fieldTypes: {}
  };

  for (const [objectApiName, objectData] of Object.entries(describeIndex.objects || {})) {
    const describe = objectData.describe;
    if (!describe) continue;

    // Object metadata
    const objectInfo = {
      apiName: objectApiName,
      label: describe.label,
      labelPlural: describe.labelPlural,
      custom: describe.custom,
      queryable: describe.queryable,
      createable: describe.createable,
      updateable: describe.updateable,
      deletable: describe.deletable,
      keyPrefix: describe.keyPrefix
    };

    // Field metadata
    const fields = [];
    const relationships = [];

    for (const field of describe.fields || []) {
      const fieldInfo = {
        name: field.name,
        label: field.label,
        type: field.type,
        custom: field.custom,
        nillable: field.nillable,
        unique: field.unique,
        updateable: field.updateable,
        createable: field.createable,
        filterable: field.filterable,
        sortable: field.sortable,
        length: field.length,
        precision: field.precision,
        scale: field.scale
      };

      fields.push(fieldInfo);

      // Track relationship fields
      if (field.relationshipName && field.referenceTo && field.referenceTo.length > 0) {
        relationships.push({
          fromObject: objectApiName,
          fromField: field.name,
          relationshipName: field.relationshipName,
          toObjects: field.referenceTo,
          relationshipType: field.type === 'reference' ? 'lookup' : 'master-detail'
        });
      }
    }

    objectInfo.fields = fields;
    metadata.objects.push(objectInfo);
    metadata.relationships.push(...relationships);
  }

  return metadata;
}

/**
 * Generate optimized SOQL/SOSL query using LLM
 */
export async function generateLLMQuery({ question, describeIndex, orgId = 'default', session = {} }) {
  try {
    // Load business context and guidelines
    const { businessContext, queryGuidelines } = await loadBusinessContext(orgId);
    
    // Extract comprehensive metadata for LLM
    const salesforceMetadata = extractMetadataForLLM(describeIndex);
    
    // Check for aggregation requirements
    const aggregationContext = detectAggregationNeeds(question, businessContext);
    
    // Build LLM prompt
    const systemPrompt = buildQueryGenerationPrompt(businessContext, queryGuidelines, salesforceMetadata);
    
    const userPrompt = `
USER QUESTION: "${question}"

SESSION CONTEXT: ${JSON.stringify(session, null, 2)}

AGGREGATION CONTEXT: ${JSON.stringify(aggregationContext, null, 2)}

Generate the optimal Salesforce query to answer this question. Consider:
1. The user's natural language intent
2. Available Salesforce objects and their purposes
3. Field relationships and data types
4. Business context and common query patterns
5. Performance and security best practices

Respond with a JSON object containing your query plan.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Generate query with LLM
    const response = await withRetry(() => chatComplete({ 
      messages, 
      stream: false, 
      temperature: 0.1, // Low temperature for consistent, logical output
      max_tokens: 1500 
    }), {
      retries: 2,
      delayMs: 600,
      shouldRetry: shouldRetryLLM
    });

    // Parse LLM response
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No response content from LLM');
    }

    // Extract JSON from response (handle potential markdown formatting)
    let queryPlan;
    try {
      const jsonString = extractJSONFromMarkdown(content);
      queryPlan = JSON.parse(jsonString);
    } catch (parseError) {
      logger.error({ error: parseError.message, content }, 'Failed to parse LLM response as JSON');
      throw new Error('Invalid JSON response from LLM');
    }

    // Validate query plan
    const validatedPlan = validateQueryPlan(queryPlan, salesforceMetadata);
    
    // Add aggregation context to the validated plan for response generation
    validatedPlan.aggregationContext = aggregationContext;
    
    logger.info({ 
      question, 
      queryType: validatedPlan.queryType, 
      targetObject: validatedPlan.targetObject,
      needsAggregation: aggregationContext.needsAggregation
    }, 'Generated LLM query plan');

    return validatedPlan;

  } catch (error) {
    logger.error({ error: error.message, question }, 'LLM query generation failed');
    throw error;
  }
}

/**
 * Build comprehensive system prompt for query generation
 */
function buildQueryGenerationPrompt(businessContext, queryGuidelines, salesforceMetadata) {
  // Extract subquery configuration
  const subqueryPatterns = businessContext?.subqueryPatterns || {};
  const formattingInstructions = businessContext?.llmFormattingInstructions || {};
  const wineQueryLimit = businessContext?.wineExpertiseDetection?.queryLimit || 200;
  const wineStatusFilter = businessContext?.wineExpertiseDetection?.statusFilter || "owsc__Item_Status__c = 'Active'";
  
  return `You are an expert Salesforce SOQL/SOSL query generator with sommelier expertise. Your job is to analyze user questions and generate optimal queries using the provided Salesforce metadata and business context.

## AVAILABLE SALESFORCE OBJECTS AND FIELDS:
${JSON.stringify(salesforceMetadata, null, 2)}

## BUSINESS CONTEXT:
${JSON.stringify(businessContext, null, 2)}

## QUERY GUIDELINES:
${JSON.stringify(queryGuidelines, null, 2)}

## SUBQUERY PATTERNS (CRITICAL - NEW FEATURE):
${JSON.stringify(subqueryPatterns, null, 2)}

## LLM FORMATTING INSTRUCTIONS:
${JSON.stringify(formattingInstructions, null, 2)}

## YOUR TASK:
Generate the optimal Salesforce query for the user's question. Follow these principles:

1. **Understand Intent**: Analyze what the user is really asking for
2. **Choose Optimal Query Type**: 
   - Use SOQL for specific object queries with known structure
   - Use SOSL for cross-object searches or when searching text across multiple objects
3. **Select Best Objects**: Use business context to identify the most relevant objects
4. **Include Relevant Fields**: Select fields that answer the question plus essential fields (Id, Name)
5. **CRITICAL - Relationship Fields**: For lookup/master-detail relationships, use proper SOQL syntax:
   - **Lookup/Reference Field**: owsc__Item__c (returns ID only)  
   - **Relationship Field**: owsc__Item__r.Name (returns related record's Name field)
   - **Example**: SELECT Id, Name, owsc__Item__c, owsc__Item__r.Name, owsc__Inventory_Location__r.Name FROM owsc__Item_Lot__c
   - **Always include both** the ID field AND the relationship field for proper data access
6. **Apply Smart Filtering**: Use WHERE clauses that make business sense
7. **Optimize Performance**: Follow SOQL best practices (indexed fields, selective filters)
8. **Respect Security**: Avoid sensitive objects and fields
9. **CRITICAL - Escape String Literals**: 
   - **Single quotes**: Use either method: 'Cockburn''s' (double quotes) OR 'Cockburn\'s' (backslash escape)
   - **Backslashes**: Escape as \\\\ in string literals
   - **Preferred**: Use backslash escaping (\') as it's cleaner and more readable
   - Be extra careful with apostrophes in brand names, product names, and text values
10. **RecordType References**: 
   - Use RecordType.Name or RecordType.DeveloperName for record type filtering
   - Avoid custom fields like owsc__RecordTypeName__c unless confirmed they exist
   - Example: WHERE RecordType.Name = 'Product' instead of WHERE owsc__RecordTypeName__c = 'Product'
11. **CRITICAL - Aggregation & Count Queries**: 
   - Check aggregationRules in business context for objects that need special handling
   - For count/total/sum queries: DO NOT use LIMIT (need all records to count properly)
   - Apply required filters from aggregationRules (e.g., Status = 'Active', quantity != 0)
   - When aggregation is needed, retrieve ALL raw data and explain grouping in your reasoning
   - SOQL cannot GROUP BY, so get raw records and mentally aggregate in your response
12. **CRITICAL - SUBQUERY DETECTION (NEW)**: 
   - Check subqueryPatterns configuration for parent-child relationship queries
   - Look for trigger phrases like "and their", "with their", "action and items", "orders and their items"
   - When detected, use SOQL subqueries with format: (SELECT fields FROM relationship_name)
   - Use relationshipMappings to get correct relationship names and subquery fields
   - Example: SELECT Id, Name, (SELECT Id, Name, owsc__Item__r.Name FROM owsc__Action_Items__r) FROM owsc__Action__c
   - This provides hierarchical data that you should format using llmFormattingInstructions

## UPDATED FIELD SELECTION AND FLEXIBILITY (ENABLED):
- Treat business-context and query-guidelines as guidance, not hard limits. You may add fields beyond suggestions when they clearly help answer the question.
- Always validate field names against the provided metadata (salesforceMetadata). Do not invent fields.
- Always include Id and Name for the primary object.
- For relationship lookups you include, prefer including BOTH the lookup Id (e.g., owsc__Item__c) AND a human-friendly field like owsc__Item__r.Name.
- Start with a focused field set (keep SELECT concise); only expand when needed. Aim for ≤ 12 fields per object unless required.
- Respect max limits from query-guidelines (defaultLimit/maxLimit). When more data is required, propose follow-up queries instead of exceeding limits.
- Avoid sensitive/PII fields and prefer business-safe fields (Name, code, status, quantity, price).
- For subqueries, include key child fields that allow a human-readable summary (child Name, quantities, price, status) without overfetching.
- If you add fields beyond configuration suggestions, briefly justify them in the reasoning (e.g., "added owsc__Item__r.Name for clarity").
- If a 400 error is likely (unknown fields/too many fields), propose a smaller safe set first.

## WINE PAIRING EXPERTISE (FOR FOOD PAIRING QUESTIONS ONLY):
When users ask about wine pairings with food, use the "query broad, analyze smart" approach:

STRATEGY:
1. **Query all wines broadly** - don't use restrictive WHERE filters based on keywords
2. **Get a good sample** - use reasonable LIMIT (100-300) to see variety of available wines
3. **Include key wine fields** - alcohol %, brand family, vintage, name for analysis
4. **Let the LLM analyze** the actual wine inventory and apply sommelier expertise
5. **Recommend 3-5 specific bottles** from real inventory with pairing explanations

WINE PAIRING KNOWLEDGE TO APPLY:
- **Chocolate/Desserts**: Tawny Port, Vintage Port, fortified wines, sweet wines. Look for brands like Graham's Port, Dow's Port, Cockburn's Port
- **Red meat (steak, lamb)**: Full-bodied reds, higher alcohol wines, aged vintages. Cabernet, vintage ports
- **Fish/Seafood**: Crisp whites, lower alcohol, fresh wines. Avoid heavy reds
- **Cheese**: Port wines, aged reds, sparkling. Depends on cheese type
- **Poultry**: Medium-bodied whites or light reds

FOR PAIRING QUERIES:
1. Query wines broadly: SELECT Id, Name, owsc__Alcohol_Percentage__c, owsc__Brand_Family__c, owsc__Vintage__c FROM owsc__Item__c WHERE RecordType.Name = 'Product' AND ${wineStatusFilter} ORDER BY Name ASC LIMIT ${wineQueryLimit}
2. In your reasoning, explain you'll analyze the wines for pairing suitability
3. Let the LLM response recommend specific bottles with sommelier explanations

## RESPONSE FORMAT:
Return a JSON object with this exact structure:
\`\`\`json
{
  "queryType": "SOQL" or "SOSL",
  "targetObject": "primary_object_api_name",
  "soql": "complete SOQL query" (if queryType is SOQL),
  "sosl": "complete SOSL query" (if queryType is SOSL),
  "fields": ["field1", "field2", "field3"],
  "reasoning": "detailed explanation of why you chose this approach",
  "confidence": 0.95,
  "alternatives": ["alternative approach 1", "alternative approach 2"],
  "businessContext": "which business context triggered this choice"
}
\`\`\`

## EXAMPLES:

User: "Show me all wines with alcohol percentage above 12%"
Response:
\`\`\`json
{
  "queryType": "SOQL",
  "targetObject": "owsc__Item__c", 
  "soql": "SELECT Id, Name, owsc__Alcohol_Percentage__c, owsc__Brand_Family__c, owsc__Vintage__c FROM owsc__Item__c WHERE owsc__Alcohol_Percentage__c > 12 ORDER BY owsc__Alcohol_Percentage__c DESC LIMIT 200",
  "fields": ["Id", "Name", "owsc__Alcohol_Percentage__c", "owsc__Brand_Family__c", "owsc__Vintage__c"],
  "reasoning": "User asked for wines with specific alcohol content. Based on business context, owsc__Item__c contains wine products with owsc__Alcohol_Percentage__c field. Added related fields like brand and vintage for context.",
  "confidence": 0.95,
  "alternatives": ["Could also search across multiple objects with SOSL", "Could join with lot information for inventory levels"],
  "businessContext": "product_queries - wine/alcohol content focus"
}
\`\`\`

User: "Find Cockburn's wines"
Response:
\`\`\`json
{
  "queryType": "SOQL",
  "targetObject": "owsc__Item__c",
  "soql": "SELECT Id, Name, owsc__Brand_Family__c, owsc__Alcohol_Percentage__c, owsc__Vintage__c FROM owsc__Item__c WHERE owsc__Brand_Family__c = 'Cockburn\'s' ORDER BY owsc__Vintage__c DESC LIMIT 200",
  "fields": ["Id", "Name", "owsc__Brand_Family__c", "owsc__Alcohol_Percentage__c", "owsc__Vintage__c"],
  "reasoning": "User searching for specific brand. Used owsc__Brand_Family__c field and CRITICAL: escaped the apostrophe in 'Cockburn\'s' using backslash escaping. This prevents SOQL syntax errors.",
  "confidence": 0.98,
  "alternatives": ["Could use CONTAINS for partial brand matching", "Could search across multiple objects"],
  "businessContext": "product_queries - brand-specific search"
}
\`\`\`

User: "Show me system inventory counts by location"
Response:
\`\`\`json
{
  "queryType": "SOQL",
  "targetObject": "owsc__Item_Lot__c",
  "soql": "SELECT Id, Name, owsc__Cases_On_Hand__c, owsc__Available_Cases__c, owsc__On_Hand_Count__c, owsc__Item__c, owsc__Item__r.Name, owsc__Inventory_Location__c, owsc__Inventory_Location__r.Name FROM owsc__Item_Lot__c WHERE owsc__Status__c = 'Active' AND owsc__On_Hand_Count__c != 0 ORDER BY owsc__Inventory_Location__r.Name ASC, owsc__Item__r.Name ASC",
  "fields": ["Id", "Name", "owsc__Cases_On_Hand__c", "owsc__Available_Cases__c", "owsc__On_Hand_Count__c", "owsc__Item__c", "owsc__Item__r.Name", "owsc__Inventory_Location__c", "owsc__Inventory_Location__r.Name"],
  "reasoning": "User wants system inventory counts by location. Using owsc__Item_Lot__c for system-calculated inventory. CRITICAL: Including both ID fields (owsc__Item__c, owsc__Inventory_Location__c) AND relationship fields (owsc__Item__r.Name, owsc__Inventory_Location__r.Name) for complete data access. Applied aggregation rules: active status filter and non-zero count filter. No LIMIT for count queries.",
  "confidence": 0.95,
  "alternatives": ["Could use owsc__Physical_Inventory__c for actual counts", "Could group by location in response analysis"],
  "businessContext": "system_inventory_queries - aggregation of system-calculated inventory by location"
}
\`\`\`

User: "Show me most recent Inventory Receipt action and their items"
Response:
\`\`\`json
{
  "queryType": "SOQL",
  "targetObject": "owsc__Action__c",
  "soql": "SELECT Id, Name, owsc__Action_Date__c, owsc__Stage__r.Name, owsc__Total_Gross_Price__c, (SELECT Id, Name, owsc__Item__r.Name, owsc__Cases_Ordered__c, owsc__Cases_Shipped__c, owsc__Case_Price__c, owsc__Gross_Extended_Price__c FROM owsc__Action_Items__r) FROM owsc__Action__c WHERE RecordType.Name = 'Inventory Receipt' ORDER BY owsc__Action_Date__c DESC LIMIT 1",
  "fields": ["Id", "Name", "owsc__Action_Date__c", "owsc__Stage__r.Name", "owsc__Total_Gross_Price__c", "owsc__Action_Items__r"],
  "reasoning": "CRITICAL: User asked for 'action and their items' - this triggers subquery pattern detection. Using SOQL subquery to get both the parent Action record AND its related Action_Item records in a single query. The subquery (SELECT ... FROM owsc__Action_Items__r) retrieves all line items for the action. This provides hierarchical data perfect for formatted display.",
  "confidence": 0.98,
  "alternatives": ["Could run separate queries for action and items", "Could use SOSL for broader search"],
  "businessContext": "order_queries - parent-child relationship query using subquery pattern"
}
\`\`\`

Generate queries that are accurate, efficient, and provide valuable business insights.`;
}

/**
 * Detect if the question requires aggregation (configuration-driven)
 */
function detectAggregationNeeds(question, businessContext) {
  const questionLower = question.toLowerCase();
  const aggregationRules = businessContext?.aggregationRules || {};
  const countOptimizations = businessContext?.queryOptimizations?.countQueries || {};
  
  let aggregationNeeded = null;
  let isCountQuery = false;
  
  // Check if this is a count/total/sum query
  const countTriggers = countOptimizations.triggers || [];
  isCountQuery = countTriggers.some(trigger => questionLower.includes(trigger));
  
  // Check each object's aggregation rules
  for (const [objectName, rules] of Object.entries(aggregationRules)) {
    const triggers = rules.whenToAggregate || [];
    const hasAggregationTrigger = triggers.some(trigger => questionLower.includes(trigger));
    
    if (hasAggregationTrigger) {
      aggregationNeeded = {
        targetObject: objectName,
        aggregateBy: rules.aggregateBy || [],
        sumFields: rules.sumFields || [],
        requiredFilters: rules.requiredFilters || [],
        noLimit: rules.noLimitForCounts || isCountQuery,
        instructions: rules.instructions || "Aggregate data by specified fields",
        isCountQuery: isCountQuery
      };
      break; // Use first match
    }
  }
  
  return {
    needsAggregation: aggregationNeeded !== null,
    isCountQuery: isCountQuery,
    rules: aggregationNeeded,
    reasoning: aggregationNeeded ? 
      `Detected aggregation needed for ${aggregationNeeded.targetObject} based on triggers: ${aggregationNeeded.aggregateBy.join(', ')}` :
      isCountQuery ? "Count query detected - no LIMIT should be used" : "No aggregation needed"
  };
}

/**
 * Extract JSON from LLM response, handling markdown formatting
 */
function extractJSONFromMarkdown(content) {
  if (!content) {
    throw new Error('No content to extract JSON from');
  }
  
  // Try multiple patterns to extract JSON
  const patterns = [
    /```json\s*(\{[\s\S]*?\})\s*```/,  // ```json { ... } ```
    /```\s*(\{[\s\S]*?\})\s*```/,     // ``` { ... } ```
    /(\{[\s\S]*\})/                   // Just { ... }
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // If no patterns match, try the content as-is (remove any leading/trailing whitespace)
  return content.trim();
}

/**
 * Validate and sanitize the LLM-generated query plan
 */
function validateQueryPlan(queryPlan, salesforceMetadata) {
  // Ensure required fields exist
  if (!queryPlan.queryType || !['SOQL', 'SOSL'].includes(queryPlan.queryType)) {
    throw new Error('Invalid or missing queryType. Must be SOQL or SOSL');
  }

  if (!queryPlan.targetObject) {
    throw new Error('Missing targetObject in query plan');
  }

  // Validate target object exists in metadata
  const objectExists = salesforceMetadata.objects.some(obj => obj.apiName === queryPlan.targetObject);
  if (!objectExists) {
    logger.warn({ targetObject: queryPlan.targetObject }, 'Target object not found in metadata');
  }

  // Ensure query field exists
  if (queryPlan.queryType === 'SOQL' && !queryPlan.soql) {
    throw new Error('Missing soql field for SOQL query type');
  }

  if (queryPlan.queryType === 'SOSL' && !queryPlan.sosl) {
    throw new Error('Missing sosl field for SOSL query type');
  }

  // Provide defaults for missing fields
  const validated = {
    queryType: queryPlan.queryType,
    targetObject: queryPlan.targetObject,
    soql: queryPlan.soql || '',
    sosl: queryPlan.sosl || '',
    fields: queryPlan.fields || ['Id', 'Name'],
    reasoning: queryPlan.reasoning || 'LLM-generated query plan',
    confidence: queryPlan.confidence || 0.8,
    alternatives: queryPlan.alternatives || [],
    businessContext: queryPlan.businessContext || 'general'
  };

  return validated;
}

/**
 * Detect if question needs cross-object search (SOSL) - LLM-driven version
 */
export async function shouldUseSOSLWithLLM({ question, describeIndex, orgId = 'default' }) {
  try {
    const { businessContext } = await loadBusinessContext(orgId);
    
    // Quick heuristic check first (for performance)
    const quickSOSLIndicators = [
      /search.*across.*object/i,
      /find.*in.*multiple.*object/i, 
      /search.*all.*object/i,
      /global.*search/i,
      /everywhere/i
    ];
    
    if (quickSOSLIndicators.some(pattern => pattern.test(question))) {
      return { useSOSL: true, reasoning: 'Explicit cross-object search indicators detected' };
    }

    // Use LLM for more nuanced decision
    const prompt = `Given this user question: "${question}"

Should this be answered with:
A) SOQL (single object query) - for specific object queries
B) SOSL (cross-object search) - for searching text across multiple objects

Consider the business context: ${JSON.stringify(businessContext.businessContextHints, null, 2)}

Respond with JSON: {"useSOSL": true/false, "reasoning": "explanation"}`;

    const response = await chatComplete({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0.1,
      max_tokens: 200
    });

    const content = response.choices?.[0]?.message?.content;
    const jsonString = extractJSONFromMarkdown(content);
    const decision = JSON.parse(jsonString);
    
    return decision;

  } catch (error) {
    logger.warn({ error: error.message }, 'SOSL detection failed, defaulting to SOQL');
    return { useSOSL: false, reasoning: 'Error in LLM detection, defaulting to SOQL' };
  }
}
