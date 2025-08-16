/**
 * Orion Salesforce MCP Server Client SDK
 * 
 * Simple JavaScript client for interacting with the MCP server from AI-Assistant applications.
 * Supports both browser and Node.js environments.
 * 
 * @example
 * const client = new OrionMCPClient('http://localhost:3018');
 * const response = await client.query('What wines do we have in inventory?', 'default', 'session-123');
 */

class OrionMCPClient {
  /**
   * Initialize the MCP client
   * @param {string} baseURL - Base URL of the MCP server (e.g., 'http://localhost:3018')
   * @param {object} options - Configuration options
   * @param {string} options.version - API version (default: 'v1')
   * @param {number} options.timeout - Request timeout in milliseconds (default: 30000)
   */
  constructor(baseURL, options = {}) {
    this.baseURL = baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.version = options.version || 'v1';
    this.timeout = options.timeout || 30000;
    
    // Use versioned endpoints by default
    this.apiBase = `${this.baseURL}/${this.version}`;
  }

  /**
   * Execute a natural language query against Salesforce
   * @param {string} userQuestion - Natural language question
   * @param {string} orgId - Organization identifier (default: 'default')
   * @param {string} sessionId - Session identifier for conversation tracking
   * @param {object} options - Additional options
   * @param {boolean} options.stream - Whether to return streaming response (default: true)
   * @returns {Promise<ReadableStream|object>} Stream or parsed response
   */
  async query(userQuestion, orgId = 'default', sessionId, options = {}) {
    const { stream = true } = options;
    
    if (!sessionId) {
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    const requestBody = {
      user_question: userQuestion,
      orgId,
      sessionId
    };

    if (stream) {
      return this._streamingRequest('/generate/stream', requestBody);
    } else {
      // For non-streaming, we'll parse the stream and return the final result
      return this._parseStreamResponse(await this._streamingRequest('/generate/stream', requestBody));
    }
  }

  /**
   * Perform cross-object search using SOSL
   * @param {string|string[]} searchTerms - Search terms (string or array)
   * @param {string} orgId - Organization identifier (default: 'default')
   * @param {object} options - Search options
   * @param {string[]} options.targetObjects - Specific objects to search
   * @param {number} options.limit - Result limit (default: 200)
   * @returns {Promise<object>} Search results
   */
  async crossObjectSearch(searchTerms, orgId = 'default', options = {}) {
    const { targetObjects, limit = 200 } = options;
    
    const requestBody = {
      searchTerms: Array.isArray(searchTerms) ? searchTerms : [searchTerms],
      orgId,
      limit
    };

    if (targetObjects) {
      requestBody.targetObjects = targetObjects;
    }

    return this._jsonRequest('POST', '/search/cross-object', requestBody);
  }

  /**
   * Get organization capabilities and features
   * @param {string} orgId - Organization identifier (default: 'default')
   * @returns {Promise<object>} Capabilities information
   */
  async getCapabilities(orgId = 'default') {
    return this._jsonRequest('GET', `/search/capabilities?orgId=${encodeURIComponent(orgId)}`);
  }

  /**
   * Check server health
   * @returns {Promise<object>} Health status
   */
  async health() {
    return this._jsonRequest('GET', '/health', null, this.baseURL); // Use base URL, not versioned
  }

  /**
   * Make a streaming request and return ReadableStream
   * @private
   */
  async _streamingRequest(endpoint, body) {
    const url = `${this.apiBase}${endpoint}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/plain'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: 'unknown', message: errorText };
      }
      throw new OrionMCPError(errorData.error || 'request_failed', errorData.message || 'Request failed', errorData);
    }

    return response.body;
  }

  /**
   * Parse streaming response into structured data
   * @private
   */
  async _parseStreamResponse(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    
    let plan = null;
    let dataRows = 0;
    let response = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('PLAN: ')) {
            try {
              plan = JSON.parse(line.substring(6));
            } catch (e) {
              console.warn('Failed to parse plan:', e);
            }
          } else if (line.startsWith('DATA ROWS: ')) {
            dataRows = parseInt(line.substring(11)) || 0;
          } else if (line === '[DONE]') {
            // Stream complete
            break;
          } else if (line.trim()) {
            response += line + '\n';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      plan,
      dataRows,
      response: response.trim(),
      success: true
    };
  }

  /**
   * Make a JSON request
   * @private
   */
  async _jsonRequest(method, endpoint, body = null, baseUrl = null) {
    const url = `${baseUrl || this.apiBase}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(this.timeout)
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: 'unknown', message: errorText };
      }
      throw new OrionMCPError(errorData.error || 'request_failed', errorData.message || 'Request failed', errorData);
    }

    return response.json();
  }
}

/**
 * Custom error class for MCP client errors
 */
class OrionMCPError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OrionMCPError';
    this.code = code;
    this.details = details;
  }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  // Node.js
  module.exports = { OrionMCPClient, OrionMCPError };
} else if (typeof window !== 'undefined') {
  // Browser
  window.OrionMCPClient = OrionMCPClient;
  window.OrionMCPError = OrionMCPError;
}

// Usage Examples:

/**
 * Basic query example
 */
async function basicQueryExample() {
  const client = new OrionMCPClient('http://localhost:3018');
  
  try {
    // Get structured response (non-streaming)
    const result = await client.query(
      "What is the alcohol percentage of Cockburn's wines?",
      'default',
      'demo-session',
      { stream: false }
    );
    
    console.log('Query Plan:', result.plan);
    console.log('Data Rows:', result.dataRows);
    console.log('Response:', result.response);
  } catch (error) {
    console.error('Query failed:', error.message);
  }
}

/**
 * Streaming query example
 */
async function streamingQueryExample() {
  const client = new OrionMCPClient('http://localhost:3018');
  
  try {
    // Get streaming response
    const stream = await client.query(
      "Show me all wines created last month",
      'default',
      'demo-session',
      { stream: true }
    );
    
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      console.log('Stream chunk:', text);
    }
  } catch (error) {
    console.error('Streaming failed:', error.message);
  }
}

/**
 * Cross-object search example
 */
async function searchExample() {
  const client = new OrionMCPClient('http://localhost:3018');
  
  try {
    const results = await client.crossObjectSearch(
      ['Smith', 'Cockburn'],
      'default',
      { limit: 50, targetObjects: ['Account', 'owsc__Item__c'] }
    );
    
    console.log('Search Results:', results);
  } catch (error) {
    console.error('Search failed:', error.message);
  }
}

/**
 * Capabilities check example
 */
async function capabilitiesExample() {
  const client = new OrionMCPClient('http://localhost:3018');
  
  try {
    const capabilities = await client.getCapabilities('default');
    
    console.log('DML Enabled:', capabilities.capabilities.dml.enabled);
    console.log('Available Features:', capabilities.features);
  } catch (error) {
    console.error('Capabilities check failed:', error.message);
  }
}
