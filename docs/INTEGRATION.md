# AI-Assistant Integration Guide

## Overview

This guide helps you integrate your AI-Assistant with the Orion Salesforce MCP Server. The MCP server provides stable APIs that your AI-Assistant can consume for intelligent Salesforce data interactions.

## Architecture

```
┌─────────────────┐    HTTP/REST     ┌──────────────────────┐    Salesforce    ┌─────────────┐
│   AI-Assistant  │ ──────────────▶  │   MCP Server         │ ──────────────▶  │ Salesforce  │
│   (React/Vue)   │                  │   (localhost:3018)   │                  │     Org     │
└─────────────────┘                  └──────────────────────┘                  └─────────────┘
```

## Quick Start

### 1. Include the Client SDK

**Option A: Copy the SDK file**
```bash
# Copy the client SDK to your AI-Assistant project
cp docs/client-sdk.js src/lib/mcp-client.js
```

**Option B: Use it directly from the MCP server**
```html
<!-- In your HTML -->
<script src="http://localhost:3018/docs/client-sdk.js"></script>
```

### 2. Initialize the Client

```javascript
// ES6 modules
import { OrionMCPClient } from './lib/mcp-client.js';

// Or CommonJS
const { OrionMCPClient } = require('./lib/mcp-client.js');

// Initialize client
const mcpClient = new OrionMCPClient('http://localhost:3018', {
  version: 'v1',  // Use versioned APIs
  timeout: 30000  // 30 second timeout
});
```

### 3. Basic Chat Integration

```javascript
async function handleUserMessage(userMessage, sessionId) {
  try {
    // Query Salesforce via MCP server
    const result = await mcpClient.query(
      userMessage, 
      'default',     // orgId 
      sessionId,
      { stream: false }  // Get structured response
    );
    
    return {
      response: result.response,
      dataRows: result.dataRows,
      queryPlan: result.plan
    };
    
  } catch (error) {
    console.error('MCP Query failed:', error);
    
    if (error.code === 'needs_object') {
      return {
        response: "I couldn't identify which Salesforce object you're asking about. Could you be more specific? For example, try asking about 'wines', 'orders', or 'accounts'.",
        suggestions: error.details?.availableObjects
      };
    }
    
    return {
      response: "I'm having trouble accessing that information right now. Please try again.",
      error: error.message
    };
  }
}
```

## React Component Example

