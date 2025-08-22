# Test script for relationship queries
$baseUrl = "http://localhost:3018"

Write-Host "Testing Multi-Object Relationship Queries..." -ForegroundColor Green

# Test 1: Items and Locations
Write-Host "`n1. Testing Items → Locations relationship:" -ForegroundColor Yellow
$body1 = @{
    user_question = "Show me items and their inventory locations"
    org_id = "default"
    sessionId = "relationship-test"
} | ConvertTo-Json

try {
    $response1 = Invoke-RestMethod -Uri "$baseUrl/generate" -Method POST -Body $body1 -ContentType "application/json"
    Write-Host "✅ Query Plan: $($response1.plan.object)" -ForegroundColor Green
    Write-Host "✅ SOQL: $($response1.plan.soql)" -ForegroundColor Green
    Write-Host "✅ Data rows: $($response1.data.length)" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 2: Items and Orders
Write-Host "`n2. Testing Items → Orders relationship:" -ForegroundColor Yellow
$body2 = @{
    user_question = "Show me items that were ordered with their order information"
    org_id = "default"
    sessionId = "relationship-test"
} | ConvertTo-Json

try {
    $response2 = Invoke-RestMethod -Uri "$baseUrl/generate" -Method POST -Body $body2 -ContentType "application/json"
    Write-Host "✅ Query Plan: $($response2.plan.object)" -ForegroundColor Green
    Write-Host "✅ SOQL: $($response2.plan.soql)" -ForegroundColor Green
    Write-Host "✅ Data rows: $($response2.data.length)" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 3: Items and Pricing
Write-Host "`n3. Testing Items → Pricing relationship:" -ForegroundColor Yellow
$body3 = @{
    user_question = "Show me item prices by price list"
    org_id = "default"
    sessionId = "relationship-test"
} | ConvertTo-Json

try {
    $response3 = Invoke-RestMethod -Uri "$baseUrl/generate" -Method POST -Body $body3 -ContentType "application/json"
    Write-Host "✅ Query Plan: $($response3.plan.object)" -ForegroundColor Green
    Write-Host "✅ SOQL: $($response3.plan.soql)" -ForegroundColor Green
    Write-Host "✅ Data rows: $($response3.data.length)" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test 4: Multi-hop relationship
Write-Host "`n4. Testing Multi-hop relationship:" -ForegroundColor Yellow
$body4 = @{
    user_question = "Show me items with their container and unit of measure information"
    org_id = "default"
    sessionId = "relationship-test"
} | ConvertTo-Json

try {
    $response4 = Invoke-RestMethod -Uri "$baseUrl/generate" -Method POST -Body $body4 -ContentType "application/json"
    Write-Host "✅ Query Plan: $($response4.plan.object)" -ForegroundColor Green
    Write-Host "✅ SOQL: $($response4.plan.soql)" -ForegroundColor Green
    Write-Host "✅ Data rows: $($response4.data.length)" -ForegroundColor Green
    
    # Check if SOQL contains relationship fields
    if ($response4.plan.soql -match "__r\.") {
        Write-Host "✅ Contains relationship fields (__r.)" -ForegroundColor Green
    } else {
        Write-Host "⚠️  No relationship fields detected" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`nRelationship testing complete!" -ForegroundColor Green
