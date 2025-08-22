# Quick MCP Verification Tests
$baseUrl = "http://localhost:3018"

Write-Host "🚀 Quick MCP Verification Tests" -ForegroundColor Green
Write-Host "Testing: $baseUrl" -ForegroundColor Cyan
Write-Host ""

# Simple test helper
function Quick-Test {
    param([string]$Name, [string]$Url)
    Write-Host "Testing: $Name" -ForegroundColor Yellow
    try {
        $response = Invoke-RestMethod -Uri $Url -ErrorAction Stop
        Write-Host "  ✅ SUCCESS" -ForegroundColor Green
        return $true
    }
    catch {
        Write-Host "  ❌ FAILED: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

$tests = @()

# Basic health checks
$tests += Quick-Test "Health Check" "$baseUrl/health"
$tests += Quick-Test "Metrics Endpoint" "$baseUrl/metrics"

# Configuration system
$tests += Quick-Test "List Org Profiles" "$baseUrl/config"
$tests += Quick-Test "Load Default Profile" "$baseUrl/config/default"
$tests += Quick-Test "List Personas" "$baseUrl/personas"
$tests += Quick-Test "Load Architect Persona" "$baseUrl/personas/helpful-architect"

# Auth endpoints (will fail without tokens, but should respond)
Write-Host "Testing: Auth Status (expected to have auth error)" -ForegroundColor Yellow
try {
    Invoke-RestMethod -Uri "$baseUrl/auth/status?sessionId=test&orgId=test" -ErrorAction Stop
    Write-Host "  ✅ SUCCESS" -ForegroundColor Green
    $tests += $true
}
catch {
    if ($_.Exception.Message -like "*401*" -or $_.Exception.Message -like "*auth*") {
        Write-Host "  ✅ SUCCESS (expected auth error)" -ForegroundColor Green
        $tests += $true
    } else {
        Write-Host "  ❌ UNEXPECTED ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $tests += $false
    }
}

# Test a simple generate request (will fail without auth but should respond properly)
Write-Host "Testing: Generate Endpoint (expected auth error)" -ForegroundColor Yellow
try {
    $body = @{ user_question = "test"; org_id = "test"; sessionId = "test" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/generate" -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop
    Write-Host "  ✅ SUCCESS" -ForegroundColor Green
    $tests += $true
}
catch {
    if ($_.Exception.Message -like "*401*" -or $_.Exception.Message -like "*token*") {
        Write-Host "  ✅ SUCCESS (expected auth error)" -ForegroundColor Green
        $tests += $true
    } else {
        Write-Host "  ❌ UNEXPECTED ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $tests += $false
    }
}

# Summary
$passed = ($tests | Where-Object { $_ -eq $true }).Count
$total = $tests.Count
$rate = if ($total -gt 0) { [math]::Round(($passed / $total) * 100, 1) } else { 0 }

Write-Host ""
Write-Host "📊 SUMMARY" -ForegroundColor Magenta
Write-Host "Passed: $passed / $total" -ForegroundColor White
Write-Host "Success Rate: $rate%" -ForegroundColor $(if ($rate -ge 80) { "Green" } else { "Yellow" })

if ($rate -ge 90) {
    Write-Host ""
    Write-Host "🎉 EXCELLENT! Your MCP is working great!" -ForegroundColor Green
    Write-Host ""
    Write-Host "🔗 Next Steps:" -ForegroundColor Cyan
    Write-Host "1. Open browser: $baseUrl/stream.html" -ForegroundColor White
    Write-Host "2. Authenticate: $baseUrl/auth/login" -ForegroundColor White
    Write-Host "3. Test queries after authentication" -ForegroundColor White
}
elseif ($rate -ge 70) {
    Write-Host ""
    Write-Host "✅ GOOD! Most endpoints working." -ForegroundColor Yellow
}
else {
    Write-Host ""
    Write-Host "⚠️ Issues detected. Check server logs." -ForegroundColor Red
}
