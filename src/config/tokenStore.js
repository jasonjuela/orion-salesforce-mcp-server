// Token store with disk persistence and optional encryption.
// - Keys: sessionId → orgId → tokenContext
// - Persists to `data/secrets/tokens.json`

import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';

const memory = new Map();
const storeFile = path.resolve(process.cwd(), 'data', 'secrets', 'tokens.json');

function mapToPlainObject() {
  const out = {};
  for (const [sessionId, orgMap] of memory.entries()) {
    out[sessionId] = {};
    for (const [orgId, token] of orgMap.entries()) {
      out[sessionId][orgId] = token;
    }
  }
  return out;
}

function plainObjectToMap(obj) {
  memory.clear();
  if (!obj || typeof obj !== 'object') return;
  for (const sessionId of Object.keys(obj)) {
    const byOrg = new Map();
    for (const orgId of Object.keys(obj[sessionId] || {})) {
      byOrg.set(orgId, obj[sessionId][orgId]);
    }
    memory.set(sessionId, byOrg);
  }
}

function getKeyFromEnv() {
  const secret = process.env.TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!secret) return undefined;
  // Derive 32-byte key from provided secret deterministically
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptIfPossible(plaintext) {
  const key = getKeyFromEnv();
  if (!key) return { plaintext }; // no encryption
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  };
}

function decryptIfNeeded(objOrPlain) {
  if (!objOrPlain) return undefined;
  if (objOrPlain.plaintext) return objOrPlain.plaintext; // not expected on disk, but handle
  if (!objOrPlain.enc) {
    // Assume this is a plain JSON object already parsed
    return objOrPlain;
  }
  if (objOrPlain.enc !== 'aes-256-gcm') return undefined;
  const key = getKeyFromEnv();
  if (!key) return undefined; // cannot decrypt
  const iv = Buffer.from(objOrPlain.iv, 'base64');
  const tag = Buffer.from(objOrPlain.tag, 'base64');
  const data = Buffer.from(objOrPlain.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  const text = dec.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function persistToDisk() {
  const dir = path.dirname(storeFile);
  await ensureDir(dir);
  const plain = mapToPlainObject();
  const dataStr = JSON.stringify(plain);
  const encObj = encryptIfPossible(dataStr);
  // If encrypted, write the envelope; else write plain JSON
  const content = encObj.enc ? encObj : plain;
  const tmp = `${storeFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(content, null, 2), 'utf8');
  await fs.rename(tmp, storeFile);
}

async function loadFromDisk() {
  try {
    const buf = await fs.readFile(storeFile, 'utf8');
    const obj = JSON.parse(buf);
    // If file is encrypted envelope
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'enc')) {
      const decrypted = decryptIfNeeded(obj);
      if (decrypted && typeof decrypted === 'object' && !Object.prototype.hasOwnProperty.call(decrypted, 'enc')) {
        plainObjectToMap(decrypted);
      }
      return; // either loaded or unable to decrypt → skip
    }
    // Otherwise, treat as plain JSON map
    if (obj && typeof obj === 'object') {
      plainObjectToMap(obj);
    }
  } catch (e) {
    if (e.code === 'ENOENT') return; // nothing to load
    // Corrupt or unreadable file → ignore for now
  }
}

export const TokenStore = {
  async init() {
    await loadFromDisk();
  },
  put(sessionId, orgId, tokenContext) {
    if (!sessionId || !orgId || !tokenContext) return;
    const byOrg = memory.get(sessionId) || new Map();
    byOrg.set(orgId, tokenContext);
    memory.set(sessionId, byOrg);
    // Fire and forget; persistence best-effort
    persistToDisk().catch(() => {});
  },
  get(sessionId, orgId) {
    const byOrg = memory.get(sessionId);
    if (!byOrg) return undefined;
    return byOrg.get(orgId);
  },
  getAny(sessionId) {
    const byOrg = memory.get(sessionId);
    if (!byOrg) return undefined;
    for (const value of byOrg.values()) return value;
    return undefined;
  },
  remove(sessionId, orgId) {
    const byOrg = memory.get(sessionId);
    if (!byOrg) return;
    byOrg.delete(orgId);
    if (byOrg.size === 0) memory.delete(sessionId);
    persistToDisk().catch(() => {});
  }
};


