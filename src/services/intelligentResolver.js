// Intelligent object resolver with fuzzy matching, suggestions, and graceful degradation

/**
 * Calculate Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i-1) === str1.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1, // substitution
          matrix[i][j-1] + 1,   // insertion
          matrix[i-1][j] + 1    // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

/**
 * Calculate fuzzy similarity score (0-1, higher is better)
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/**
 * Smart object resolution with fuzzy matching and intelligent suggestions
 */
export async function resolveObjectsIntelligently(question, sf, orgProfile = {}, options = {}) {
  const {
    threshold = 0.6,           // Minimum similarity for fuzzy matches
    maxSuggestions = 5,        // Max suggestions to return
    includeSystemObjects = false, // Include system objects like Share, History
    enableFuzzySearch = true,  // Enable fuzzy matching
    sessionId = null,          // Session ID for user preferences
    userPreferences = {}       // User's object usage history
  } = options;

  // Step 1: Build comprehensive catalog
  const catalog = await buildComprehensiveCatalog(sf, { includeSystemObjects });
  
  // Step 2: Extract potential object keywords from question
  const keywords = extractObjectKeywords(question, orgProfile);
  
  // Step 3: Multi-stage matching
  const matches = [];
  
  // Stage 1: Exact matches (highest priority)
  for (const keyword of keywords) {
    const exactMatches = findExactMatches(keyword, catalog);
    for (const match of exactMatches) {
      matches.push({ ...match, confidence: 1.0, matchType: 'exact', keyword });
    }
  }
  
  // Stage 2: Partial matches (high priority)
  for (const keyword of keywords) {
    const partialMatches = findPartialMatches(keyword, catalog);
    for (const match of partialMatches) {
      matches.push({ ...match, confidence: 0.8, matchType: 'partial', keyword });
    }
  }
  
  // Stage 3: Fuzzy matches (if enabled and no strong matches)
  if (enableFuzzySearch && matches.filter(m => m.confidence > 0.7).length === 0) {
    for (const keyword of keywords) {
      const fuzzyMatches = findFuzzyMatches(keyword, catalog, threshold);
      for (const match of fuzzyMatches) {
        matches.push({ ...match, matchType: 'fuzzy', keyword });
      }
    }
  }
  
  // Stage 4: Context-aware ranking with user preferences
  const rankedMatches = rankByContextAndPreferences(matches, question, orgProfile, userPreferences);
  
  // Stage 5: Deduplicate and limit
  const deduped = deduplicateMatches(rankedMatches);
  const topMatches = deduped.slice(0, maxSuggestions);
  
  return {
    success: topMatches.length > 0,
    primaryMatch: topMatches[0] || null,
    suggestions: topMatches,
    confidence: topMatches[0]?.confidence || 0,
    needsClarification: topMatches.length > 1 && topMatches[0].confidence < 0.9,
    clarificationMessage: buildClarificationMessage(topMatches, keywords),
    usedPreferences: Object.keys(userPreferences).length > 0
  };
}

/**
 * Build comprehensive object catalog with labels, plurals, descriptions
 */
async function buildComprehensiveCatalog(sf, { includeSystemObjects = false } = {}) {
  try {
    const sobjects = await sf.listSObjects();
    const catalog = new Map();
    
    for (const obj of sobjects) {
      // Always skip problematic objects first
      if (isProblematicSystemObject(obj.name)) continue;
      
      // Skip system objects if not wanted (default behavior)
      if (!includeSystemObjects && isSystemObject(obj.name)) continue;
      
      const apiName = obj.name;
      const entries = [
        { key: apiName.toLowerCase(), type: 'api' },
        { key: (obj.label || '').toLowerCase(), type: 'label' },
        { key: (obj.labelPlural || '').toLowerCase(), type: 'labelPlural' }
      ].filter(e => e.key);
      
      // Add common variations
      entries.push(
        { key: apiName.replace(/__c$/, '').toLowerCase(), type: 'api_short' },
        { key: (obj.label || '').replace(/\s+/g, '').toLowerCase(), type: 'label_compact' }
      );
      
      for (const entry of entries) {
        if (!catalog.has(entry.key)) {
          catalog.set(entry.key, []);
        }
        catalog.get(entry.key).push({
          apiName,
          label: obj.label,
          labelPlural: obj.labelPlural,
          custom: obj.custom,
          matchedBy: entry.type
        });
      }
    }
    
    return catalog;
  } catch (error) {
    console.error('Failed to build catalog:', error);
    return new Map();
  }
}

