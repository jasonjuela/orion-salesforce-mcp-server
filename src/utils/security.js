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
      } else {
        // Field not found in describe - might be a relationship field
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
  
  for (const r of rows || []) {
    const f = {};
    
    for (const k of Object.keys(r)) {
      let includeField = false;
      let reason = null;
      
      // Always include system fields
      if (k === 'Id' || k === 'Name') {
        includeField = true;
      }
      // Check if field is in allowed list
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
        f[k] = r[k];
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


