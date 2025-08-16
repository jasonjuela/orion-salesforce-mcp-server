export async function withRetry(taskFn, {
  retries = 3,
  delayMs = 1000,
  backoffFactor = 2,
  jitter = true,
  shouldRetry = () => true,
  onAttempt = () => {}
} = {}) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    try {
      onAttempt({ attempt });
      return await taskFn();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !shouldRetry(err)) throw err;

      const backoff = delayMs * Math.pow(backoffFactor, attempt);
      const wait = jitter ? backoff + Math.floor(Math.random() * 200) : backoff;
      onAttempt({ attempt: attempt + 1, wait, error: serializeErr(err) });
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }

  throw lastError;
}

function serializeErr(e) {
  return {
    name: e?.name,
    message: e?.message,
    statusCode: e?.statusCode || e?.response?.status,
    code: e?.code
  };
}


