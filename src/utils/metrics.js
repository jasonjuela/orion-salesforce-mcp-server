const counters = new Map();

export function inc(metric, value = 1, labels = {}) {
  const key = metric + JSON.stringify(labels);
  counters.set(key, (counters.get(key) || 0) + value);
}

export function timing(metric, ms, labels = {}) {
  const key = metric + JSON.stringify(labels);
  const prev = counters.get(key) || 0;
  counters.set(key, prev + ms);
}

export function snapshot() {
  const out = {};
  for (const [k, v] of counters) out[k] = v;
  return out;
}


