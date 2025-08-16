// Build a minimal schema index from Salesforce Describe

import { DescribeCache } from './describeCache.js';

export async function buildDescribeIndex(sf, objects, { orgId } = {}) {
  const index = { objects: {} };
  // index.catalog may be provided by caller; otherwise leave empty
  const unique = Array.from(new Set(objects.filter(Boolean)));
  for (const objectApiName of unique) {
    try {
      let d = (orgId && DescribeCache.get(orgId, objectApiName)) || undefined;
      if (!d) {
        d = await sf.describeSObject(objectApiName);
        if (orgId) DescribeCache.set(orgId, objectApiName, d);
      }
      const fieldMap = new Map();
      const readable = new Set();
      const relationships = new Map(); // child-to-parent: relationshipName -> target API name
      const childRelationships = new Map(); // parent-to-child: relationshipName -> child API name
      for (const f of d.fields || []) {
        fieldMap.set(f.name, f);
        if (f.createable || f.updateable || f.filterable || f.name) {
          // prefer readable flag if present; fall back to not enforcing
          if (f.filterable === true || f.name === 'Id' || f.name === 'Name' || f.permissionable === true || f.updateable === true) {
            readable.add(f.name);
          }
        }
        if (f.relationshipName && f.referenceTo && f.referenceTo.length > 0) {
          // Map relationshipName and relationshipName__r to target for convenience
          relationships.set(f.relationshipName, f.referenceTo[0]);
          if (!f.relationshipName.endsWith('__r')) {
            relationships.set(`${f.relationshipName}__r`, f.referenceTo[0]);
          }
        }
      }
      for (const cr of d.childRelationships || []) {
        if (cr.relationshipName && cr.childSObject) {
          childRelationships.set(cr.relationshipName, cr.childSObject);
        }
      }
      index.objects[objectApiName] = { describe: d, fieldMap, readable, relationships, childRelationships };
    } catch (e) {
      // Ignore failures for now; caller can handle missing entries
      index.objects[objectApiName] = { describe: undefined, fieldMap: new Map(), readable: new Set(), relationships: new Map(), childRelationships: new Map() };
    }
  }
  return index;
}

// Collect neighbor API names (parents and children) for a described object
function listNeighborApis(index, objectApiName) {
  const neighbors = new Set();
  const obj = index.objects[objectApiName];
  if (!obj) return [];
  for (const [, parentApi] of obj.relationships || []) {
    if (parentApi) neighbors.add(parentApi);
  }
  for (const [, childApi] of obj.childRelationships || []) {
    if (childApi) neighbors.add(childApi);
  }
  return Array.from(neighbors);
}

// Expand an existing describe index by describing neighbor objects up to a given depth
export async function expandDescribeIndex(sf, index, startObject, maxDepth = 2, { orgId } = {}) {
  try {
    const visited = new Set([startObject]);
    let frontier = [startObject];
    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set();
      // Gather neighbors from current frontier
      for (const api of frontier) {
        const neighbors = listNeighborApis(index, api);
        for (const n of neighbors) if (!visited.has(n)) next.add(n);
      }
      const toDescribe = Array.from(next).filter(api => !index.objects[api]);
      if (toDescribe.length === 0) break;
      // Describe missing neighbors and merge into index
      const neighborIndex = await buildDescribeIndex(sf, toDescribe, { orgId });
      for (const [api, entry] of Object.entries(neighborIndex.objects)) {
        index.objects[api] = entry;
      }
      for (const api of next) visited.add(api);
      frontier = Array.from(next);
    }
  } catch {
    // best-effort expansion; ignore failures
  }
  return index;
}

