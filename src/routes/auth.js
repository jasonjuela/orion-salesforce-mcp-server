import { Router } from 'express';
import { oauthClient } from '../services/salesforceOAuth.js';
import { TokenStore } from '../config/tokenStore.js';
import { PkceStore } from '../config/pkceStore.js';
import crypto from 'crypto';
import axios from 'axios';

const router = Router();

router.get('/login', (req, res) => {
  const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REDIRECT_URI } = process.env;
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET || !SF_REDIRECT_URI) return res.status(500).json({ error: 'oauth_not_configured' });
  const client = oauthClient({ clientId: SF_CLIENT_ID, clientSecret: SF_CLIENT_SECRET, redirectUri: SF_REDIRECT_URI });
  const state = String(req.query.state || crypto.randomUUID());
  const sessionId = String(req.query.sessionId || 'dev');
  const orgId = String(req.query.orgId || 'default');
  // Generate PKCE verifier and store by state alongside session identifiers
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  PkceStore.put(state, { codeVerifier, sessionId, orgId });
  const url = client.authUrl({ state, codeChallenge, scope: 'api refresh_token offline_access' });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'missing_code' });

    const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REDIRECT_URI } = process.env;
    const client = oauthClient({ clientId: SF_CLIENT_ID, clientSecret: SF_CLIENT_SECRET, redirectUri: SF_REDIRECT_URI });
    const state = String(req.query.state || '');
    const pkce = PkceStore.take(state);
    const token = await client.exchangeCode(code, pkce?.codeVerifier);
    const sid = pkce?.sessionId || 'dev';
    const oid = pkce?.orgId || 'default';
    TokenStore.put(sid, oid, token);
    res.json({ ok: true, sessionId: sid, orgId: oid, instanceUrl: token.instanceUrl });
  } catch (err) {
    res.status(500).json({ error: 'oauth_exchange_failed', message: err?.message });
  }
});

// Optional logout: revoke token in Salesforce (if possible) and remove from store
router.post('/logout', async (req, res) => {
  try {
    const { sessionId = 'dev', orgId = 'default', revoke = true } = req.body || {};
    const token = TokenStore.get(sessionId, orgId);
    if (!token) return res.json({ ok: true });
    if (revoke && token.accessToken) {
      try {
        const base = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com');
        const toRevoke = token.refreshToken || token.accessToken;
        const form = new URLSearchParams({ token: toRevoke });
        await axios.post(`${base}/services/oauth2/revoke`, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      } catch {}
    }
    TokenStore.remove(sessionId, orgId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'logout_failed', message: err?.message });
  }
});

// Check auth status for a session/org
router.get('/status', (req, res) => {
  const sessionId = String(req.query.sessionId || 'dev');
  const orgId = String(req.query.orgId || 'default');
  const token = TokenStore.get(sessionId, orgId);
  if (!token) return res.json({ authenticated: false });
  res.json({ authenticated: true, instanceUrl: token.instanceUrl, hasRefresh: Boolean(token.refreshToken), issuedAt: token.issuedAt });
});

export default router;


