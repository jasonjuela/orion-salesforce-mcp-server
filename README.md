# Salesforce MCP Server (Scaffold)

## Quick Start

1. Copy env template and fill values
```bash
cp .env.example .env
```
- Set `OPENAI_API_KEY`.
- For dev, you may also set `SF_INSTANCE_URL` and `SF_ACCESS_TOKEN` to bypass OAuth.

2. Install deps and run
```bash
npm install
npm run dev
```

3. Call the API
- POST `http://localhost:3000/generate`
- Body example:
```json
{ "user_question": "From owsc__Item_Lot__c show item and location names last month", "org_id": "00Dxxx", "sessionId": "demo" }
```

Notes
- OAuth routes are placeholders — wire Salesforce login + token storage.
- OpenAI is called non‑streaming in this scaffold; switch to SSE for production.
- Planner/Describe logic is simplified — replace with org-aware Describe + whitelists.
- JSON Schema validation included for `table` outputs.
- Retry/backoff utilities included and used across services.
