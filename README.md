# Orion Salesforce MCP Server

A powerful and intelligent Salesforce data interaction server designed specifically for wholesale distribution systems. This MCP (Model Control Plane) server provides natural language querying capabilities with advanced SOQL/SOSL generation, intelligent field resolution, and comprehensive data manipulation features.

## 🌟 Key Features

### **Intelligent Data Querying**
- **Natural Language to SOQL**: Convert plain English questions into optimized Salesforce queries
- **Smart Object & Field Resolution**: Automatically map business terms to Salesforce API names using configurable synonyms
- **Cross-Object Search (SOSL)**: Search across multiple objects simultaneously with intelligent result aggregation
- **Relationship Traversal**: Automatically handle lookups and master-detail relationships
- **Time-Sensitive Filtering**: Intelligent date range detection and application

### **Data Manipulation (DML)**
- **Controlled DML Operations**: Configurable Insert, Update, Upsert, Delete, Undelete, and Merge capabilities
- **Feature Flags**: Granular control over DML operations with org-specific configuration
- **Safety Guardrails**: Built-in limits, confirmation requirements, and bulk operation controls
- **Permission Respect**: Honor Salesforce field-level security and object permissions

### **Hybrid AI Responses**
- **Data-Driven Answers**: Combine actual Salesforce data with LLM knowledge for contextual responses
- **Intelligent Fallbacks**: Graceful handling when data is unavailable or insufficient
- **Business Context**: Understand wholesale distribution terminology and processes

### **Enterprise-Ready Architecture**
- **Multi-Org Support**: Configure different Salesforce orgs with unique settings and permissions
- **Robust Error Handling**: Comprehensive Salesforce API error handling with clear user feedback
- **Security First**: Token management, PII redaction, and configurable access controls
- **Performance Optimized**: Intelligent caching, query optimization, and efficient API usage

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- Salesforce org with API access
- Valid Salesforce access tokens

### Installation

1. **Clone and Install**
   ```bash
   git clone https://github.com/jasonjuela/orion-salesforce-mcp-server.git
   cd orion-salesforce-mcp-server
   npm install
   ```

2. **Configure Salesforce Tokens**
   ```bash
   cp data/secrets/tokens.example.json data/secrets/tokens.json
   ```
   
   Edit `data/secrets/tokens.json` with your Salesforce credentials:
   ```json
   {
     "default": {
       "access_token": "your_access_token_here",
       "instance_url": "https://your-instance.salesforce.com",
       "token_type": "Bearer"
     }
   }
   ```

3. **Customize Organization Profile**
   
   Edit `data/configs/default.json` to match your Salesforce org structure:
   ```json
   {
     "orgId": "your-org-name",
     "namespaces": ["your_namespace__"],
     "objectSynonyms": {
       "owsc__Item__c": ["wine", "product", "inventory"],
       "owsc__Order__c": ["order", "purchase order", "po"]
     }
   }
   ```

4. **Start the Server**
   ```bash
   npm start
   ```
   
   Server runs on `http://localhost:3018`

## 📖 Usage Examples

### Basic Querying
```bash
# Natural language queries
curl -X POST http://localhost:3018/generate/stream \
  -H "Content-Type: application/json" \
  -d '{
    "user_question": "What is the alcohol percentage of Cockburn'\''s wines?",
    "orgId": "default",
    "sessionId": "demo"
  }'
```

### Cross-Object Search
```bash
# Search across multiple objects
curl -X POST http://localhost:3018/generate/stream \
  -H "Content-Type: application/json" \
  -d '{
    "user_question": "search for Smith across all objects",
    "orgId": "default", 
    "sessionId": "demo"
  }'
```

### Test Interface
Open `http://localhost:3018` in your browser for a simple web interface to test queries.

## ⚙️ Configuration

### Organization Profiles (`data/configs/default.json`)

