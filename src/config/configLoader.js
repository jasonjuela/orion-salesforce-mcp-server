import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

// File-based configuration loader with fallback defaults
const CONFIG_DIR = 'data/configs';
const PERSONA_DIR = 'data/personas';

// Cache for loaded configs to avoid repeated file reads
const configCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load org-specific profile configuration
 */
export async function loadOrgProfile(orgId) {
  const cacheKey = `org:${orgId}`;
  const cached = configCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  
  try {
    // Try to load from file
    const configPath = path.join(CONFIG_DIR, `${orgId}.json`);
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Cache the loaded config
    configCache.set(cacheKey, { data: config, timestamp: Date.now() });
    
    logger.info('Loaded org profile from file', { orgId, configPath });
    return config;
    
  } catch (error) {
    // Fallback to default if file doesn't exist or is invalid
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to load org config, using default', { orgId, error: error.message });
    }
    
    const defaultConfig = {
      orgId,
      namespaces: ['owsc__'],
      guardrails: { 
        piiRedaction: true, 
        maxRows: 500, 
        defaultDateRange: 'LAST_N_MONTHS:12',
        allowedObjects: [], // Empty = allow all
        blockedObjects: ['UserRecordAccess', 'ObjectPermissions'] 
      },
      outputPrefs: { 
        defaultType: 'markdown', 
        preferTablesForListsOver: 10,
        includeMetadata: true 
      },
      preferences: { 
        showSoql: true,
        autoExpandRelationships: true,
        enableFuzzyMatching: true 
      },
      importantObjects: [
        'Account', 'Contact', 'Opportunity', 'Lead', 'Case', 'Product2',
        'owsc__Item__c', 'owsc__Item_Lot__c', 'owsc__Order__c'
      ],
      frequentObjects: [
        'Account', 'Contact', 'owsc__Item__c'
      ],
      objectSynonyms: {
        'owsc__Item__c': ['item', 'items', 'product item'],
        'owsc__Item_Lot__c': ['lot', 'lots', 'item lot', 'inventory lot', 'batch'],
        'owsc__Inventory_Location__c': ['location', 'locations', 'warehouse', 'site'],
        'Product2': ['product', 'products'],
        'Account': ['customer', 'customers', 'client', 'company'],
        'Contact': ['person', 'people', 'individual']
      },
      fieldMappings: {
        // Common field aliases
        'name': ['Name', 'Title', 'Subject'],
        'description': ['Description', 'Comments', 'Notes'],
        'amount': ['Amount', 'Value', 'Price', 'Total']
      },
      domainContext: {
        inventory: ['owsc__Item__c', 'owsc__Item_Lot__c', 'owsc__Inventory_Location__c'],
        sales: ['Account', 'Contact', 'Opportunity', 'Lead'],
        service: ['Case', 'Contact', 'Account']
      }
    };
    
    // Cache the default config
    configCache.set(cacheKey, { data: defaultConfig, timestamp: Date.now() });
    
    return defaultConfig;
  }
}

/**
 * Load persona configuration
 */
export async function loadPersona(name = 'helpful-architect') {
  const cacheKey = `persona:${name}`;
  const cached = configCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  
  try {
    const personaPath = path.join(PERSONA_DIR, `${name}.json`);
    const personaData = await fs.readFile(personaPath, 'utf8');
    const persona = JSON.parse(personaData);
    
    configCache.set(cacheKey, { data: persona, timestamp: Date.now() });
    
    logger.info('Loaded persona from file', { name, personaPath });
    return persona;
    
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to load persona, using default', { name, error: error.message });
    }
    
    const defaultPersona = {
      name,
      description: `${name} persona`,
      tone: 'professional, concise, friendly',
      style: 'data-focused with business context',
      formatting: { 
        markdownHeadings: true, 
        includeSOQLInMetadata: true,
        preferTables: true,
        showConfidence: false
      },
      prompts: {
        systemPrompt: 'You are a Salesforce architecture and data assistant. Provide clear, actionable insights based on the data.',
        clarificationPrompt: 'I need clarification to provide the most accurate results.',
        errorPrompt: 'I encountered an issue, but here are some alternatives:'
      },
      capabilities: {
        aggregation: true,
        relationships: true,
        timeRanges: true,
        fuzzyMatching: true
      }
    };
    
    configCache.set(cacheKey, { data: defaultPersona, timestamp: Date.now() });
    
    return defaultPersona;
  }
}

/**
 * Load system defaults
 */
