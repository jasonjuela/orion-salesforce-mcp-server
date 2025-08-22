# Comprehensive MCP Testing Script
# Tests all major features of the Salesforce MCP

$baseUrl = "http://localhost:3018"
$testSessionId = "test-session-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$testOrgId = "test-org"

Write-Host "🚀 Starting Comprehensive MCP Test Suite" -ForegroundColor Green
Write-Host "Base URL: $baseUrl" -ForegroundColor Cyan
Write-Host "Session ID: $testSessionId" -ForegroundColor Cyan
Write-Host "Org ID: $testOrgId" -ForegroundColor Cyan
Write-Host ""

# Test counter
$testCount = 0
$passedTests = 0
$failedTests = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = "GET",
        [string]$Url,
        [hashtable]$Body = $null,
        [string]$ExpectedStatus = "200",
        [string]$ExpectedContent = $null
    )
    
    $global:testCount++
    Write-Host "Test $global:testCount : $Name" -ForegroundColor Yellow
    
    try {
        $params = @{
            Uri = $Url
            Method = $Method
            ErrorAction = "Stop"
        }
        
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
            $params.ContentType = "application/json"
        }
        
        $response = Invoke-RestMethod @params
        
        if ($ExpectedContent) {
            if ($response -match $ExpectedContent -or ($response | ConvertTo-Json) -match $ExpectedContent) {
                Write-Host "  ✅ PASSED: Response contains expected content" -ForegroundColor Green
                $global:passedTests++
            } else {
                Write-Host "  ❌ FAILED: Expected content not found" -ForegroundColor Red
                Write-Host "  Expected: $ExpectedContent" -ForegroundColor Gray
                Write-Host "  Got: $($response | ConvertTo-Json -Compress)" -ForegroundColor Gray
                $global:failedTests++
            }
        } else {
            Write-Host "  ✅ PASSED: Request successful" -ForegroundColor Green
            $global:passedTests++
        }
        
        return $response
    }
    catch {
        Write-Host "  ❌ FAILED: $($_.Exception.Message)" -ForegroundColor Red
        $global:failedTests++
        return $null
    }
}

# =============================================================================
# 1. BASIC HEALTH CHECKS
# =============================================================================
Write-Host "📊 1. BASIC HEALTH CHECKS" -ForegroundColor Magenta

Test-Endpoint -Name "Health Check" -Url "$baseUrl/health" -ExpectedContent "ok"

Test-Endpoint -Name "Metrics Endpoint" -Url "$baseUrl/metrics" -ExpectedContent "timestamp"

# =============================================================================
# 2. CONFIGURATION SYSTEM TESTS
# =============================================================================
Write-Host "`n📁 2. CONFIGURATION SYSTEM TESTS" -ForegroundColor Magenta

Test-Endpoint -Name "List Org Profiles" -Url "$baseUrl/config" -ExpectedContent "profiles"

Test-Endpoint -Name "Load Default Org Profile" -Url "$baseUrl/config/default" -ExpectedContent "objectSynonyms"

Test-Endpoint -Name "List Personas" -Url "$baseUrl/personas" -ExpectedContent "personas"

Test-Endpoint -Name "Load Helpful Architect Persona" -Url "$baseUrl/personas/helpful-architect" -ExpectedContent "helpful-architect"

Test-Endpoint -Name "Load Data Analyst Persona" -Url "$baseUrl/personas/data-analyst" -ExpectedContent "data-analyst"

# =============================================================================
# 3. AUTHENTICATION TESTS  
# =============================================================================
Write-Host "`n🔐 3. AUTHENTICATION TESTS" -ForegroundColor Magenta

$authStatus = Test-Endpoint -Name "Auth Status Check" -Url "$baseUrl/auth/status?sessionId=$testSessionId`&orgId=$testOrgId"

# Note: OAuth login requires manual browser interaction, so we'll just check the endpoint exists
Test-Endpoint -Name "Auth Login Endpoint Exists" -Url "$baseUrl/auth/login?sessionId=$testSessionId`&orgId=$testOrgId"

# =============================================================================
# 4. DESCRIBE AND SCHEMA TESTS
# =============================================================================
Write-Host "`n📋 4. DESCRIBE AND SCHEMA TESTS" -ForegroundColor Magenta

Test-Endpoint -Name "List SObjects" -Url "$baseUrl/sobjects?sessionId=$testSessionId`&org_id=$testOrgId"

# =============================================================================
# 5. INTELLIGENT OBJECT RESOLUTION TESTS
# =============================================================================
Write-Host "`n🧠 5. INTELLIGENT OBJECT RESOLUTION TESTS" -ForegroundColor Magenta

# Test various object resolution scenarios
$resolutionTests = @(
    @{ question = "Show me accounts"; expectedObject = "Account" },
    @{ question = "List items in inventory"; expectedObject = "owsc__Item__c" },
    @{ question = "Find customer contacts"; expectedObject = "Contact" },
    @{ question = "Show opportunities"; expectedObject = "Opportunity" }
)

