# 🧪 MCP Testing Checklist

## 🤖 Automated Tests
Run the comprehensive test suite:
```powershell
.\test_comprehensive.ps1
```

## 🔍 Manual Testing Steps

### 1. Authentication Flow
- [ ] Navigate to: `http://localhost:3018/auth/login`
- [ ] Complete Salesforce OAuth (should redirect to callback)
- [ ] Verify successful token storage

### 2. Basic Query Testing
- [ ] Navigate to: `http://localhost:3018/stream.html`
- [ ] Test basic queries:
  - [ ] "Show me accounts"
  - [ ] "List items" (should resolve to owsc__Item__c)
  - [ ] "Find contacts"
  - [ ] "Show opportunities from last month"

### 3. Intelligent Object Resolution
- [ ] Test fuzzy matching:
  - [ ] "Show me custmers" (typo → Account)
  - [ ] "List itms" (typo → owsc__Item__c)
  - [ ] "Find poeple" (typo → Contact)
- [ ] Test synonyms:
  - [ ] "Show inventory" → owsc__Item__c
  - [ ] "List lots" → owsc__Item_Lot__c
  - [ ] "Find locations" → owsc__Inventory_Location__c

### 4. Clarification System
- [ ] Ask ambiguous question: "Show me products"
- [ ] Verify clarification options appear
- [ ] Select an option
- [ ] Ask same question again - should auto-resolve

### 5. Security & Permissions
- [ ] Try querying restricted objects (should block)
- [ ] Verify field-level security in responses
- [ ] Check security metadata in responses

### 6. Preference Learning
- [ ] Query same object type multiple times
- [ ] Check `/clarify/dev` to see usage tracked
- [ ] Notice improved suggestions over time

### 7. Configuration System
- [ ] Check `/config` - should list default profile
- [ ] Check `/personas` - should show 2 personas
- [ ] Try `/config/default` - should show rich config
- [ ] Try `/personas/data-analyst` - should show analyst persona

### 8. Monitoring & Metrics
- [ ] Check `/metrics` for system stats
- [ ] Verify request counts increase with usage
- [ ] Check object usage statistics

### 9. Advanced Features
- [ ] Test relationship queries: "Show accounts with their contacts"
- [ ] Test aggregation: "Summarize items by location"
- [ ] Test date ranges: "Show accounts created this year"
- [ ] Test export suggestions for large datasets

## 🎯 Expected Behavior

### ✅ Success Indicators
- [ ] No server crashes or 500 errors
- [ ] Intelligent object resolution works (typos, synonyms)
- [ ] Clarifications are remembered and reused
- [ ] Security checks prevent unauthorized access
- [ ] Preferences improve suggestions over time
- [ ] Rich metadata in all responses
- [ ] Streaming works smoothly
- [ ] Configuration endpoints functional

### ⚠️ Warning Signs
- [ ] Frequent 400/500 errors
- [ ] Poor object resolution (always asks for clarification)
- [ ] Clarifications not remembered
- [ ] Security bypassed
- [ ] No preference learning
- [ ] Missing metadata
- [ ] Streaming failures

## 🔧 Troubleshooting

### Common Issues
1. **"missing_salesforce_token"** → Run OAuth flow first
2. **"access_denied"** → Check object permissions in org
3. **"needs_object"** → Expected for ambiguous queries
4. **Stream errors** → Check browser console and server logs
5. **Config not loading** → Verify files in `data/configs/` and `data/personas/`

### Debug Commands
```powershell
# Check server logs
Get-Content server.log -Tail 50

# Test specific endpoint
Invoke-RestMethod -Uri "http://localhost:3018/health"

# Check configuration
Invoke-RestMethod -Uri "http://localhost:3018/config/default"

# Monitor metrics
Invoke-RestMethod -Uri "http://localhost:3018/metrics"
```

## 📊 Performance Benchmarks

### Response Times (Target)
- Health check: < 10ms
- Config loading: < 100ms
- Simple queries: < 2s
- Complex queries: < 5s
- Streaming start: < 500ms

### Memory Usage
- Base server: ~50MB
- Per session: ~1MB
- Config cache: ~5MB

### Concurrent Users
- Target: 10+ simultaneous sessions
- Should handle gracefully without crashes

## 🚀 Production Readiness Checklist

- [ ] All automated tests pass (>90%)
- [ ] Manual testing completed
- [ ] Security features working
- [ ] Performance within targets
- [ ] Error handling graceful
- [ ] Monitoring functional
- [ ] Configuration flexible
- [ ] Documentation complete
