import { promises as fs } from 'fs';
import path from 'path';

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

export async function writeBuffer(filePath, buffer) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, buffer);
}

export async function statOrUndefined(filePath) {
  try { return await fs.stat(filePath); } catch { return undefined; }
}


