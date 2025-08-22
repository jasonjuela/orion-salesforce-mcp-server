import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/withRetry.js';
import { shouldRetrySalesforce } from '../utils/retryPolicies.js';

/**
 * Enhanced Describe Service for LLM-Driven Query Generation
 * 
 * This service collects comprehensive Salesforce metadata for the LLM
 * to understand the data model without hardcoded assumptions.
 */

/**
 * Collect comprehensive metadata from Salesforce for LLM consumption
 */
export async function buildEnhancedDescribeIndex(sf, orgId, options = {}) {
  try {
    logger.info({ orgId }, 'Building enhanced describe index for LLM');
    
    const startTime = Date.now();
    
    // Step 1: Get all objects
    const allObjects = await withRetry(() => sf.listSObjects(), {
      retries: 3,
      delayMs: 800,
      shouldRetry: shouldRetrySalesforce
    });

    logger.info({ count: allObjects.length }, 'Retrieved object list');

    // Step 2: Filter objects for LLM analysis
    const relevantObjects = filterObjectsForLLM(allObjects, options);
    
    logger.info({ 
      total: allObjects.length, 
      filtered: relevantObjects.length 
    }, 'Filtered objects for LLM analysis');

    // Step 3: Describe relevant objects in batches
    const describePromises = relevantObjects.map(obj => 
      withRetry(() => sf.describeSObject(obj.name), {
        retries: 3,
        delayMs: 800,
        shouldRetry: shouldRetrySalesforce
      }).catch(error => {
        logger.warn({ object: obj.name, error: error.message }, 'Failed to describe object');
        return null; // Continue with other objects
      })
    );

    const describeResults = await Promise.all(describePromises);
    
    // Step 4: Build comprehensive index
    const enhancedIndex = buildComprehensiveIndex(relevantObjects, describeResults.filter(Boolean));
    
    const duration = Date.now() - startTime;
    logger.info({ 
      objects: enhancedIndex.objects.length,
      relationships: enhancedIndex.relationships.length,
      duration 
    }, 'Enhanced describe index built successfully');

    return enhancedIndex;

  } catch (error) {
    logger.error({ error: error.message, orgId }, 'Failed to build enhanced describe index');
    throw error;
  }
}

/**
 * Filter objects for LLM analysis - remove system objects that aren't useful for business queries
 */
