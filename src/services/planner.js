import { SessionStore } from '../config/sessionStore.js';
import { isProblematicSystemObject } from './intelligentResolver.js';

// Build a simple multi-hop path using Describe child/parent relationships
export function planRelationshipPath(describeIndex, startObject, targetKeywords = []) {
  const results = [];
  const visited = new Set();
  const maxDepth = 3;

  function dfs(objectApiName, path, depth) {
    if (depth > maxDepth) return;
    if (visited.has(objectApiName)) return;
    
    // Never consider problematic system objects in relationship planning
    if (isProblematicSystemObject(objectApiName)) return;
    
    visited.add(objectApiName);
    const obj = describeIndex.objects[objectApiName];
    if (!obj) return;
    const hay = `${objectApiName} ${(obj.describe?.label || '')} ${(obj.describe?.labelPlural || '')}`.toLowerCase();
    let score = 0;
    for (const kw of targetKeywords) {
      const k = String(kw || '').toLowerCase();
      if (k && hay.includes(k)) score += 1;
    }
    // Neighbor keyword signal without hardcoding: use related API names and known labels (if present)
    const neighborHays = [];
    for (const [, parentApi] of obj.relationships || []) neighborHays.push(String(parentApi || ''));
    for (const [, childApi] of obj.childRelationships || []) neighborHays.push(String(childApi || ''));
    const neighborText = neighborHays.join(' ').toLowerCase();
    for (const kw of targetKeywords) {
      const k = String(kw || '').toLowerCase();
      if (k && neighborText.includes(k)) score += 0.8; // softer boost if found among neighbors
    }
    results.push({ objectApiName, path: [...path], score, depth });
    // parent lookups (child -> parent)
    for (const [relName, parentApi] of obj.relationships || []) {
      dfs(parentApi, [...path, { type: 'parent', relName, to: parentApi }], depth + 1);
    }
    // child relationships (parent -> children)
    for (const [childRelName, childApi] of obj.childRelationships || []) {
      dfs(childApi, [...path, { type: 'child', relName: childRelName, to: childApi }], depth + 1);
    }
  }

  dfs(startObject, [], 0);
  results.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return results[0];
}

/**
 * Check if a question is time-sensitive and requires date filtering
 */
export function isQuestionTimeSensitive(question) {
  const q = question.toLowerCase();
  
  // Time-sensitive keywords that indicate recent data is needed
  const timeSensitivePatterns = [
    // Explicit time references
    /\b(last|recent|lately|yesterday|today|this|past)\s+(week|month|year|quarter|day|days|months|years|quarters)\b/,
    /\b(last|past)\s+\d+\s+(day|days|week|weeks|month|months|year|years)\b/,
    /\bin\s+(the\s+)?(last|past|recent)\b/,
    /\b(recently|lately|newly)\s+(created|added|updated|modified)\b/,
    
    // Reporting/analytics queries that typically want recent data
    /\b(summary|summarize|report|reporting|trend|trends|growth|performance)\b/,
    /\b(how\s+many|count|total|sum)\s+.*\s+(last|recent|this|past)\b/,
    
    // Explicit date ranges
    /\b(since|from|after|before|until|through)\s+\d{4}\b/, // years
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
    
    // Activity-based queries that imply recency
    /\b(activity|activities|changes|modifications|updates)\b/,
    /\bwhat.*happened\b/,
    /\bwho.*created\b/,
    /\bwhen.*was.*created\b/
  ];
  
  return timeSensitivePatterns.some(pattern => pattern.test(q));
}

/**
 * Extract search terms from question for name-based filtering
 */
