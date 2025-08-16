// Helpers to build clarification prompts and suggested options

export function buildObjectClarification(entities, catalog) {
  const uniq = Array.from(new Set(entities || []));
  const options = uniq.map(api => ({ value: api, label: api }));
  return {
    type: 'clarify',
    field: 'object',
    question: 'Which Salesforce object should I use?',
    options
  };
}

export function buildDateClarification(orgProfile) {
  const def = orgProfile?.guardrails?.defaultDateRange || 'LAST_N_MONTHS:12';
  const options = [
    { value: 'LAST_N_DAYS:30', label: 'Last 30 days' },
    { value: 'LAST_N_DAYS:90', label: 'Last 90 days' },
    { value: 'LAST_N_MONTHS:12', label: 'Last 12 months' },
    { value: def, label: `Default (${def})` }
  ];
  return {
    type: 'clarify',
    field: 'dateRange',
    question: 'Which date range should I use for CreatedDate?',
    options
  };
}


