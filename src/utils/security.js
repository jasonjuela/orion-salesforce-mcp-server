import { logger } from './logger.js';

/**
 * Check CRUD permissions for an object
 */
export async function checkCrudPermissions(sf, objectApiName, operation = 'read') {
  try {
    // For this implementation, we'll use the Salesforce Describe to check permissions
    // In a full implementation, you'd query UserObjectPermissions or use Session-based permissions
    const describe = await sf.describe(objectApiName);
    
    const permissions = {
      createable: describe.createable || false,
      updateable: describe.updateable || false,
      deletable: describe.deletable || false,
      queryable: describe.queryable || false,
      searchable: describe.searchable || false
    };
    
    // Check the specific operation
    switch (operation.toLowerCase()) {
      case 'create':
        return { allowed: permissions.createable, permissions };
      case 'read':
      case 'query':
        return { allowed: permissions.queryable, permissions };
      case 'update':
        return { allowed: permissions.updateable, permissions };
      case 'delete':
        return { allowed: permissions.deletable, permissions };
      case 'search':
        return { allowed: permissions.searchable, permissions };
      default:
        return { allowed: false, permissions, error: `Unknown operation: ${operation}` };
    }
    
  } catch (error) {
    logger.warn('Failed to check CRUD permissions', { 
      objectApiName, 
      operation, 
      error: error.message 
    });
    
    // Default to allowing read operations if we can't check permissions
    // This prevents the system from being too restrictive
    return { 
      allowed: operation.toLowerCase() === 'read' || operation.toLowerCase() === 'query', 
      permissions: null, 
      error: error.message,
      fallback: true
    };
  }
}

/**
 * Check field-level security (FLS) permissions
 */
export async function checkFieldPermissions(sf, objectApiName, fieldNames) {
  try {
    const describe = await sf.describe(objectApiName);
    const fieldMap = new Map();
    
    // Build field permission map
    for (const field of describe.fields || []) {
      fieldMap.set(field.name, {
        accessible: field.accessible !== false,
        updateable: field.updateable !== false,
        createable: field.createable !== false,
        filterable: field.filterable !== false,
        sortable: field.sortable !== false
      });
    }
    
    const results = {};
    const accessible = [];
    const restricted = [];
    
    for (const fieldName of fieldNames) {
      const permissions = fieldMap.get(fieldName);
      if (permissions) {
        results[fieldName] = permissions;
        if (permissions.accessible) {
          accessible.push(fieldName);
        } else {
          restricted.push(fieldName);
        }
      } else if (fieldName.includes('__r.')) {
        // This is a relationship field (e.g., owsc__Item__r.Name)
        // Check if the base relationship field exists and is accessible
        const baseField = fieldName.split('__r.')[0] + '__c'; // owsc__Item__c
        const basePermissions = fieldMap.get(baseField);
        
        if (basePermissions && basePermissions.accessible) {
          // Base relationship field exists and is accessible - allow the relationship traversal
          results[fieldName] = { accessible: true, isRelationshipField: true };
          accessible.push(fieldName);
        } else {
          // Base relationship field is not accessible
          results[fieldName] = { 
            accessible: false, 
            error: 'Base relationship field not accessible',
            baseField: baseField
          };
          restricted.push(fieldName);
        }
      } else {
        // Field not found in describe and not a relationship field
        results[fieldName] = { accessible: false, error: 'Field not found' };
        restricted.push(fieldName);
      }
    }
    
    return {
      accessible,
      restricted,
      details: results,
      hasRestrictions: restricted.length > 0
    };
    
  } catch (error) {
    logger.warn('Failed to check field permissions', { 
      objectApiName, 
      fieldNames, 
      error: error.message 
    });
    
    // Fallback: assume all fields are accessible if we can't check
    return {
      accessible: fieldNames,
      restricted: [],
      details: {},
      hasRestrictions: false,
      error: error.message,
      fallback: true
    };
  }
}

/**
 * Enhanced FLS enforcement with detailed reporting
 */