// Build a lowercase object catalog from Describe global list
export async function buildObjectCatalog(sf) {
  try {
    const sobjs = await sf.listSObjects();
    const map = new Map();
    for (const s of sobjs) {
      const api = s.name;
      const keys = [s.name, s.label, s.labelPlural].filter(Boolean).map(x => String(x).toLowerCase());
      for (const k of keys) if (k) map.set(k, api);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function isFieldAllowed(index, objectApiName, fieldName) {
  const obj = index.objects[objectApiName];
  if (!obj) return false;
  if (fieldName.includes('.')) {
    // relationship.Name style: ensure relationship exists and the terminal field is Name
    const [rel, leaf] = fieldName.split('.');
    if (leaf !== 'Name') return false;
    return obj.relationships.has(rel) || obj.relationships.has(`${rel}__r`);
  }
  return obj.readable.has(fieldName) || fieldName === 'Id' || fieldName === 'Name';
}

export function filterAllowedFields(index, objectApiName, fields) {
  return fields.filter(f => isFieldAllowed(index, objectApiName, f));
}

export function chooseOrderBy(index, objectApiName) {
  const candidates = ['CreatedDate', 'LastModifiedDate', 'SystemModstamp'];
  for (const c of candidates) {
    if (isFieldAllowed(index, objectApiName, c)) return c;
  }
  return 'Id';
}

export function pickLookupNameFields(index, objectApiName, maxCount = 2) {
  const obj = index.objects[objectApiName];
  if (!obj?.describe?.fields) return [];
  const names = [];
  for (const f of obj.describe.fields) {
    if (f.relationshipName && (f.referenceTo?.length || 0) > 0) {
      const rel = `${f.relationshipName}__r.Name`;
      // Ensure this relationship is recognized in our relationships map when present
      if (!names.includes(rel)) names.push(rel);
      if (names.length >= maxCount) break;
    }
  }
  return names;
}

function getLookupFields(index, objectApiName) {
  const obj = index.objects[objectApiName];
  if (!obj?.describe?.fields) return [];
  return (obj.describe.fields || []).filter(f => !!f.relationshipName && (f.referenceTo?.length || 0) > 0);
}

export function findLookupNameFieldsByKeywords(index, objectApiName, keywords = [], maxCount = 2) {
  const lookups = getLookupFields(index, objectApiName);
  if (lookups.length === 0) return [];
  const scores = [];
  for (const f of lookups) {
    const hay = `${f.name} ${f.label} ${f.relationshipName} ${(f.referenceTo || []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (!kw) continue;
      const k = String(kw).toLowerCase();
      if (hay.includes(k)) score += 2;
      if (new RegExp(`\\b${k}\\b`).test(hay)) score += 3;
    }
    // Prefer shorter names and common Name field presence implicitly
    score += (f.referenceTo?.length || 0) > 0 ? 1 : 0;
    scores.push({ f, score });
  }
  scores.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const s of scores) {
    const rel = `${s.f.relationshipName}__r.Name`;
    if (!picked.includes(rel)) picked.push(rel);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

export function findLookupNameFieldsByTargets(index, objectApiName, targetObjects = [], maxCount = 2) {
  const lookups = getLookupFields(index, objectApiName);
  if (lookups.length === 0 || targetObjects.length === 0) return [];
  const targets = new Set(targetObjects);
  const picked = [];
  for (const f of lookups) {
    const ref = f.referenceTo || [];
    if (ref.some(t => targets.has(t))) {
      const rel = `${f.relationshipName}__r.Name`;
      if (!picked.includes(rel)) picked.push(rel);
      if (picked.length >= maxCount) break;
    }
  }
  return picked;
}

// Choose a lookup field on the given object to use for GROUP BY based on question keywords.
// Returns { groupField: 'Lookup__c', displayField: 'Lookup__r.Name' } or undefined when none found.
export function pickGroupByLookup(index, objectApiName, keywords = []) {
  const obj = index.objects[objectApiName];
  if (!obj?.describe?.fields) return undefined;
  const raw = (keywords || []).map(k => String(k || '').toLowerCase());
  const stop = new Set(['the','a','an','by','of','in','on','for','to','and','or','id','last','month','months','this','that','these','those','with','items','item','summarize','summary','count','total','avg','average','group']);
  const lowerKeywords = raw.filter(k => k && !stop.has(k));
  let best;
  let bestScore = -1;
  for (const f of obj.describe.fields) {
    if (!f.relationshipName || !(f.referenceTo?.length > 0)) continue;
    // Skip common administrative lookups unless explicitly requested
    if (/^(OwnerId|CreatedById|LastModifiedById|RecordTypeId)$/i.test(f.name)) continue;
    const targetApis = (f.referenceTo || []).map(t => String(t).toLowerCase());
    const hay = `${f.name} ${f.label} ${f.relationshipName} ${targetApis.join(' ')}`.toLowerCase();
    let score = 0;
    for (const kw of lowerKeywords) {
      if (!kw) continue;
      if (hay.includes(kw)) score += 3;
      if (new RegExp(`\\b${kw}\\b`).test(hay)) score += 4;
    }
    // Extra weight if any target API contains the keyword exactly
    for (const kw of lowerKeywords) {
      if (targetApis.some(t => t === kw)) score += 2;
    }
    // Prefer shorter API names slightly
    score += Math.max(0, 12 - String(f.name).length) * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  if (!best || bestScore <= 0) return undefined;
  const groupField = best.name; // e.g., Inventory_Location__c
  const rel = String(best.relationshipName || '');
  const displayField = rel.endsWith('__r') ? `${rel}.Name` : `${rel}.Name`;
  if (!isFieldAllowed(index, objectApiName, groupField)) return undefined;
  return { groupField, displayField };
}


