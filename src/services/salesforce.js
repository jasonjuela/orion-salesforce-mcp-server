import axios from 'axios';
import { withRetry } from '../utils/withRetry.js';
import { shouldRetrySalesforce } from '../utils/retryPolicies.js';
import { logger } from '../utils/logger.js';
import { oauthClient } from './salesforceOAuth.js';
import { TokenStore } from '../config/tokenStore.js';

export function sfClient({ instanceUrl, accessToken, refreshToken, sessionId, orgId }) {
  const api = axios.create({
    baseURL: `${instanceUrl}/services/data/v61.0/`,
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // Auto-refresh on 401 if we have refresh context
  api.interceptors.response.use(r => r, async (error) => {
    try {
      const status = error?.response?.status;
      if (status !== 401 || !sessionId || !orgId) return Promise.reject(error);
      const current = TokenStore.get(sessionId, orgId);
      const rt = current?.refreshToken || refreshToken;
      if (!rt) return Promise.reject(error);
      const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REDIRECT_URI } = process.env;
      if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) return Promise.reject(error);
      const oc = oauthClient({ clientId: SF_CLIENT_ID, clientSecret: SF_CLIENT_SECRET, redirectUri: SF_REDIRECT_URI });
      const refreshed = await oc.refreshToken(rt);
      const newCtx = {
        ...(current || {}),
        accessToken: refreshed.accessToken,
        instanceUrl: refreshed.instanceUrl || current?.instanceUrl || instanceUrl,
        issuedAt: refreshed.issuedAt,
        refreshToken: rt
      };
      TokenStore.put(sessionId, orgId, newCtx);
      // Update axios defaults and retry the failed request once
      api.defaults.baseURL = `${newCtx.instanceUrl}/services/data/v61.0/`;
      api.defaults.headers.Authorization = `Bearer ${newCtx.accessToken}`;
      const cfg = error.config || {};
      cfg.headers = { ...(cfg.headers || {}), Authorization: `Bearer ${newCtx.accessToken}` };
      return api.request(cfg);
    } catch (e) {
      return Promise.reject(error);
    }
  });

  return {
    async query(soql) {
      return withRetry(() => api.get('query', { params: { q: soql } }).then(r => r.data), {
        retries: 4,
        delayMs: 800,
        shouldRetry: shouldRetrySalesforce,
        onAttempt: info => logger.info({ svc: 'salesforce', soql, ...info }, 'SOQL attempt')
      });
    },

    async queryAll(soql, { maxRows = 50000 } = {}) {
      const rows = [];
      let url = 'query';
      let params = { q: soql };
      while (true) {
        const data = await withRetry(() => api.get(url, { params }).then(r => r.data), {
          retries: 4,
          delayMs: 800,
          shouldRetry: shouldRetrySalesforce,
          onAttempt: info => logger.info({ svc: 'salesforce', soql: url === 'query' ? soql : undefined, ...info }, 'SOQL page')
        });
        for (const rec of data.records || []) {
          rows.push(rec);
          if (rows.length >= maxRows) return rows;
        }
        if (!data.done && data.nextRecordsUrl) {
          url = data.nextRecordsUrl.replace(/^.*\/services\/data\/v\d+\.\d+\//, '');
          params = undefined;
          continue;
        }
        break;
      }
      return rows;
    },

    async describeSObject(objectApiName) {
      return withRetry(() => api.get(`sobjects/${objectApiName}/describe`).then(r => r.data), {
        retries: 3,
        delayMs: 800,
        shouldRetry: shouldRetrySalesforce,
        onAttempt: info => logger.info({ svc: 'salesforce', objectApiName, ...info }, 'Describe attempt')
      });
    },

    async orgLimits() {
      return api.get('limits').then(r => r.data);
    },

    async listSObjects() {
      const data = await api.get('sobjects').then(r => r.data);
      return data?.sobjects || [];
    },

    async search(sosl) {
      return withRetry(() => api.get('search', { params: { q: sosl } }).then(r => r.data), {
        retries: 4,
        delayMs: 800,
        shouldRetry: shouldRetrySalesforce,
        onAttempt: info => logger.info({ svc: 'salesforce', sosl, ...info }, 'SOSL attempt')
      });
    }
  };
}