/**
 * Extract potential object keywords from natural language question
 */
function extractObjectKeywords(question, orgProfile = {}) {
  const lower = question.toLowerCase();
  
  // Common business object patterns
  const patterns = [
    /\b(account|accounts|customer|customers|client|clients)\b/g,
    /\b(contact|contacts|person|people|individual)\b/g,
    /\b(opportunity|opportunities|deal|deals|sale|sales)\b/g,
    /\b(lead|leads|prospect|prospects)\b/g,
    /\b(case|cases|ticket|tickets|issue|issues)\b/g,
    /\b(product|products|item|items)\b/g,
    /\b(order|orders|purchase|purchases)\b/g,
    /\b(invoice|invoices|bill|bills)\b/g,
    /\b([a-z][a-z0-9_]*__c)\b/g, // Custom objects
  ];
  
  const keywords = new Set();
  
  // Extract pattern matches
  for (const pattern of patterns) {
    const matches = lower.match(pattern) || [];
    for (const match of matches) {
      keywords.add(match.trim());
    }
  }
  
  // Extract potential API names (CamelCase or snake_case with __c)
  const apiPattern = /\b[A-Z][a-zA-Z0-9_]*__c\b/g;
  const apiMatches = question.match(apiPattern) || [];
  for (const match of apiMatches) {
    keywords.add(match.toLowerCase());
  }
  
  // Check object synonyms from orgProfile
  const objectSynonyms = orgProfile.objectSynonyms || {};
  for (const [apiName, synonyms] of Object.entries(objectSynonyms)) {
    for (const synonym of synonyms) {
      if (lower.includes(synonym.toLowerCase())) {
        keywords.add(synonym.toLowerCase());
        // Also add the API name so it gets matched
        keywords.add(apiName.toLowerCase());
      }
    }
  }
  
  return Array.from(keywords).filter(k => k.length > 2);
}

/**
 * Find exact matches in catalog
 */
function findExactMatches(keyword, catalog) {
  return catalog.get(keyword) || [];
}

/**
 * Find partial matches (substring matching)
 */
function findPartialMatches(keyword, catalog) {
  const matches = [];
  
  for (const [key, objects] of catalog.entries()) {
    if (key.includes(keyword) || keyword.includes(key)) {
      const confidence = Math.min(keyword.length, key.length) / Math.max(keyword.length, key.length);
      for (const obj of objects) {
        matches.push({ ...obj, confidence });
      }
    }
  }
  
  return matches;
}

/**
 * Find fuzzy matches using similarity scoring
 */