function filterObjectsForLLM(allObjects, options = {}) {
  const { includeAllCustom = true, maxObjects = 100 } = options;
  
  return allObjects
    .filter(obj => {
      // Always include if explicitly specified
      if (options.forceInclude && options.forceInclude.includes(obj.name)) {
        return true;
      }
      
      // Skip if explicitly excluded
      if (options.exclude && options.exclude.includes(obj.name)) {
        return false;
      }
      
      // Must be queryable for LLM to use
      if (!obj.queryable) {
        return false;
      }
      
      // Include all custom objects (they're usually business-relevant)
      if (obj.custom && includeAllCustom) {
        return true;
      }
      
      // Include standard business objects
      const standardBusinessObjects = [
        'Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Task', 'Event',
        'Product2', 'Order', 'OrderItem', 'Asset', 'Contract', 'User'
      ];
      
      if (standardBusinessObjects.includes(obj.name)) {
        return true;
      }
      
      // Exclude known system/metadata objects
      const systemObjectPatterns = [
        /^(Setup|Organization|Profile|Permission|UserRole|LoginHistory)/,
        /^(Apex|Flow|Process|Workflow|Lightning|Component)/,
        /^(Dashboard|Report|Folder|Document|Content)/,
        /^(Activity|Calendar|Holiday|BusinessHours)/,
        /^(Campaign|EmailTemplate|Email|Mail)/,
        /^(Knowledge|Article|Topic|Vote)/,
        /^(Queue|Group|Territory|Forecast)/,
        /^(Price|Product|Schedule|Territory)/,
        /^(Social|Chatter|Feed|Post|Comment)/,
        /^(Survey|Question|Response)/,
        /(Share|History|Feed|Tag|Owner)$/,
        /^(Async|Batch|Job|Process).*$/
      ];
      
      if (systemObjectPatterns.some(pattern => pattern.test(obj.name))) {
        return false;
      }
      
      return true;
    })
    .sort((a, b) => {
      // Prioritize custom objects and common business objects
      if (a.custom && !b.custom) return -1;
      if (!a.custom && b.custom) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxObjects); // Limit to prevent overwhelming the LLM
}

/**
 * Build comprehensive index with all metadata LLM needs
 */
function buildComprehensiveIndex(objectList, describeResults) {
  const index = {
    objects: [],
    relationships: [],
    fieldsByType: {},
    businessObjectCatalog: new Map(),
    lastUpdated: new Date().toISOString()
  };

  for (let i = 0; i < objectList.length; i++) {
    const objectInfo = objectList[i];
    const describe = describeResults[i];
    
    if (!describe) continue;

    // Comprehensive object metadata
    const objectData = {
      apiName: objectInfo.name,
      label: describe.label,
      labelPlural: describe.labelPlural,
      custom: describe.custom,
      
      // Permissions
      queryable: describe.queryable,
      createable: describe.createable,
      updateable: describe.updateable,
      deletable: describe.deletable,
      mergeable: describe.mergeable,
      
      // Metadata
      keyPrefix: describe.keyPrefix,
      recordTypeInfos: describe.recordTypeInfos || [],
      
      // Field details
      fields: processFieldsForLLM(describe.fields || []),
      
      // Relationships (both parent and child)
      parentRelationships: [],
      childRelationships: [],
      
      // Business classification
      businessRelevance: classifyBusinessRelevance(objectInfo.name, describe)
    };

    // Process relationships
    for (const field of describe.fields || []) {
      if (field.relationshipName && field.referenceTo && field.referenceTo.length > 0) {
        const relationship = {
          fromObject: objectInfo.name,
          fromField: field.name,
          relationshipName: field.relationshipName,
          toObjects: field.referenceTo,
          type: field.type === 'reference' ? 'lookup' : 'master-detail',
          cascadeDelete: field.cascadeDelete || false,
          dependentPicklist: field.dependentPicklist || false
        };
        
        objectData.parentRelationships.push(relationship);
        index.relationships.push(relationship);
      }
    }

    // Process child relationships
    for (const childRel of describe.childRelationships || []) {
      objectData.childRelationships.push({
        childObject: childRel.childSObject,
        field: childRel.field,
        relationshipName: childRel.relationshipName,
        cascadeDelete: childRel.cascadeDelete || false
      });
    }

    index.objects.push(objectData);
    
    // Build catalog for quick lookups
    index.businessObjectCatalog.set(objectInfo.name.toLowerCase(), objectData);
    index.businessObjectCatalog.set(describe.label.toLowerCase(), objectData);
    if (describe.labelPlural) {
      index.businessObjectCatalog.set(describe.labelPlural.toLowerCase(), objectData);
    }
  }

  // Group fields by type for LLM understanding
  index.fieldsByType = groupFieldsByType(index.objects);
  
  return index;
}

/**
 * Process fields with comprehensive metadata for LLM
 */
function processFieldsForLLM(fields) {
  return fields.map(field => ({
    name: field.name,
    label: field.label,
    type: field.type,
    
    // Field properties
    custom: field.custom,
    nillable: field.nillable,
    unique: field.unique,
    externalId: field.externalId,
    
    // Query properties
    filterable: field.filterable,
    sortable: field.sortable,
    groupable: field.groupable,
    
    // Data properties
    length: field.length,
    precision: field.precision,
    scale: field.scale,
    
    // Permissions
    updateable: field.updateable,
    createable: field.createable,
    
    // Relationships
    relationshipName: field.relationshipName,
    referenceTo: field.referenceTo,
    
    // Options for picklists
    picklistValues: field.picklistValues || [],
    
    // Default value
    defaultValue: field.defaultValue,
    
    // Business classification
    businessCategory: classifyFieldBusinessCategory(field)
  }));
}

/**
 * Classify business relevance of objects for LLM prioritization
 */
function classifyBusinessRelevance(apiName, describe) {
  const name = apiName.toLowerCase();
  const label = (describe.label || '').toLowerCase();
  
  // High relevance - core business objects
  if (name.includes('item') || name.includes('product') || 
      name.includes('inventory') || name.includes('order') ||
      name.includes('account') || name.includes('contact') ||
      name.includes('action') || name.includes('container')) {
    return 'high';
  }
  
  // Medium relevance - supporting business objects  
  if (name.includes('location') || name.includes('company') ||
      name.includes('demand') || name.includes('allocation') ||
      name.includes('price') || name.includes('reference')) {
    return 'medium';
  }
  
  // Low relevance - system/administrative objects
  if (name.includes('setup') || name.includes('config') || 
      name.includes('setting') || name.includes('admin')) {
    return 'low';
  }
  
  // Custom objects are generally business-relevant
  if (describe.custom) {
    return 'medium';
  }
  
  return 'low';
}

/**
 * Classify fields by business category for LLM understanding
 */
function classifyFieldBusinessCategory(field) {
  const name = field.name.toLowerCase();
  const label = (field.label || '').toLowerCase();
  
  // Identification fields
  if (name.includes('id') || name === 'name' || name.includes('number')) {
    return 'identification';
  }
  
  // Quantity/measurement fields
  if (name.includes('quantity') || name.includes('amount') || 
      name.includes('percentage') || name.includes('cases') ||
      name.includes('count') || name.includes('total')) {
    return 'measurement';
  }
  
  // Location fields
  if (name.includes('location') || name.includes('address') || 
      name.includes('city') || name.includes('state') || 
      name.includes('country') || name.includes('warehouse')) {
    return 'location';
  }
  
  // Date/time fields
  if (field.type === 'date' || field.type === 'datetime' || 
      name.includes('date') || name.includes('time')) {
    return 'temporal';
  }
  
  // Status/classification fields
  if (name.includes('status') || name.includes('type') || 
      name.includes('category') || field.type === 'picklist') {
    return 'classification';
  }
  
  // Financial fields
  if (name.includes('price') || name.includes('cost') || 
      name.includes('value') || field.type === 'currency') {
    return 'financial';
  }
  
  return 'general';
}

/**
 * Group fields by type for LLM pattern recognition
 */
function groupFieldsByType(objects) {
  const fieldGroups = {
    identification: [],
    measurement: [],
    location: [],
    temporal: [],
    classification: [],
    financial: [],
    relationship: [],
    general: []
  };

  for (const obj of objects) {
    for (const field of obj.fields) {
      const category = field.businessCategory;
      if (fieldGroups[category]) {
        fieldGroups[category].push({
          object: obj.apiName,
          field: field.name,
          label: field.label,
          type: field.type
        });
      }
    }
  }

  return fieldGroups;
}
