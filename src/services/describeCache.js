// In-memory Describe cache per org with TTL

const orgToObjectDescribe = new Map(); // orgId -> Map(object -> { value, expiresAt })
const DEFAULT_TTL_MS = Number(process.env.DESCRIBE_TTL_MS || 10 * 60 * 1000);

export const DescribeCache = {
  get(orgId, objectApiName) {
    const m = orgToObjectDescribe.get(orgId);
    const entry = m?.get(objectApiName);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      m.delete(objectApiName);
      return undefined;
    }
    return entry.value;
  },
  set(orgId, objectApiName, describe, ttlMs = DEFAULT_TTL_MS) {
    let m = orgToObjectDescribe.get(orgId);
    if (!m) { m = new Map(); orgToObjectDescribe.set(orgId, m); }
    m.set(objectApiName, { value: describe, expiresAt: Date.now() + ttlMs });
  }
};



