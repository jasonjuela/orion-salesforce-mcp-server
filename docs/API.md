# Orion Salesforce MCP Server API Documentation

## Overview

The Orion Salesforce MCP Server provides intelligent Salesforce data interaction through natural language queries. This API enables AI assistants to query Salesforce data using SOQL/SOSL with automatic object and field resolution.

**Base URL**: `http://localhost:3018`  
**API Version**: `v1`  
**Content-Type**: `application/json`

## Core Endpoints

### 1. Generate Stream Query
**Primary endpoint for natural language Salesforce queries with streaming responses**

```http
POST /generate/stream
```

#### Request Body
```json
{
  "user_question": "string",     // Required: Natural language query
  "orgId": "string",             // Required: Organization identifier (default: "default")
  "sessionId": "string"          // Required: Session identifier for tracking
}
```

#### Response
- **Content-Type**: `text/plain` (Server-Sent Events)
- **Status**: `200 OK` for successful stream start

#### Response Events
```
PLAN: {"object":"owsc__Item__c","soql":"SELECT...","fields":["Id","Name"],"where":"..."}

DATA ROWS: 42

Based on the data retrieved from Salesforce...
[DONE]
```

#### Example Request
```javascript
const response = await fetch('http://localhost:3018/generate/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_question: "What is the alcohol percentage of Cockburn's wines?",
    orgId: "default",
    sessionId: "demo-session-001"
  })
});
```

#### Response Flow
1. **PLAN**: JSON object with query plan (SOQL/SOSL, fields, filters)
2. **DATA ROWS**: Number of records retrieved
3. **Response**: LLM-generated answer based on retrieved data
4. **[DONE]**: Stream completion marker

---

### 2. Cross-Object Search
**Direct SOSL search across multiple Salesforce objects**

```http
POST /search/cross-object
```

#### Request Body
```json
{
  "searchTerms": ["string"],     // Required: Array of search terms
  "targetObjects": ["string"],   // Optional: Specific objects to search
  "orgId": "string",            // Required: Organization identifier
  "limit": 200                  // Optional: Result limit (default: 200)
}
```

#### Response
```json
{
  "success": true,
  "data": {
    "searchRecords": [
      {
        "attributes": {
          "type": "owsc__Item__c",
          "url": "/services/data/v52.0/sobjects/owsc__Item__c/a041N00001LHpOFQA1"
        },
        "Id": "a041N00001LHpOFQA1",
        "Name": "COCKBURN'S FINE RUBY"
      }
    ]
  },
  "totalRecords": 42
}
```

---

### 3. Search Capabilities
**Check available search and DML capabilities for the organization**

```http
GET /search/capabilities?orgId={orgId}
```

#### Response
```json
{
  "orgId": "default",
  "capabilities": {
    "read": true,
    "dml": {
      "enabled": false,
      "insert": false,
      "update": false,
      "upsert": false,
      "delete": false,
      "undelete": false,
      "merge": false
    }
  },
  "features": {
    "sosl": true,
    "soql": true,
    "crossObjectSearch": true,
    "intelligentFieldResolution": true,
    "naturalLanguageProcessing": true
  }
}
```

---

### 4. Authentication Endpoints
**Salesforce OAuth flow (placeholder implementation)**

```http
GET /auth/login?orgId={orgId}
```
Redirects to Salesforce OAuth login

```http
GET /auth/callback
```
Handles OAuth callback and token storage

---

## Request/Response Schemas

### Query Plan Schema
```json
{
  "type": "object",
  "properties": {
    "object": { "type": "string", "description": "Target Salesforce object API name" },
    "soql": { "type": "string", "description": "Generated SOQL query" },
    "fields": { "type": "array", "items": { "type": "string" }, "description": "Selected fields" },
    "where": { "type": "string", "description": "WHERE clause conditions" },
    "type": { "type": "string", "enum": ["soql", "sosl"], "description": "Query type" }
  }
}
```

