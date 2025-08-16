const mem = new Map(); // id -> { data, expiresAt }
const TTL_MS = Number(process.env.SESSION_TTL_MS || 45 * 60 * 1000);

export const SessionStore = {
  get(id) {
    const entry = mem.get(id);
    if (!entry || Date.now() > entry.expiresAt) {
      mem.delete(id);
      return { 
        objectAliases: {}, 
        defaults: {},
        clarifications: {},
        queryHistory: [],
        objectPreferences: {}
      };
    }
    return entry.data;
  },
  set(id, data) {
    mem.set(id, { data, expiresAt: Date.now() + TTL_MS });
  },
  merge(id, patch) {
    const current = SessionStore.get(id);
    SessionStore.set(id, { ...current, ...patch });
  },
  
  // Add clarification answer
  addClarification(sessionId, question, answer) {
    const session = this.get(sessionId);
    if (!session.clarifications) session.clarifications = {};
    session.clarifications[question] = {
      answer,
      timestamp: Date.now(),
      count: (session.clarifications[question]?.count || 0) + 1
    };
    this.set(sessionId, session);
  },
  
  // Get clarification if exists
  getClarification(sessionId, question) {
    const session = this.get(sessionId);
    return session.clarifications?.[question];
  },
  
  // Track object usage for preference learning
  trackObjectUsage(sessionId, question, objectApiName, success = true) {
    const session = this.get(sessionId);
    if (!session.queryHistory) session.queryHistory = [];
    if (!session.objectPreferences) session.objectPreferences = {};
    
    // Add to history
    session.queryHistory.unshift({
      question,
      object: objectApiName,
      timestamp: Date.now(),
      success
    });
    
    // Keep only last 50 queries
    if (session.queryHistory.length > 50) {
      session.queryHistory = session.queryHistory.slice(0, 50);
    }
    
    // Update preferences
    if (!session.objectPreferences[objectApiName]) {
      session.objectPreferences[objectApiName] = { count: 0, successRate: 0 };
    }
    const pref = session.objectPreferences[objectApiName];
    pref.count++;
    pref.successRate = ((pref.successRate * (pref.count - 1)) + (success ? 1 : 0)) / pref.count;
    pref.lastUsed = Date.now();
    
    this.set(sessionId, session);
  },
  
  // Get object preferences for ranking
  getObjectPreferences(sessionId) {
    const session = this.get(sessionId);
    return session.objectPreferences || {};
  }
};


