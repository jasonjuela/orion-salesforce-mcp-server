# Simple MCP Test
$baseUrl = "http://localhost:3018"

Write-Host "🚀 Testing MCP at $baseUrl" -ForegroundColor Green
Write-Host ""

# Test 1: Health Check
Write-Host "1. Health Check..." -NoNewline
try {
    $health = Invoke-RestMethod -Uri "$baseUrl/health"
    Write-Host " ✅ PASS" -ForegroundColor Green
}
catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
}

# Test 2: Metrics
Write-Host "2. Metrics..." -NoNewline
try {
    $metrics = Invoke-RestMethod -Uri "$baseUrl/metrics"
    Write-Host " ✅ PASS" -ForegroundColor Green
}
catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
}

# Test 3: Config
Write-Host "3. Configuration..." -NoNewline
try {
    $config = Invoke-RestMethod -Uri "$baseUrl/config"
    Write-Host " ✅ PASS" -ForegroundColor Green
}
catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
}

# Test 4: Personas
Write-Host "4. Personas..." -NoNewline
try {
    $personas = Invoke-RestMethod -Uri "$baseUrl/personas"
    Write-Host " ✅ PASS" -ForegroundColor Green
}
catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
}

# Test 5: Default Profile
Write-Host "5. Default Profile..." -NoNewline
try {
    $profile = Invoke-RestMethod -Uri "$baseUrl/config/default"
    Write-Host " ✅ PASS" -ForegroundColor Green
}
catch {
    Write-Host " ❌ FAIL" -ForegroundColor Red
}

Write-Host ""
Write-Host "✅ Basic endpoints are working!" -ForegroundColor Green
Write-Host ""
Write-Host "🔗 Manual Testing URLs:" -ForegroundColor Cyan
Write-Host "- Health: $baseUrl/health" -ForegroundColor White
Write-Host "- Metrics: $baseUrl/metrics" -ForegroundColor White
Write-Host "- Config: $baseUrl/config" -ForegroundColor White
Write-Host "- Stream UI: $baseUrl/stream.html" -ForegroundColor White
Write-Host "- Auth: $baseUrl/auth/login" -ForegroundColor White
Write-Host ""
Write-Host "📋 Next: Check TESTING_CHECKLIST.md for full testing steps" -ForegroundColor Yellow
