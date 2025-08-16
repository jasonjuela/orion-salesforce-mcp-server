import { Router } from 'express';
import path from 'path';
import { readJson, writeJson } from '../utils/fileStore.js';

const router = Router();
const baseDir = path.resolve(process.cwd(), 'data', 'prompts');
const fileFor = (name) => path.join(baseDir, `${name}.json`);

router.get('/prompts', async (req, res) => {
  // Minimal listing (no fs.readdir to keep simple in MVP)
  res.json({ available: ['v1.0.0'] });
});

router.get('/prompts/:name', async (req, res) => {
  const cfg = await readJson(fileFor(req.params.name));
  if (!cfg) return res.status(404).json({ error: 'not_found' });
  res.json(cfg);
});

router.put('/prompts/:name', async (req, res) => {
  await writeJson(fileFor(req.params.name), req.body);
  res.json({ ok: true });
});

export default router;


