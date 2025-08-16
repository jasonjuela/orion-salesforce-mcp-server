export const shouldRetrySalesforce = (err) => {
  const sc = err?.statusCode || err?.response?.status;
  return sc === 429 || (sc >= 500 && sc < 600) || ['ETIMEDOUT', 'ECONNRESET'].includes(err?.code);
};

export const shouldRetryLLM = (err) => {
  const sc = err?.statusCode || err?.response?.status;
  return sc === 429 || (sc >= 500 && sc < 600) || ['ETIMEDOUT', 'ECONNRESET'].includes(err?.code);
};