function extractSearchTerms(question) {
  // Remove common question words and focus on potential product/brand names
  const cleanQuestion = question.toLowerCase()
    .replace(/\b(what|is|the|of|for|in|on|at|with|by|from|about|how|where|when|which|who|why)\b/g, ' ')
    .replace(/\b(percentage|percent|alcohol|content|level|amount|value|price|cost)\b/g, ' ')
    .trim();
  
  // Look for quoted strings first (exact matches)
  const quotedTerms = cleanQuestion.match(/'([^']+)'|"([^"]+)"/g) || [];
  const searchTerms = quotedTerms.map(term => term.replace(/['"]/g, ''));
  
  // Common generic words to avoid using as search terms
  const genericWords = new Set(['wine', 'wines', 'product', 'products', 'item', 'items', 'thing', 'things']);
  
  // Look for capitalized words (likely brand/product names)
  const words = cleanQuestion.split(/\s+/).filter(word => word.length > 2);
  for (const word of words) {
    // Look for words that might be brand names (contain apostrophes, capital letters, etc.)
    if (word.includes("'") || /[A-Z]/.test(word) || word.length > 4) {
      // Clean up the word
      const cleanWord = word.replace(/[^\w']/g, '').trim().toLowerCase();
      if (cleanWord.length > 2 && !searchTerms.includes(cleanWord) && !genericWords.has(cleanWord)) {
        searchTerms.push(cleanWord);
      }
    }
  }
  
  return searchTerms.filter(term => term.length > 2);
}

/**
 * Find relevant fields based on question keywords
 */
function findRelevantFields(question, availableFields) {
  if (!availableFields || availableFields.length === 0) {
    console.log('DEBUG: No availableFields provided to findRelevantFields');
    return [];
  }
  
  const q = question.toLowerCase();
  const relevantFields = [];
  

  
  // Define keyword patterns for common field types
  const fieldPatterns = {
    // Alcohol/beverage fields
    alcohol: ['alcohol', 'abv', 'proof', 'strength', 'percentage', 'percent', '%'],
    // Price fields
    price: ['price', 'cost', 'amount', 'value', 'dollar', '$', 'pricing'],
    // Quantity fields
    quantity: ['quantity', 'qty', 'amount', 'count', 'number', 'volume', 'size'],
    // Status fields
    status: ['status', 'state', 'stage', 'condition', 'active', 'inactive'],
    // Description fields
    description: ['description', 'desc', 'details', 'notes', 'comment', 'remarks'],
    // Date fields
    date: ['date', 'time', 'created', 'modified', 'updated', 'expiry', 'expires'],
    // Type/Category fields
    type: ['type', 'category', 'kind', 'classification', 'group', 'class'],
    // Location fields
    location: ['location', 'address', 'city', 'state', 'country', 'region', 'warehouse'],
    // Contact fields
    contact: ['contact', 'phone', 'email', 'address', 'person', 'rep', 'representative']
  };
  
  // Check each available field against question keywords
  for (const field of availableFields) {
    // Skip fields that are explicitly not queryable or deprecated
    // Note: queryable property may not exist in some API versions, so only filter if explicitly false
    if (field.queryable === false || field.deprecatedAndHidden === true) continue;
    
    const fieldName = field.name.toLowerCase();
    const fieldLabel = (field.label || '').toLowerCase();
    const searchText = `${fieldName} ${fieldLabel}`;
    
    // Check if any question keywords match field patterns
    for (const [category, keywords] of Object.entries(fieldPatterns)) {
      const hasQuestionKeyword = keywords.some(keyword => q.includes(keyword));
      const hasFieldMatch = keywords.some(keyword => 
        searchText.includes(keyword) || 
        fieldName.includes(keyword) ||
        // Check for common field naming patterns
        (keyword === 'alcohol' && (fieldName.includes('abv') || fieldName.includes('alcohol') || fieldLabel.includes('abv') || fieldLabel.includes('alcohol'))) ||
        (keyword === 'price' && (fieldName.includes('price') || fieldName.includes('cost') || fieldLabel.includes('price') || fieldLabel.includes('cost'))) ||
        (keyword === 'percentage' && (fieldName.includes('percent') || fieldName.includes('pct') || fieldName.includes('%') || fieldLabel.includes('percent') || fieldLabel.includes('pct') || fieldLabel.includes('%')))
      );
      
      if (hasQuestionKeyword && hasFieldMatch) {
        relevantFields.push(field.name);
        break; // Don't add the same field multiple times
      }
    }
  }
  
  // Limit to most relevant fields to avoid SOQL query length issues
  const finalFields = relevantFields.slice(0, 10);
  return finalFields;
}

export function detectIntent(question) {
  const q = question.toLowerCase();
  if (/chart|plot|graph/.test(q)) return 'visualize';
  if (/summarize|summary|sum|total|avg|average|count|by month|group/i.test(q)) return 'aggregate';
  if (/what is|explain|fields|describe/.test(q)) return 'explain_object';
  if (/search|find|locate|look.*for|where.*is|contains|matching/i.test(q)) return 'search';
  if (/list|show|table/.test(q)) return 'list_related_records';
  return 'answer';
}

export function resolveEntities(question, describeIndex, orgProfile, session) {
  // Dynamic resolution using global catalog from Describe, with session/org synonyms as weak hints
  const entities = new Set();
  const lower = String(question || '').toLowerCase();
  const tokens = lower.split(/[^a-z0-9_]+/);
  const catalog = describeIndex?.catalog || new Map();

  // 1) Direct API name references
  for (const t of tokens) if (/^[a-zA-Z0-9_]+(__c)?$/.test(t) && catalog.has(t.toLowerCase())) entities.add(catalog.get(t.toLowerCase()));
  for (const t of tokens) if (/__c$/.test(t)) entities.add(t);

  // 2) Label or plural label matches
  for (const [key, api] of catalog.entries()) {
    if (lower.includes(key)) entities.add(api);
  }

  // 3) Synonyms (soft hints)
  const alias = { ...(orgProfile.objectSynonyms || {}), ...(session.objectAliases || {}) };
  for (const [api, syns] of Object.entries(alias)) {
    for (const s of syns) if (lower.includes(String(s).toLowerCase())) entities.add(api);
  }

  // 4) Rank entities by match strength to prefer the most semantically aligned object (no hardcoding)
  const apiToScore = new Map();
  // Rebuild api -> keys list from catalog
  const apiToKeys = new Map();
  for (const [key, api] of catalog.entries()) {
    const list = apiToKeys.get(api) || [];
    list.push(key);
    apiToKeys.set(api, list);
  }
  const tokenSet = new Set(tokens.filter(Boolean));
  for (const api of entities) {
    let score = 0;
    const keys = apiToKeys.get(api) || [];
    for (const k of keys) {
      if (!k) continue;
      if (lower.includes(k)) score += Math.min(8, k.length * 0.5);
      if (new RegExp(`\\b${k}\\b`).test(lower)) score += 3;
      // Token overlap bonus
      if (tokenSet.has(k)) score += 4;
    }
    // Synonym overlap bonus
    const syns = alias[api] || [];
    for (const s of syns) {
      const ls = String(s || '').toLowerCase();
      if (!ls) continue;
      if (lower.includes(ls)) score += 2;
      if (tokenSet.has(ls)) score += 2;
    }
    apiToScore.set(api, score);
  }
  return Array.from(entities).sort((a, b) => (apiToScore.get(b) || 0) - (apiToScore.get(a) || 0));
}

/**
 * Detect if a question requires cross-object search (SOSL)
 */
export function shouldUseSOSL(question, intent) {
  const q = question.toLowerCase();
  
  // Explicit cross-object search indicators
  const crossObjectIndicators = [
    /search.*across.*object/i,
    /find.*in.*multiple.*object/i,
    /search.*all.*object/i,
    /global.*search/i,
    /cross.*object/i,
    /everywhere/i,
    /all.*records.*contain/i,
    /any.*object.*with/i,
    /search.*everything/i,
    /find.*anywhere/i
  ];
  
  // Multiple object mentions
  const objectMentions = [
    /\b(account|contact|lead|opportunity|case|product|asset)\b/gi,
    /\b(item|order|invoice|location|allocation)\b/gi
  ];
  
  let objectCount = 0;
  for (const pattern of objectMentions) {
    const matches = q.match(pattern);
    if (matches) objectCount += matches.length;
  }
  
  // Check for explicit indicators
  const hasExplicitIndicator = crossObjectIndicators.some(pattern => pattern.test(q));
  
  // Check for multiple object mentions (3+ suggests cross-object search)
  const hasMultipleObjects = objectCount >= 3;
  
  // Check for search-like intent with text-based queries
  const hasTextSearchIntent = intent === 'search' || 
    /search|find|look.*for|locate|where.*is|contains|includes|matching/.test(q);
  
  return hasExplicitIndicator || hasMultipleObjects || (hasTextSearchIntent && q.length > 20);
}

/**
 * Build SOSL search plan for cross-object queries
 */
export function buildSOSLPlan({ question, entities, orgProfile, describeIndex, session, limit = 200 }) {
  const q = question.toLowerCase();
  
  // Extract search terms (remove common words)
  const searchTerms = extractSearchTerms(question);
  
  // If no specific search terms, use key words from question
  let searchString = '';
  if (searchTerms.length > 0) {
    searchString = searchTerms.join(' OR ');
  } else {
    // Extract meaningful words for search
    const meaningfulWords = question
      .toLowerCase()
      .replace(/\b(what|is|the|of|for|in|on|at|with|by|from|about|how|where|when|which|who|why|find|search|look|show|give|me|a|an|and|or|but)\b/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 5); // Limit to 5 words
    
    searchString = meaningfulWords.join(' OR ');
  }
  
  // Default objects to search if none specified
  const defaultObjects = [
    'Account', 'Contact', 'Lead', 'Opportunity', 'Case'
  ];
  
  // Add org-specific objects from orgProfile
  const orgObjects = [];
  if (orgProfile?.objectSynonyms) {
    for (const [apiName, synonyms] of Object.entries(orgProfile.objectSynonyms)) {
      if (apiName && !orgObjects.includes(apiName)) {
        orgObjects.push(apiName);
      }
    }
  }
  
  // Combine and filter objects
  let targetObjects = [...new Set([...defaultObjects, ...orgObjects])];
  
  // If specific entities were detected, prioritize those
  if (entities && entities.length > 0) {
    targetObjects = [...new Set([...entities, ...targetObjects])];
  }
  
  // Limit to prevent SOSL query from being too large
  targetObjects = targetObjects.slice(0, 10);
  
  // Build RETURNING clause with relevant fields for each object
  const returningClauses = targetObjects.map(objName => {
    const fields = ['Id'];
    
    // Object-specific name fields
    const describe = describeIndex?.objects?.[objName]?.describe;
    let nameField = 'Name'; // Default
    
    // Handle objects with different name fields
    if (objName === 'Case') {
      nameField = 'Subject';
    } else if (objName === 'Lead' || objName === 'Contact') {
      nameField = 'Name'; // These actually use Name field
    }
    
    // Check if the name field exists and is queryable
    if (describe?.fields) {
      const nameFieldDescribe = describe.fields.find(f => f.name === nameField);
      if (nameFieldDescribe && nameFieldDescribe.queryable !== false && !nameFieldDescribe.deprecatedAndHidden) {
        fields.push(nameField);
      }
      
      // Add common fields if they exist for this object
      const commonFields = ['CreatedDate', 'LastModifiedDate', 'OwnerId'];
      for (const commonField of commonFields) {
        const field = describe.fields.find(f => f.name === commonField);
        if (field && field.queryable !== false && !field.deprecatedAndHidden) {
          fields.push(commonField);
        }
      }
      
      // Add relevant fields based on question keywords
      const relevantFields = findRelevantFields(q, describe.fields || []);
      fields.push(...relevantFields);
    } else {
      // If no describe available, add Name if it's not Case
      if (objName !== 'Case') {
        fields.push('Name');
      } else {
        fields.push('Subject');
      }
    }
    
    // Remove duplicates and limit fields
    const uniqueFields = [...new Set(fields)].slice(0, 8);
    return `${objName}(${uniqueFields.join(', ')})`;
  });
  
  // Build SOSL query
  const returning = returningClauses.join(', ');
  const sosl = `FIND {${searchString}} IN ALL FIELDS RETURNING ${returning} LIMIT ${limit}`;
  
  return {
    type: 'sosl',
    query: sosl,
    searchTerms,
    targetObjects,
    limit
  };
}

export function buildSoqlPlan({ intent, entities, orgProfile, describeIndex, session, countOnly = false, dateRange, question = '' }) {
  const primary = entities[0] || 'Account';
  
  // Parse quantity from question
  const q = String(question || '').toLowerCase();
  let limit = 200; // default
  if (q.includes('one ') || q.includes('single ') || q.includes(' 1 ')) {
    limit = 1;
  } else if (q.includes('five ') || q.includes(' 5 ')) {
    limit = 5;
  } else if (q.includes('ten ') || q.includes(' 10 ')) {
    limit = 10;
  }
  
  // Parse field requirements from question
  let fields = ['Id', 'Name']; // default fallback
  const wantsAllFields = q.includes('all field') || q.includes('all the field') || q.includes('every field');
  
  if (wantsAllFields && describeIndex?.objects?.[primary]?.describe?.fields) {
    // Get all queryable fields from metadata
    const allFields = describeIndex.objects[primary].describe.fields
      .filter(f => f.queryable && !f.deprecatedAndHidden)
      .map(f => f.name);
    if (allFields.length > 0) {
      fields = allFields.slice(0, 50); // Limit to first 50 fields to avoid SOQL limits
    }
  } else {
    // Smart field detection based on question keywords
    const relevantFields = findRelevantFields(q, describeIndex?.objects?.[primary]?.describe?.fields || []);
    if (relevantFields.length > 0) {
      fields = Array.from(new Set([...fields, ...relevantFields]));
    }
  }

  // Extract search terms from question (brand names, product names, etc.)
  const searchTerms = extractSearchTerms(q);
  
  // Only add date filters if the question is time-sensitive or explicitly requests recent data
  const isTimeSensitive = isQuestionTimeSensitive(q);
  console.log(`DEBUG: Question: "${q}" | Time-sensitive: ${isTimeSensitive} | dateRange: ${dateRange}`);
  let whereConditions = [];
  
  if (isTimeSensitive || dateRange) {
    const defaultDate = orgProfile?.guardrails?.defaultDateRange || 'LAST_N_MONTHS:12';
    const dr = dateRange || defaultDate;
    console.log(`DEBUG: Adding date filter: CreatedDate = ${dr}`);
    whereConditions.push(`CreatedDate = ${dr}`);
  } else {
    console.log(`DEBUG: No date filter added - question is not time-sensitive`);
  }
  
  // Add name-based filtering if search terms found
  if (searchTerms.length > 0) {
    const nameConditions = searchTerms.map(term => {
      // Escape single quotes for SOQL
      const escapedTerm = term.replace(/'/g, "\\'");
      return `Name LIKE '%${escapedTerm}%'`;
    });
    whereConditions.push(`(${nameConditions.join(' OR ')})`);
  }
  
  // Build final WHERE clause
  const where = whereConditions.length > 0 ? whereConditions.join(' AND ') : '';

  // De-duplicate fields defensively
  const uniqueFields = Array.from(new Set(fields));
  const select = countOnly ? 'COUNT()' : uniqueFields.join(', ');
  // ORDER BY not allowed with COUNT(); include only when not countOnly
  const orderAndLimit = countOnly ? '' : ` ORDER BY CreatedDate DESC LIMIT ${limit}`;
  
  // Build SOQL with optional WHERE clause
  const soql = where 
    ? `SELECT ${select} FROM ${primary} WHERE ${where}${orderAndLimit}`.trim()
    : `SELECT ${select} FROM ${primary}${orderAndLimit}`.trim();
  return { object: primary, soql, fields: uniqueFields, where };
}