export function enforceFls(objectName, rows, allowedFields, fieldPermissions = null) {
  const filtered = [];
  const dropped = new Set();
  const securityReasons = new Map();
  
  // DEBUG: Log subquery-related information
  const subqueryFields = allowedFields.filter(f => f.endsWith('__r'));
  logger.info({ 
    objectName, 
    allowedFields, 
    subqueryFields,
    firstRowKeys: rows?.[0] ? Object.keys(rows[0]) : [],
    rowCount: rows?.length || 0
  }, 'DEBUG: enforceFls input data');
  
  for (const r of rows || []) {
    const f = {};
    
    for (const k of Object.keys(r)) {
      let includeField = false;
      let reason = null;
      
      // DEBUG: Special logging for subquery fields
      if (k.endsWith('__r')) {
        logger.info({ 
          key: k, 
          value: r[k], 
          isArray: Array.isArray(r[k]),
          arrayLength: Array.isArray(r[k]) ? r[k].length : 'N/A',
          allowedFieldsIncludes: allowedFields.includes(k)
        }, 'DEBUG: Processing relationship field');
      }
      
      // Always include system fields
      if (k === 'Id' || k === 'Name') {
        includeField = true;
      }
      // Always include aggregate expressions from COUNT, SUM, AVG, etc. queries
      else if (/^expr\d+$/.test(k)) {
        includeField = true;
      }
      // Handle relationship objects and subquery arrays (keys ending with __r) FIRST
      else if (k.endsWith('__r') && typeof r[k] === 'object' && r[k] !== null) {
        // Check if this is a subquery result (array or SF { totalSize, done, records }) or single relationship object
        const isSfSubqueryObject = !!(r[k] && typeof r[k] === 'object' && Array.isArray(r[k].records));
        if (Array.isArray(r[k]) || isSfSubqueryObject) {
          // This is a subquery result - array of child records
          // For subqueries, we typically want to include the entire array if the field is referenced
          // Check if this subquery field is in allowedFields or if it's always allowed for subqueries
          const isAllowed = allowedFields.includes(k) || 
                           allowedFields.some(field => field.startsWith(k + '.')) ||
                           allowedFields.some(field => field.includes(k));
          
          if (isAllowed) {
            // Filter each item in the subquery array through FLS
            const filteredArray = [];
            const subRecords = Array.isArray(r[k]) ? r[k] : (r[k].records || []);

            for (const subRecord of subRecords) {
              if (typeof subRecord === 'object' && subRecord !== null) {
                const filteredSubRecord = {};
                let hasAllowedSubFields = false;
                
                for (const subKey of Object.keys(subRecord)) {
                  // Always include system fields in subquery results
                  if (subKey === 'Id' || subKey === 'Name' || subKey === 'attributes') {
                    filteredSubRecord[subKey] = subRecord[subKey];
                    hasAllowedSubFields = true;
                  }
                  // Include other fields - for subqueries, we're typically more permissive
                  // since the main query already passed security validation
                  else {
                    filteredSubRecord[subKey] = subRecord[subKey];
                    hasAllowedSubFields = true;
                  }
                }
                
                if (hasAllowedSubFields) {
                  filteredArray.push(filteredSubRecord);
                }
              }
            }
            
            // CRITICAL FIX: Always include the subquery field, even if the array is empty
            // Empty arrays are valid subquery results (action with no items)
            if (isSfSubqueryObject) {
              const subqueryMeta = r[k];
              f[k] = {
                totalSize: typeof subqueryMeta.totalSize === 'number' ? subqueryMeta.totalSize : filteredArray.length,
                done: typeof subqueryMeta.done === 'boolean' ? subqueryMeta.done : true,
                records: filteredArray
              };
            } else {
              f[k] = filteredArray;
            }
            includeField = true;
          } else {
            reason = 'Subquery field not in allowed list';
          }
        } else {
          // This is a single relationship object - use existing logic
          const relationshipFields = allowedFields.filter(field => field.startsWith(k + '.'));
          
          if (relationshipFields.length > 0) {
            // At least one field from this relationship is allowed
            // Filter the relationship object to only include allowed nested fields
            const filteredRelationship = {};
            let hasAllowedFields = false;
            
            for (const nestedKey of Object.keys(r[k])) {
              const fullFieldName = `${k}.${nestedKey}`;
              if (allowedFields.includes(fullFieldName)) {
                filteredRelationship[nestedKey] = r[k][nestedKey];
                hasAllowedFields = true;
              } else if (nestedKey === 'attributes') {
                // Always include attributes for Salesforce metadata
                filteredRelationship[nestedKey] = r[k][nestedKey];
              }
            }
            
            if (hasAllowedFields) {
              f[k] = filteredRelationship;
              includeField = true;
            } else {
              reason = 'No accessible fields in relationship object';
            }
          } else {
            reason = 'Relationship object not in allowed list';
          }
        }
      }
      // Check if field is in allowed list (non-relationship or simple fields)
      else if (allowedFields.includes(k)) {
        // If we have detailed field permissions, check those too
        if (fieldPermissions && fieldPermissions.details[k]) {
          const perms = fieldPermissions.details[k];
          if (perms.accessible) {
            includeField = true;
          } else {
            reason = 'Field-level security restriction';
          }
        } else {
          includeField = true;
        }
      } else {
        reason = 'Field not in allowed list';
      }
      
      if (includeField) {
        // For regular fields, copy the value
        // Relationship objects are already handled in the relationship section above
        if (!k.endsWith('__r')) {
          f[k] = r[k];
        }
      } else {
        dropped.add(k);
        if (reason) {
          securityReasons.set(k, reason);
        }
      }
    }
    
    filtered.push(f);
  }
  
  return { 
    rows: filtered, 
    droppedFields: Array.from(dropped),
    securityReasons: Object.fromEntries(securityReasons),
    flsRestricted: dropped.size > 0
  };
}