export async function loadDefaults() {
  const cacheKey = 'defaults';
  const cached = configCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  
  try {
    const defaultsPath = path.join(CONFIG_DIR, 'defaults.json');
    const defaultsData = await fs.readFile(defaultsPath, 'utf8');
    const defaults = JSON.parse(defaultsData);
    
    configCache.set(cacheKey, { data: defaults, timestamp: Date.now() });
    
    logger.info('Loaded defaults from file', { defaultsPath });
    return defaults;
    
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to load defaults, using built-in', { error: error.message });
    }
    
    const builtInDefaults = {
      prompt_version: 'v1.2.0',
      api_version: '60.0',
      max_query_timeout: 30000,
      default_limit: 200,
      large_data_threshold: 1000,
      session_ttl_ms: 45 * 60 * 1000,
      cache_ttl_ms: 15 * 60 * 1000,
      retry_attempts: 3,
      features: {
        fuzzy_matching: true,
        relationship_planning: true,
        intelligent_suggestions: true,
        preference_learning: true,
        clarification_caching: true
      }
    };
    
    configCache.set(cacheKey, { data: builtInDefaults, timestamp: Date.now() });
    
    return builtInDefaults;
  }
}

/**
 * Save org profile to file
 */
export async function saveOrgProfile(orgId, profile) {
  try {
    const configPath = path.join(CONFIG_DIR, `${orgId}.json`);
    await fs.writeFile(configPath, JSON.stringify(profile, null, 2), 'utf8');
    
    // Update cache
    configCache.set(`org:${orgId}`, { data: profile, timestamp: Date.now() });
    
    logger.info('Saved org profile to file', { orgId, configPath });
    return true;
    
  } catch (error) {
    logger.error('Failed to save org profile', { orgId, error: error.message });
    return false;
  }
}

/**
 * Save persona to file
 */
export async function savePersona(name, persona) {
  try {
    const personaPath = path.join(PERSONA_DIR, `${name}.json`);
    await fs.writeFile(personaPath, JSON.stringify(persona, null, 2), 'utf8');
    
    // Update cache
    configCache.set(`persona:${name}`, { data: persona, timestamp: Date.now() });
    
    logger.info('Saved persona to file', { name, personaPath });
    return true;
    
  } catch (error) {
    logger.error('Failed to save persona', { name, error: error.message });
    return false;
  }
}

/**
 * List available org profiles
 */
export async function listOrgProfiles() {
  try {
    const files = await fs.readdir(CONFIG_DIR);
    return files
      .filter(file => file.endsWith('.json') && file !== 'defaults.json')
      .map(file => path.basename(file, '.json'));
  } catch (error) {
    logger.warn('Failed to list org profiles', { error: error.message });
    return [];
  }
}

/**
 * List available personas
 */
export async function listPersonas() {
  try {
    const files = await fs.readdir(PERSONA_DIR);
    return files
      .filter(file => file.endsWith('.json'))
      .map(file => path.basename(file, '.json'));
  } catch (error) {
    logger.warn('Failed to list personas', { error: error.message });
    return [];
  }
}

/**
 * Load business context configuration
 */
export async function loadBusinessContext(orgId) {
  const cacheKey = `business-context:${orgId}`;
  const cached = configCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  
  try {
    const contextPath = path.join(CONFIG_DIR, 'business-context.json');
    const contextData = await fs.readFile(contextPath, 'utf8');
    const businessContext = JSON.parse(contextData);
    
    configCache.set(cacheKey, { data: businessContext, timestamp: Date.now() });
    
    logger.info('Loaded business context from file', { orgId, contextPath });
    return businessContext;
    
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to load business context, using default', { orgId, error: error.message });
    }
    
    const defaultBusinessContext = {
      orgId,
      description: "Default business context for LLM-driven query generation",
      primaryBusinessObjects: {
        "owsc__Item__c": {
          businessPurpose: "Wine and product inventory items",
          keyBusinessConcepts: ["wine", "product", "inventory", "item"],
          commonQueries: ["inventory levels", "product searches"],
          keyFields: ["Name", "owsc__Alcohol_Percentage__c"],
          relationshipImportance: "high"
        }
      },
      keyRelationships: {},
      queryPatterns: {}
    };
    
    configCache.set(cacheKey, { data: defaultBusinessContext, timestamp: Date.now() });
    
    return defaultBusinessContext;
  }
}

/**
 * Clear configuration cache
 */
export function clearConfigCache() {
  configCache.clear();
  logger.info('Configuration cache cleared');
}


