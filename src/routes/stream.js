import { Router } from 'express';
import { sseHeaders } from '../services/llm/openaiAdapter.js';

// Placeholder SSE route: echoes chunks from a dummy generator
const router = Router();

router.get('/stream', async (req, res) => {
  sseHeaders(res);
  const chunks = ['Starting...', 'Planning...', 'Querying...', 'Formatting...', 'Done'];
  for (const c of chunks) {
    res.write(`data: ${JSON.stringify({ type: 'status', message: c })}\n\n`);
    await new Promise(r => setTimeout(r, 200));
  }
  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
});

export default router;