function findFuzzyMatches(keyword, catalog, threshold) {
  const matches = [];
  
  for (const [key, objects] of catalog.entries()) {
    const similarity = calculateSimilarity(keyword, key);
    if (similarity >= threshold) {
      for (const obj of objects) {
        matches.push({ ...obj, confidence: similarity });
      }
    }
  }
  
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Rank matches by context, business logic, and user preferences
 */
function rankByContextAndPreferences(matches, question, orgProfile, userPreferences) {
  const questionLower = question.toLowerCase();
  
  return matches.map(match => {
    let contextBoost = 0;
    
    // 1. Boost standard objects for common business terms
    if (!match.custom) {
      if (questionLower.includes('customer') && match.apiName === 'Account') contextBoost += 0.2;
      if (questionLower.includes('person') && match.apiName === 'Contact') contextBoost += 0.2;
      if (questionLower.includes('deal') && match.apiName === 'Opportunity') contextBoost += 0.2;
      if (questionLower.includes('case') && match.apiName === 'Case') contextBoost += 0.2;
      if (questionLower.includes('lead') && match.apiName === 'Lead') contextBoost += 0.2;
    }
    
    // 2. Boost objects mentioned in org profile
    const frequentObjects = orgProfile.frequentObjects || [];
    if (frequentObjects.includes(match.apiName)) contextBoost += 0.15;
    
    // 3. Boost based on user's historical preferences
    const userPref = userPreferences[match.apiName];
    if (userPref) {
      // Weight by usage frequency and success rate
      const usageBoost = Math.min(0.3, userPref.count * 0.02); // Up to 0.3 boost
      const successBoost = userPref.successRate * 0.2; // Up to 0.2 boost
      
      // Recency boost (more recent = higher boost)
      const daysSinceLastUse = (Date.now() - (userPref.lastUsed || 0)) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 0.1 - (daysSinceLastUse * 0.01)); // Diminishes over time
      
      contextBoost += usageBoost + successBoost + recencyBoost;
    }
    
    // 4. Context-aware domain matching
    if (questionLower.includes('inventory') || questionLower.includes('stock')) {
      if (match.apiName.toLowerCase().includes('item') || match.apiName.toLowerCase().includes('product')) {
        contextBoost += 0.25;
      }
    }
    
    if (questionLower.includes('location') || questionLower.includes('warehouse')) {
      if (match.apiName.toLowerCase().includes('location') || match.apiName.toLowerCase().includes('warehouse')) {
        contextBoost += 0.25;
      }
    }
    
    // 4a. Special handling for generic business terms -> custom objects with namespaces
    if (match.custom && match.apiName.includes('__')) {
      // Massive boost for custom objects when user uses generic terms
      const genericTerms = ['item', 'product', 'inventory', 'order', 'customer', 'location'];
      for (const term of genericTerms) {
        if (questionLower.includes(term) && match.apiName.toLowerCase().includes(term)) {
          contextBoost += 0.8; // Very high boost to prioritize custom objects
        }
      }
      
      // Extra boost for owsc__ namespace objects (user's primary namespace)
      if (match.apiName.startsWith('owsc__')) {
        contextBoost += 0.3;
      }
      
      // MASSIVE boost when user explicitly mentions "object items" or similar
      if (questionLower.includes('object item') || questionLower.includes('found in') || questionLower.includes('located in')) {
        if (match.apiName.toLowerCase().includes('item')) {
          contextBoost += 2.0; // Huge boost for explicit user hints
        }
      }
      
      // Extra massive boost for exact "items" match to owsc__Item__c
      if (questionLower.includes(' items') || questionLower.includes('items ') || questionLower.includes('item ')) {
        if (match.apiName === 'owsc__Item__c') {
          contextBoost += 3.0; // Highest priority for the main items object
        }
      }
    }
    
    // 5. Heavily penalize system objects  
    if (isProblematicSystemObject(match.apiName)) contextBoost -= 2.0; // Massive penalty
    if (isSystemObject(match.apiName)) contextBoost -= 0.5;
    
    // 6. Slight boost for custom objects in business contexts
    if (match.custom && (questionLower.includes('business') || questionLower.includes('custom'))) {
      contextBoost += 0.05;
    }
    
    return {
      ...match,
      confidence: Math.min(1.0, match.confidence + contextBoost),
      reasonBoosts: {
        user: userPref ? 'Used previously' : null,
        context: contextBoost > 0.1 ? 'Context match' : null,
        org: frequentObjects.includes(match.apiName) ? 'Org frequent' : null
      }
    };
  }).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Check if object is particularly problematic and should NEVER be considered
 */
export function isProblematicSystemObject(apiName) {
  // First check for exact matches of extremely problematic objects
  const exactProblematicObjects = [
    'FlowOrchestrationWorkItem',
    'ProcessInstance', 
    'ProcessInstanceHistory',
    'ProcessInstanceStep',
    'ProcessInstanceWorkitem',
    'WorkflowAlert',
    'WorkflowEmailRecipient', 
    'WorkflowFieldUpdate',
    'WorkflowKnowledgePublish',
    'WorkflowOutboundMessage',
    'WorkflowRule',
    'WorkflowTask',
    'UserRecordAccess',
    'ObjectPermissions',
    'FieldPermissions',
    'SetupEntityAccess',
    'AsyncApexJob',
    'ApexTestQueueItem',
    'ApexTestResult',
    'ApexTestRunResult',
    'SearchActivity',
    'RecentlyViewed',
    'LoginHistory',
    'EventLogFile',
    'DuplicateRecordItem',
    'DuplicateRecordSet',
    'EntitySubscription',
    'FeedItem',
    'FeedComment',
    'UserFeed',
    'NewsFeed',
    'UserDefinedLabelAssignment',
    'UserDefinedLabel',
    'ValidationRule',
    'WorkflowAlert',
    'RecordType',
    'BusinessProcess',
    'PicklistValueInfo',
    'StandardValueSet',
    'GlobalValueSet'
  ];
  
  // Exact match check first
  if (exactProblematicObjects.includes(apiName)) return true;
  
  // Pattern-based checks for objects that should NEVER be considered
  if (/^FlowOrchestration/i.test(apiName)) return true;
  if (/^ProcessInstance/i.test(apiName)) return true;
  if (/^Workflow/i.test(apiName)) return true;
  if (/WorkItem$/i.test(apiName)) return true;
  if (/^UserDefined/i.test(apiName)) return true;
  if (/^Metadata/i.test(apiName)) return true;
  if (/^Setup/i.test(apiName)) return true;
  if (/(Assignment|Rule|Process|Alert)$/i.test(apiName)) return true;
  
  return false;
}

/**
 * Check if object is a system object that should be excluded from business queries
 */
function isSystemObject(apiName) {
  // System metadata and sharing objects
  if (/__(Share|History|Feed|Tag)$/i.test(apiName)) return true;
  
  // Flow and process objects
  if (/^(Flow|Process|WorkItem|Orchestration)/i.test(apiName)) return true;
  if (/FlowOrchestration|ProcessInstance|WorkflowRule/i.test(apiName)) return true;
  
  // Platform objects
  if (/^(Platform|Setup|Lightning|Component|Custom|Static|Dynamic)/i.test(apiName)) return true;
  
  // Security and permission objects
  if (/(Permission|UserRole|Profile|UserLicense|Login|Session)/i.test(apiName)) return true;
  if (/(ObjectPermissions|FieldPermissions|UserRecordAccess)/i.test(apiName)) return true;
  
  // System administration objects
  if (/(Organization|Domain|Network|Site|Community)/i.test(apiName)) return true;
  if (/(AsyncApex|ApexClass|ApexTrigger|ApexPage|ApexComponent)/i.test(apiName)) return true;
  
  // Change tracking and audit
  if (/(ChangeEvent|ChangeTracking|DataChangeLog|AuditTrail)/i.test(apiName)) return true;
  
  // Content and document metadata
  if (/(ContentDocument|ContentVersion|ContentWorkspace|Document|Folder)/i.test(apiName)) return true;
  if (/^(Attached|Combined|Collaboration)/i.test(apiName)) return true;
  
  // Integration and API objects
  if (/(CallCenter|EmailTemplate|MailmergeTemplate|WebLink|Dashboard)/i.test(apiName)) return true;
  
  // Common system objects that aren't useful for business queries
  const systemObjects = [
    'EntitySubscription', 'FeedItem', 'FeedComment', 'UserFeed', 'NewsFeed',
    'DuplicateRecordItem', 'DuplicateRecordSet', 'RecordAction', 'RecordType',
    'BusinessHours', 'Holiday', 'Territory', 'FiscalYearSettings',
    'CurrencyType', 'Category', 'CategoryNode', 'CategoryData',
    'FlowOrchestrationWorkItem', 'ProcessException', 'AssignmentRule',
    'Queue', 'Group', 'GroupMember', 'QueueSobject',
    'ActivityHistory', 'OpenActivity', 'CombinedAttachment', 'NoteAndAttachment',
    'AttachedContentDocument', 'AttachedContentNote',
    'SearchActivity', 'RecentlyViewed', 'OwnedItemHistory'
  ];
  
  if (systemObjects.includes(apiName)) return true;
  
  // Keep custom objects (ending with __c) unless they're clearly system-generated
  if (/^[a-zA-Z0-9_]+__c$/.test(apiName)) {
    // Exclude system-generated custom objects
    if (/(System|Platform|Setup|Config|Settings|Admin)__c$/i.test(apiName)) return true;
    return false; // Keep other custom objects
  }
  
  return false;
}

/**
 * Remove duplicate matches
 */
function deduplicateMatches(matches) {
  const seen = new Set();
  const unique = [];
  
  for (const match of matches) {
    if (!seen.has(match.apiName)) {
      seen.add(match.apiName);
      unique.push(match);
    }
  }
  
  return unique;
}

/**
 * Build user-friendly clarification message
 */
function buildClarificationMessage(matches, keywords) {
  if (matches.length === 0) {
    return `I couldn't find any Salesforce objects matching "${keywords.join(', ')}". Try using standard names like "Account", "Contact", or "Opportunity", or provide the exact API name.`;
  }
  
  if (matches.length === 1) {
    return null; // No clarification needed
  }
  
  const suggestions = matches.slice(0, 3).map(m => 
    `"${m.label || m.apiName}" (${m.apiName})`
  ).join(', ');
  
  return `I found multiple objects matching your request. Did you mean: ${suggestions}?`;
}