```jsx
import React, { useState, useEffect } from 'react';
import { OrionMCPClient } from '../lib/mcp-client';

const SalesforceChat = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [mcpClient] = useState(() => new OrionMCPClient('http://localhost:3018'));
  const [sessionId] = useState(() => `session-${Date.now()}`);

  const sendMessage = async () => {
    if (!input.trim()) return;
    
    const userMessage = input;
    setInput('');
    setLoading(true);
    
    // Add user message
    setMessages(prev => [...prev, { 
      type: 'user', 
      content: userMessage,
      timestamp: new Date()
    }]);

    try {
      // Query MCP server
      const result = await mcpClient.query(userMessage, 'default', sessionId, { stream: false });
      
      // Add AI response
      setMessages(prev => [...prev, {
        type: 'ai',
        content: result.response,
        dataRows: result.dataRows,
        queryPlan: result.plan,
        timestamp: new Date()
      }]);
      
    } catch (error) {
      setMessages(prev => [...prev, {
        type: 'error',
        content: `Error: ${error.message}`,
        timestamp: new Date()
      }]);
    }
    
    setLoading(false);
  };

  return (
    <div className="salesforce-chat">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.type}`}>
            <div className="content">{msg.content}</div>
            {msg.dataRows && (
              <div className="metadata">📊 {msg.dataRows} records found</div>
            )}
            {msg.queryPlan && (
              <details className="query-plan">
                <summary>View Query Plan</summary>
                <pre>{JSON.stringify(msg.queryPlan, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
        {loading && <div className="message loading">Thinking...</div>}
      </div>
      
      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Ask about your Salesforce data..."
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default SalesforceChat;
```

## Advanced Features

### Streaming Responses

For real-time, typewriter-effect responses:

```javascript
async function handleStreamingResponse(userMessage, sessionId, onChunk) {
  try {
    const stream = await mcpClient.query(userMessage, 'default', sessionId, { stream: true });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    
    let plan = null;
    let dataRows = 0;
    let response = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      const lines = text.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('PLAN: ')) {
          plan = JSON.parse(line.substring(6));
          onChunk({ type: 'plan', data: plan });
        } else if (line.startsWith('DATA ROWS: ')) {
          dataRows = parseInt(line.substring(11));
          onChunk({ type: 'dataRows', data: dataRows });
        } else if (line === '[DONE]') {
          onChunk({ type: 'done' });
          return { plan, dataRows, response };
        } else if (line.trim()) {
          response += line + '\n';
          onChunk({ type: 'text', data: line });
        }
      }
    }
  } catch (error) {
    onChunk({ type: 'error', data: error.message });
  }
}
```

### Cross-Object Search

Add search functionality across multiple Salesforce objects:

```javascript
const SearchComponent = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState(null);
  
  const handleSearch = async () => {
    try {
      const searchResults = await mcpClient.crossObjectSearch(
        searchTerm,
        'default',
        { limit: 50 }
      );
      setResults(searchResults);
    } catch (error) {
      console.error('Search failed:', error);
    }
  };
  
  return (
    <div>
      <input 
        value={searchTerm} 
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search across all objects..."
      />
      <button onClick={handleSearch}>Search</button>
      
      {results && (
        <div className="search-results">
          <h3>Found {results.totalRecords} results</h3>
          {results.data.searchRecords.map((record, idx) => (
            <div key={idx} className="search-result">
              <strong>{record.attributes.type}</strong>: {record.Name}
              <small>ID: {record.Id}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
```

### Capabilities-Based UI

Adapt your UI based on available MCP capabilities:

```javascript
const useCapabilities = (orgId = 'default') => {
  const [capabilities, setCapabilities] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const loadCapabilities = async () => {
      try {
        const caps = await mcpClient.getCapabilities(orgId);
        setCapabilities(caps);
      } catch (error) {
        console.error('Failed to load capabilities:', error);
      }
      setLoading(false);
    };
    
    loadCapabilities();
  }, [orgId]);
  
  return { capabilities, loading };
};

// Use in component
const ChatInterface = () => {
  const { capabilities, loading } = useCapabilities();
  
  if (loading) return <div>Loading capabilities...</div>;
  
  return (
    <div>
      <SalesforceChat />
      
      {capabilities?.capabilities.dml.enabled && (
        <div className="dml-warning">
          ⚠️ Data modification operations are enabled. Be careful with your requests.
        </div>
      )}
      
      {capabilities?.features.crossObjectSearch && (
        <SearchComponent />
      )}
    </div>
  );
};
```

## Error Handling

### Common Error Types

```javascript
const handleMCPError = (error) => {
  switch (error.code) {
    case 'missing_salesforce_token':
      return "Authentication required. Please log in to Salesforce.";
      
    case 'needs_object':
      return "I couldn't identify which data you're asking about. Please be more specific.";
      
    case 'invalid_soql':
      return "There was an issue with the query. Please rephrase your question.";
      
    case 'api_limit_exceeded':
      return "API limits reached. Please try again in a few minutes.";
      
    case 'permission_denied':
      return "You don't have permission to access that data.";
      
    default:
      return "Something went wrong. Please try again.";
  }
};
```

### Retry Logic

```javascript
const queryWithRetry = async (userMessage, orgId, sessionId, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await mcpClient.query(userMessage, orgId, sessionId, { stream: false });
    } catch (error) {
      if (attempt === maxRetries || error.code === 'permission_denied') {
        throw error;
      }
      
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
};
```

## Development Tips

### 1. Environment Configuration

```javascript
// config.js
const config = {
  mcpServer: {
    url: process.env.REACT_APP_MCP_URL || 'http://localhost:3018',
    orgId: process.env.REACT_APP_ORG_ID || 'default',
    timeout: 30000
  }
};

export default config;
```

### 2. Session Management

```javascript
// Use persistent session IDs for conversation continuity
const getSessionId = () => {
  let sessionId = localStorage.getItem('salesforce-chat-session');
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('salesforce-chat-session', sessionId);
  }
  return sessionId;
};
```

### 3. Message History

```javascript
// Store conversation history
const saveMessage = (message) => {
  const history = JSON.parse(localStorage.getItem('chat-history') || '[]');
  history.push({ ...message, timestamp: new Date().toISOString() });
  
  // Keep only last 50 messages
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }
  
  localStorage.setItem('chat-history', JSON.stringify(history));
};
```

## Testing

### Unit Tests

```javascript
// mcp-client.test.js
import { OrionMCPClient } from '../lib/mcp-client';

describe('OrionMCPClient', () => {
  let client;
  
  beforeEach(() => {
    client = new OrionMCPClient('http://localhost:3018');
  });
  
  test('should initialize with correct base URL', () => {
    expect(client.baseURL).toBe('http://localhost:3018');
    expect(client.apiBase).toBe('http://localhost:3018/v1');
  });
  
  test('should handle capabilities request', async () => {
    // Mock fetch response
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        orgId: 'default',
        capabilities: { read: true, dml: { enabled: false } }
      })
    });
    
    const capabilities = await client.getCapabilities();
    expect(capabilities.orgId).toBe('default');
  });
});
```

### Integration Tests

```javascript
// integration.test.js
describe('MCP Integration', () => {
  test('should handle basic query flow', async () => {
    const client = new OrionMCPClient('http://localhost:3018');
    
    const result = await client.query(
      'What items do we have?',
      'default',
      'test-session',
      { stream: false }
    );
    
    expect(result.response).toBeDefined();
    expect(result.plan).toBeDefined();
    expect(typeof result.dataRows).toBe('number');
  });
});
```

## Next Steps

1. **Set up your AI-Assistant project** using React, Vue, or your preferred framework
2. **Copy the client SDK** into your project
3. **Implement the chat interface** using the examples above
4. **Test with your MCP server** running on localhost:3018
5. **Add advanced features** like streaming, search, and error handling
6. **Deploy both services** to your preferred hosting platform

## Troubleshooting

### Common Issues

**CORS Errors**: Ensure your MCP server is running with CORS enabled (it is by default).

**Connection Refused**: Make sure the MCP server is running on the expected port (3018).

**Authentication Errors**: Verify that `data/secrets/tokens.json` contains valid Salesforce tokens.

**Query Failures**: Check the MCP server logs for detailed error information.

### Debug Mode

```javascript
const client = new OrionMCPClient('http://localhost:3018', {
  debug: true  // Enable debug logging
});
```

For more help, check the MCP server logs or open an issue on GitHub.
