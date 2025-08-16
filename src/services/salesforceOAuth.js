import axios from 'axios';

function issuerFor() {
  return process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
}

export function oauthClient({ clientId, clientSecret, redirectUri }) {
  const client = {
    authUrl({ state, codeChallenge, scope }) {
      const base = issuerFor();
      const qp = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: state || '',
        scope: scope || 'api refresh_token offline_access'
      }).toString();
      const cc = codeChallenge ? `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256` : '';
      return `${base}/services/oauth2/authorize?${qp}${cc}`;
    },

    async exchangeCode(code, codeVerifier) {
      const base = issuerFor();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      });
      if (codeVerifier) form.append('code_verifier', codeVerifier);
      const { data } = await axios.post(`${base}/services/oauth2/token`, form);
      // Response contains access_token, instance_url, refresh_token?, id, etc.
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        instanceUrl: data.instance_url,
        issuedAt: Number(data.issued_at) || Date.now()
      };
    },

    async refreshToken(refreshToken) {
      const base = issuerFor();
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      });
      const { data } = await axios.post(`${base}/services/oauth2/token`, form);
      return {
        accessToken: data.access_token,
        instanceUrl: data.instance_url,
        issuedAt: Number(data.issued_at) || Date.now()
      };
    }
  };
  return client;
}