### SOSL Plan Schema
```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["sosl"] },
    "query": { "type": "string", "description": "Generated SOSL query" },
    "searchTerms": { "type": "array", "items": { "type": "string" } },
    "targetObjects": { "type": "array", "items": { "type": "string" } },
    "limit": { "type": "number", "default": 200 }
  }
}
```

### Error Response Schema
```json
{
  "type": "object",
  "properties": {
    "error": { "type": "string", "description": "Error type" },
    "message": { "type": "string", "description": "Human-readable error message" },
    "details": { "type": "object", "description": "Additional error context" }
  }
}
```

## Error Handling

### Common Error Types
- `missing_salesforce_token`: Invalid or missing Salesforce authentication
- `needs_object`: Unable to resolve Salesforce object from query
- `invalid_soql`: Generated SOQL query is malformed
- `api_limit_exceeded`: Salesforce API limits reached
- `permission_denied`: Insufficient permissions for requested operation

### Error Response Format
```json
{
  "error": "needs_object",
  "message": "Could not identify a Salesforce object from your question. Please specify which object you want to query (e.g., 'items', 'orders', 'accounts').",
  "details": {
    "availableObjects": ["owsc__Item__c", "owsc__Order__c", "Account"]
  }
}
```

## Query Capabilities

### Natural Language Processing
- **Object Resolution**: Maps business terms to Salesforce API names using configurable synonyms
- **Field Discovery**: Automatically finds relevant fields using Describe API
- **Intent Detection**: Identifies query type (search, list, aggregate, explain)
- **Time Sensitivity**: Intelligent date range detection and application

### Supported Query Types
1. **Data Retrieval**: "Show me all wines created last month"
2. **Specific Searches**: "What is the alcohol percentage of Cockburn's wines?"
3. **Cross-Object Search**: "Search for Smith across all objects"
4. **Aggregation**: "Summarize wine inventory by location"
5. **Relationship Queries**: "Show orders with their related items"

### Query Optimization
- Automatic LIMIT application for performance
- Smart field selection based on query context
- Relationship traversal when needed
- Date range optimization for time-sensitive queries

## Authentication & Security

### Token Management
- Salesforce access tokens stored securely in `data/secrets/tokens.json`
- Per-organization token isolation
- Automatic token validation and refresh handling

### Access Control
- Configurable object allowlists/blocklists
- Field-level security respect
- PII redaction capabilities
- DML operation feature flags

### Rate Limiting
- Salesforce API limits automatically handled
- Retry logic with exponential backoff
- Request queuing for high-volume scenarios

## Configuration

### Organization Profiles
Each org configured in `data/configs/{orgId}.json`:

```json
{
  "orgId": "wholesale-system",
  "namespaces": ["owsc__"],
  "objectSynonyms": {
    "owsc__Item__c": ["wine", "product", "inventory", "item"],
    "owsc__Order__c": ["order", "purchase order", "po"]
  },
  "guardrails": {
    "maxRows": 1000,
    "allowedObjects": [],
    "blockedObjects": ["UserRecordAccess"]
  },
  "features": {
    "dmlOperations": {
      "enabled": false,
      "allowedOperations": { "insert": false, "update": false }
    }
  }
}
```

## Development & Testing

### Testing Endpoints
Use the built-in web interface at `http://localhost:3018` for interactive testing.

### cURL Examples
```bash
# Basic query
curl -X POST http://localhost:3018/generate/stream \
  -H "Content-Type: application/json" \
  -d '{"user_question":"What wines do we have?","orgId":"default","sessionId":"test"}'

# Cross-object search
curl -X POST http://localhost:3018/search/cross-object \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["Cockburn"],"orgId":"default"}'

# Check capabilities
curl "http://localhost:3018/search/capabilities?orgId=default"
```

### Integration Notes
- Use Server-Sent Events (SSE) for streaming responses
- Implement proper error handling for all response types
- Respect rate limits and implement client-side retry logic
- Store session IDs for conversation continuity

## Versioning

Current API version: **v1**  
Backward compatibility maintained for all v1 endpoints.

Future versions will be available at `/v2/...` endpoints while maintaining v1 support.
