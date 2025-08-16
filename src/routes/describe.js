import { Router } from 'express';
import { TokenStore } from '../config/tokenStore.js';
import { sfClient } from '../services/salesforce.js';

const router = Router();

router.get('/describe/:object', async (req, res) => {
  try {
    const objectApiName = req.params.object;
    const { org_id = 'default', sessionId = 'dev' } = req.query || {};
    const tokenCtx = TokenStore.get(sessionId, org_id) || { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) return res.status(401).json({ error: 'missing_salesforce_token' });
    const sf = sfClient(tokenCtx);
    const d = await sf.describeSObject(objectApiName);

    const fields = (d.fields || []).map(f => ({ name: f.name, label: f.label, type: f.type, relationshipName: f.relationshipName, referenceTo: f.referenceTo }));
    const relationships = fields
      .filter(f => f.relationshipName && (f.referenceTo?.length || 0) > 0)
      .map(f => ({ relationshipName: f.relationshipName, target: f.referenceTo[0], namePath: `${f.relationshipName}__r.Name` }));

    res.json({ object: objectApiName, nameField: d.nameField, fields, relationships });
  } catch (err) {
    res.status(500).json({ error: 'describe_failed', message: err?.message });
  }
});

router.get('/sobjects', async (req, res) => {
  try {
    const { org_id = 'default', sessionId = 'dev' } = req.query || {};
    const tokenCtx = TokenStore.get(sessionId, org_id) || { instanceUrl: process.env.SF_INSTANCE_URL, accessToken: process.env.SF_ACCESS_TOKEN };
    if (!tokenCtx?.instanceUrl || !tokenCtx?.accessToken) return res.status(401).json({ error: 'missing_salesforce_token' });
    const sf = sfClient(tokenCtx);
    const list = await sf.listSObjects();
    const compact = list.map(s => ({ name: s.name, label: s.label, labelPlural: s.labelPlural, custom: s.custom }));
    res.json({ sobjects: compact });
  } catch (err) {
    res.status(500).json({ error: 'sobjects_failed', message: err?.message });
  }
});

export default router;


