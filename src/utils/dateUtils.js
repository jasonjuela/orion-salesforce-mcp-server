// Minimal date range heuristics respecting org defaults

function hasWord(text, word) {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

export function resolveDateRange(question, orgProfile, session) {
  const q = (question || '').toLowerCase();
  // Simple heuristics
  if (hasWord(q, 'today')) return 'TODAY';
  if (hasWord(q, 'yesterday')) return 'YESTERDAY';
  if (/last\s+year/i.test(q)) return 'LAST_N_MONTHS:12';
  if (/this\s+year/i.test(q)) return 'THIS_YEAR';
  if (/last\s+month/i.test(q)) return 'LAST_MONTH';
  if (/this\s+month/i.test(q)) return 'THIS_MONTH';
  if (/last\s+\d+\s+months/i.test(q)) {
    const m = q.match(/last\s+(\d+)\s+months/i);
    const n = Number(m?.[1] || 6);
    return `LAST_N_MONTHS:${Math.min(Math.max(n,1), 24)}`;
  }
  if (/last\s+week/i.test(q)) return 'LAST_WEEK';
  if (/this\s+week/i.test(q)) return 'THIS_WEEK';
  if (/last\s+\d+\s+weeks/i.test(q)) {
    const m = q.match(/last\s+(\d+)\s+weeks/i);
    const n = Number(m?.[1] || 4);
    return `LAST_N_WEEKS:${Math.min(Math.max(n,1), 52)}`;
  }
  // Fallback to org default
  const def = orgProfile?.guardrails?.defaultDateRange || 'LAST_N_MONTHS:12';
  return normalizeDateMacro(def);
}

export function needsDateClarification(question) {
  const q = (question || '').toLowerCase();
  
  // Only ask for date clarification if the query mentions time-related terms
  // but doesn't specify a clear date range
  const hasTimeContext = /\b(created|modified|updated|added|deleted|changed|since|from|during|in|within)\b/i.test(q) ||
                         /\b(year|month|week|day|time|date|recent|new|old|latest|past)\b/i.test(q) ||
                         /\b(last|this|next|current|previous)\b/i.test(q);
  
  if (!hasTimeContext) {
    return false; // No time context, no need for date clarification
  }
  
  // Has time context but no specific date range
  const hasSpecificDate = /today|yesterday|last\s+\d+\s+months|last\s+\d+\s+weeks|last\s+month|last\s+week|this\s+month|this\s+week|last\s+year|this\s+year/i.test(q);
  
  return !hasSpecificDate;
}

// Convert older macros like LAST_12_MONTHS to LAST_N_MONTHS:12, etc.
export function normalizeDateMacro(macro) {
  if (!macro) return 'LAST_N_MONTHS:12';
  if (/^LAST_N_MONTHS:\d+$/i.test(macro)) return macro;
  if (/^LAST_N_WEEKS:\d+$/i.test(macro)) return macro;
  const mMonths = macro.match(/^LAST_(\d+)_MONTHS$/i);
  if (mMonths) return `LAST_N_MONTHS:${mMonths[1]}`;
  const mWeeks = macro.match(/^LAST_(\d+)_WEEKS$/i);
  if (mWeeks) return `LAST_N_WEEKS:${mWeeks[1]}`;
  return macro;
}