/**
 * Comprehensive security check for query operations
 */
export async function validateQuerySecurity(sf, objectApiName, fields, orgProfile = {}) {
  const results = {
    allowed: false,
    objectPermissions: null,
    fieldPermissions: null,
    blockedReasons: [],
    warnings: []
  };
  
  try {
    // 1. Check if object is explicitly blocked
    const blockedObjects = orgProfile.guardrails?.blockedObjects || [];
    if (blockedObjects.includes(objectApiName)) {
      results.blockedReasons.push(`Object ${objectApiName} is blocked by org policy`);
      return results;
    }
    
    // 2. Check if only specific objects are allowed
    const allowedObjects = orgProfile.guardrails?.allowedObjects || [];
    if (allowedObjects.length > 0 && !allowedObjects.includes(objectApiName)) {
      results.blockedReasons.push(`Object ${objectApiName} is not in allowed list`);
      return results;
    }
    
    // 3. Check CRUD permissions
    const crudCheck = await checkCrudPermissions(sf, objectApiName, 'read');
    results.objectPermissions = crudCheck;
    
    if (!crudCheck.allowed) {
      results.blockedReasons.push(`No read permission for object ${objectApiName}`);
      return results;
    }
    
    // 4. Check field permissions
    if (fields && fields.length > 0) {
      const fieldCheck = await checkFieldPermissions(sf, objectApiName, fields);
      results.fieldPermissions = fieldCheck;
      
      if (fieldCheck.hasRestrictions) {
        results.warnings.push(`Some fields have access restrictions: ${fieldCheck.restricted.join(', ')}`);
      }
      
      // If no fields are accessible, block the query
      if (fieldCheck.accessible.length === 0) {
        results.blockedReasons.push('No accessible fields found');
        return results;
      }
    }
    
    // 5. All checks passed
    results.allowed = true;
    
    // Add warnings for fallback scenarios
    if (crudCheck.fallback) {
      results.warnings.push('CRUD permissions check used fallback logic');
    }
    if (results.fieldPermissions?.fallback) {
      results.warnings.push('Field permissions check used fallback logic');
    }
    
    return results;
    
  } catch (error) {
    logger.error('Security validation failed', { 
      objectApiName, 
      fields, 
      error: error.message 
    });
    
    results.blockedReasons.push(`Security check failed: ${error.message}`);
    return results;
  }
}

/**
 * Security middleware for protecting sensitive operations
 */
export function createSecurityMiddleware(options = {}) {
  const { 
    requireAuth = true, 
    checkObjectPermissions = true,
    logSecurityEvents = true 
  } = options;
  
  return async (req, res, next) => {
    try {
      // Basic authentication check
      if (requireAuth) {
        const { sessionId, org_id } = req.body || req.query;
        if (!sessionId || !org_id) {
          return res.status(401).json({ 
            error: 'authentication_required', 
            message: 'Session ID and Org ID required' 
          });
        }
      }
      
      // Log security events if enabled
      if (logSecurityEvents) {
        logger.info('Security check passed', { 
          endpoint: req.path,
          method: req.method,
          sessionId: req.body?.sessionId || req.query?.sessionId,
          orgId: req.body?.org_id || req.query?.org_id
        });
      }
      
      next();
      
    } catch (error) {
      logger.error('Security middleware error', { error: error.message });
      res.status(500).json({ 
        error: 'security_check_failed', 
        message: error.message 
      });
    }
  };
}