```json
{
  "orgId": "wholesale-system",
  "description": "Wholesale distribution system configuration",
  "namespaces": ["owsc__"],
  
  "guardrails": {
    "piiRedaction": true,
    "maxRows": 1000,
    "defaultDateRange": "LAST_N_MONTHS:6",
    "allowedObjects": [],
    "blockedObjects": ["UserRecordAccess", "ObjectPermissions"]
  },
  
  "features": {
    "dmlOperations": {
      "enabled": false,
      "allowedOperations": {
        "insert": false,
        "update": false,
        "upsert": false,
        "delete": false,
        "undelete": false,
        "merge": false
      },
      "safeguards": {
        "maxRecordsPerOperation": 50,
        "requireConfirmation": true,
        "allowBulkOperations": false
      }
    }
  },
  
  "objectSynonyms": {
    "owsc__Item__c": ["wine", "product", "inventory", "item"],
    "owsc__Order__c": ["order", "purchase order", "po"],
    "Account": ["account", "customer", "client"]
  }
}
```

### DML Operations

To enable data manipulation:

1. Set `features.dmlOperations.enabled: true`
2. Enable specific operations (`insert`, `update`, etc.)
3. Configure safety guardrails
4. Specify allowed/blocked objects in `dmlRestrictions`

## 🏗️ Architecture

### Core Components

- **Planner Service** (`src/services/planner.js`): Intent detection and query generation
- **Salesforce Service** (`src/services/salesforce.js`): API client with retry logic  
- **Intelligent Resolver** (`src/services/intelligentResolver.js`): Object and field mapping
- **Stream Generator** (`src/routes/generateStream.js`): Main orchestration and LLM integration

### Data Flow

1. **Intent Detection**: Analyze user question for search type and entities
2. **Object Resolution**: Map business terms to Salesforce objects using synonyms
3. **Field Discovery**: Use Describe API to find relevant fields
4. **Query Generation**: Build optimized SOQL/SOSL queries
5. **Data Retrieval**: Execute queries with error handling and retries
6. **Response Generation**: Combine data with LLM for intelligent answers

## 🔧 API Endpoints

### Primary Endpoints

- `POST /generate/stream` - Main query interface with streaming responses
- `GET /auth/login` - Salesforce OAuth initiation (placeholder)
- `GET /auth/callback` - OAuth callback handler (placeholder)
- `GET /search/capabilities` - Check available search capabilities
- `POST /search/cross-object` - Direct SOSL search endpoint

### Response Format

Streaming responses include:
- Query plan (SOQL/SOSL)
- Data retrieval status
- Record count
- Formatted results
- LLM-generated insights

## 🛡️ Security Features

- **Token Management**: Secure credential storage and rotation
- **PII Redaction**: Configurable personally identifiable information filtering
- **Object Whitelisting**: Control access to specific Salesforce objects
- **Field-Level Security**: Respect Salesforce permissions
- **Query Limits**: Prevent expensive or dangerous operations
- **Feature Flags**: Granular control over dangerous operations like DML

## 🎯 Wholesale Distribution Focus

Optimized for wholesale/distribution use cases:

- **Inventory Management**: Track items, lots, containers, and locations
- **Order Processing**: Handle purchase orders, sales orders, and fulfillment
- **Supply Chain**: Manage vendors, warehouses, and shipping
- **Financial Operations**: Support invoicing, payments, and accounting
- **Business Intelligence**: Aggregate data for reporting and analytics

## 🚦 Production Considerations

### Performance
- Implement response caching for frequent queries
- Use connection pooling for Salesforce API calls
- Add request rate limiting
- Monitor API usage limits

### Security
- Implement proper OAuth flows
- Add request authentication/authorization
- Enable HTTPS in production
- Regular token rotation
- Audit logging

### Monitoring
- Add comprehensive logging
- Implement health checks
- Monitor Salesforce API limits
- Track query performance metrics

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For questions, issues, or feature requests:
- Open an issue on GitHub
- Check existing documentation
- Review configuration examples

---

**Built for intelligent Salesforce data interaction with wholesale distribution in mind.**
