import { Router } from 'express';
import { sfClient } from '../services/salesforce.js';
import { TokenStore } from '../config/tokenStore.js';
import { v4 as uuidv4 } from 'uuid';
import ExcelJS from 'exceljs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { writeBuffer, writeJson, readJson, statOrUndefined } from '../utils/fileStore.js';

const router = Router();

// In-memory job store for MVP
const jobs = new Map(); // exportId -> metadata; files persisted to disk under data/exports
const baseDir = path.resolve(process.cwd(), 'data', 'exports');
const jobMetaFile = (id) => path.join(baseDir, `${id}.json`);
const jobCsvFile = (id) => path.join(baseDir, `${id}.csv`);
const jobXlsxFile = (id) => path.join(baseDir, `${id}.xlsx`);
const jobGzFile = (id) => path.join(baseDir, `${id}.csv.gz`);

router.post('/export', async (req, res) => {
  try {
    const { org_id, sessionId = 'dev', soql, maxRows = 50000, format = 'csv' } = req.body || {};
    // Throttle: 1 job per user/min (naive)
    const key = `${sessionId}:${org_id}`;
    const now = Date.now();
    if (!router._lastJobAt) router._lastJobAt = new Map();
    const last = router._lastJobAt.get(key) || 0;
    if (now - last < 60_000) return res.status(429).json({ error: 'rate_limited' });
    router._lastJobAt.set(key, now);
    if (!org_id || !soql) return res.status(400).json({ error: 'org_id and soql required' });
    const tokenCtx = TokenStore.get(sessionId, org_id) || { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) return res.status(401).json({ error: 'missing_salesforce_token' });
    const sf = sfClient({ ...tokenCtx, sessionId, orgId: org_id });

    const exportId = uuidv4();
    const meta = { status: 'running', size: 0, soql, org_id, sessionId, format, startedAt: Date.now() };
    jobs.set(exportId, meta);
    await writeJson(jobMetaFile(exportId), meta);

    // Fire and forget (simple async) — for MVP, no worker
    (async () => {
      try {
        const rows = await sf.queryAll(soql, { maxRows });
        if (format === 'xlsx') {
          const wb = new ExcelJS.Workbook();
          const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
          const maxRowsPerSheet = 100_000;
          let sheetIndex = 1;
          let ws = wb.addWorksheet(`Export-${sheetIndex}`);
          if (headers.length) ws.addRow(headers);
          let rowCount = 0;
          for (const r of rows) {
            if (rowCount >= maxRowsPerSheet) {
              sheetIndex += 1;
              ws = wb.addWorksheet(`Export-${sheetIndex}`);
              if (headers.length) ws.addRow(headers);
              rowCount = 0;
            }
            ws.addRow(headers.map(h => r[h]));
            rowCount += 1;
          }
          const buf = await wb.xlsx.writeBuffer();
          await writeBuffer(jobXlsxFile(exportId), Buffer.from(buf));
          const done = { status: 'complete', size: buf.byteLength, soql, org_id, sessionId, format, filename: `export-${exportId}.xlsx`, path: jobXlsxFile(exportId), expiresAt: Date.now() + 15 * 60 * 1000 };
          jobs.set(exportId, done);
          await writeJson(jobMetaFile(exportId), done);
        } else {
          const csv = rowsToCsv(rows);
          const body = Buffer.from(csv, 'utf8');
          // gzip if >5MB
          if (body.length > 5 * 1024 * 1024) {
            const gz = zlib.gzipSync(body);
            await writeBuffer(jobGzFile(exportId), gz);
            const done = { status: 'complete', size: gz.length, soql, org_id, sessionId, format: 'csv.gz', filename: `export-${exportId}.csv.gz`, path: jobGzFile(exportId), expiresAt: Date.now() + 15 * 60 * 1000 };
            jobs.set(exportId, done);
            await writeJson(jobMetaFile(exportId), done);
          } else {
            await writeBuffer(jobCsvFile(exportId), body);
            const done = { status: 'complete', size: body.length, soql, org_id, sessionId, format: 'csv', filename: `export-${exportId}.csv`, path: jobCsvFile(exportId), expiresAt: Date.now() + 15 * 60 * 1000 };
            jobs.set(exportId, done);
            await writeJson(jobMetaFile(exportId), done);
          }
        }
      } catch (e) {
        const failed = { status: 'failed', error: e?.message, soql, org_id, sessionId, format };
        jobs.set(exportId, failed);
        await writeJson(jobMetaFile(exportId), failed);
      }
    })();

    res.json({ exportId });
  } catch (err) {
    res.status(500).json({ error: 'export_failed', message: err?.message });
  }
});

router.get('/export/:exportId/status', async (req, res) => {
  const id = req.params.exportId;
  let j = jobs.get(id);
  if (!j) j = await readJson(jobMetaFile(id));
  if (!j) return res.status(404).json({ error: 'not_found' });
  const { status, size, soql, org_id, sessionId, expiresAt, format } = j;
  const token = status === 'complete' ? signUrl(`/export/${id}/download`) : undefined;
  res.json({ status, size, soql, org_id, sessionId, format, expiresAt, downloadUrl: token });
});

router.get('/export/:exportId/download', async (req, res) => {
  const id = req.params.exportId;
  if (!verifyUrl(req)) return res.status(403).json({ error: 'forbidden' });
  let j = jobs.get(id);
  if (!j) j = await readJson(jobMetaFile(id));
  if (!j || j.status !== 'complete' || !j.path) return res.status(404).json({ error: 'not_ready' });
  const exists = await statOrUndefined(j.path);
  if (!exists) return res.status(404).json({ error: 'expired' });
  const ct = j.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : (j.format === 'csv.gz' ? 'application/gzip' : 'text/csv');
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', `attachment; filename=${j.filename || 'export.' + (j.format || 'csv')}`);
  res.sendFile(j.path);
});

function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Object.keys(rows[0] || {});
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

function signUrl(pathname) {
  const secret = process.env.DOWNLOAD_SIGNING_SECRET || 'dev_secret';
  const expires = Date.now() + 5 * 60 * 1000; // 5 min
  const h = crypto.createHmac('sha256', secret).update(pathname + '|' + expires).digest('hex');
  const u = new URL('http://localhost');
  u.pathname = pathname;
  u.searchParams.set('e', String(expires));
  u.searchParams.set('s', h);
  return u.pathname + u.search;
}

function verifyUrl(req) {
  try {
    const secret = process.env.DOWNLOAD_SIGNING_SECRET || 'dev_secret';
    const e = Number(req.query.e);
    const s = String(req.query.s || '');
    if (!e || !s || Date.now() > e) return false;
    const pathname = req.path;
    const h = crypto.createHmac('sha256', secret).update(pathname + '|' + e).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(s, 'hex'));
  } catch {
    return false;
  }
}

export default router;


