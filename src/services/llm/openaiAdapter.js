import axios from 'axios';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export async function chatComplete({ model = 'gpt-4o', messages, stream = true, temperature = 0.2, max_tokens = 1200 }) {
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

  // Non-streaming for scaffold; swap to SSE for production
  const { data } = await axios.post(OPENAI_URL, { model, messages, temperature, max_tokens, stream: false }, { headers });
  return data;
}

export function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    try { res.flushHeaders(); } catch {}
  }
}

// Stream tokens from OpenAI Chat Completions and forward via callback
export async function chatCompleteStream({ model = 'gpt-4o', messages, temperature = 0.2, max_tokens = 1200, onDelta, onDone }) {
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json'
  };
  const resp = await axios.post(OPENAI_URL, { model, messages, temperature, max_tokens, stream: true }, {
    headers,
    responseType: 'stream'
  });

  return new Promise((resolve, reject) => {
    let buffer = '';
    const stream = resp.data;
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.replace(/^data:\s*/, '');
        if (payload === '[DONE]') {
          try { onDone && onDone(); } catch {}
          continue;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            try { onDelta && onDelta(delta); } catch {}
          }
        } catch {
          // ignore parse errors for keepalives or non-json lines
        }
      }
    });
    stream.on('end', () => { try { onDone && onDone(); } catch {} finally { resolve(); } });
    stream.on('error', (err) => { try { onDone && onDone(); } catch {} finally { reject(err); } });
  });
}