foreach ($test in $resolutionTests) {
    $body = @{
        user_question = $test.question
        org_id = $testOrgId
        sessionId = $testSessionId
    }
    
    Test-Endpoint -Name "Object Resolution: '$($test.question)'" -Method "POST" -Url "$baseUrl/generate" -Body $body -ExpectedContent $test.expectedObject
}

# =============================================================================
# 6. CLARIFICATION SYSTEM TESTS
# =============================================================================
Write-Host "`n❓ 6. CLARIFICATION SYSTEM TESTS" -ForegroundColor Magenta

# Test clarification storage
$clarificationBody = @{
    sessionId = $testSessionId
    question = "Show me items"
    answer = @{ object = "owsc__Item__c" }
}

Test-Endpoint -Name "Store Clarification" -Method "POST" -Url "$baseUrl/clarify" -Body $clarificationBody -ExpectedContent "success"

Test-Endpoint -Name "Get Clarification History" -Url "$baseUrl/clarify/$testSessionId" -ExpectedContent "clarifications"

# =============================================================================
# 7. STREAMING TESTS
# =============================================================================
Write-Host "`n🌊 7. STREAMING ENDPOINT TESTS" -ForegroundColor Magenta

# Test streaming endpoint (we can't easily test SSE in PowerShell, but we can check it responds)
$streamUrl = "$baseUrl/generate/stream?sessionId=$testSessionId`&orgId=$testOrgId`&user_question=Show me accounts"
Test-Endpoint -Name "Streaming Endpoint Responds" -Url $streamUrl

# =============================================================================
# 8. SECURITY VALIDATION TESTS
# =============================================================================
Write-Host "`n🔒 8. SECURITY VALIDATION TESTS" -ForegroundColor Magenta

# Test queries with missing parameters (should fail gracefully)
$securityTests = @(
    @{ body = @{}; name = "Missing Required Fields" },
    @{ body = @{ user_question = "test" }; name = "Missing Org ID" },
    @{ body = @{ org_id = "test" }; name = "Missing Question" }
)

foreach ($test in $securityTests) {
    Test-Endpoint -Name "Security: $($test.name)" -Method "POST" -Url "$baseUrl/generate" -Body $test.body -ExpectedContent "error"
}

# =============================================================================
# 9. EXPORT FUNCTIONALITY TESTS
# =============================================================================
Write-Host "`n📤 9. EXPORT FUNCTIONALITY TESTS" -ForegroundColor Magenta

Test-Endpoint -Name "Export Endpoint Available" -Url "$baseUrl/export" -ExpectedContent "exports"

# =============================================================================
# 10. PREFERENCE LEARNING TESTS
# =============================================================================
Write-Host "`n🎯 10. PREFERENCE LEARNING TESTS" -ForegroundColor Magenta

# Simulate multiple queries to test preference learning
$preferenceTests = @(
    "Show me accounts",
    "List all accounts", 
    "Find accounts created this year"
)

foreach ($question in $preferenceTests) {
    $body = @{
        user_question = $question
        org_id = $testOrgId
        sessionId = $testSessionId
    }
    
    Test-Endpoint -Name "Preference Learning: '$question'" -Method "POST" -Url "$baseUrl/generate" -Body $body
}

# Check that preferences were recorded
Test-Endpoint -Name "Verify Preferences Recorded" -Url "$baseUrl/clarify/$testSessionId" -ExpectedContent "objectPreferences"

# =============================================================================
# SUMMARY
# =============================================================================
Write-Host "`n📊 TEST SUMMARY" -ForegroundColor Magenta
Write-Host "Total Tests: $testCount" -ForegroundColor White
Write-Host "Passed: $passedTests" -ForegroundColor Green
Write-Host "Failed: $failedTests" -ForegroundColor Red

$successRate = [math]::Round(($passedTests / $testCount) * 100, 1)
Write-Host "Success Rate: $successRate%" -ForegroundColor $(if ($successRate -ge 80) { "Green" } else { "Yellow" })

if ($failedTests -eq 0) {
    Write-Host "`n🎉 ALL TESTS PASSED! Your MCP is rock solid! 🚀" -ForegroundColor Green
} elseif ($successRate -ge 80) {
    Write-Host "`n✅ Most tests passed! MCP is working well with minor issues." -ForegroundColor Yellow
} else {
    Write-Host "`n⚠️  Several tests failed. Please review the errors above." -ForegroundColor Red
}

Write-Host "`n💡 Next Steps:" -ForegroundColor Cyan
Write-Host "1. For full testing, authenticate via: $baseUrl/auth/login" -ForegroundColor White
Write-Host "2. Test the stream interface: $baseUrl/stream.html" -ForegroundColor White
Write-Host "3. Monitor metrics at: $baseUrl/metrics" -ForegroundColor White
Write-Host "4. Check configurations at: $baseUrl/config and $baseUrl/personas" -ForegroundColor White
