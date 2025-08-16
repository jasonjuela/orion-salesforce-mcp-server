// Very simple in-memory PKCE store keyed by state
// In production, replace with a secure short-lived store (e.g., Redis)

const stateToEntry = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export const PkceStore = {
  put(state, entry) {
    if (!state || !entry?.codeVerifier) return;
    stateToEntry.set(state, { ...entry, expiresAt: Date.now() + TTL_MS });
  },
  take(state) {
    const entry = stateToEntry.get(state);
    if (!entry) return undefined;
    stateToEntry.delete(state);
    if (Date.now() > entry.expiresAt) return undefined;
    const { codeVerifier, sessionId, orgId } = entry;
    return { codeVerifier, sessionId, orgId };
  }
};


