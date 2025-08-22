# Config
$Port = 3018
$Repo = "D:\MVP Cursor Apps\orion-salesforce-mcp-server"
$LoginUrl = "http://localhost:$Port/auth/login?sessionId=dev&orgId=default"

# Kill node + listeners
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
$ports = 3000..3020
Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' -and ($ports -contains $_.LocalPort) } |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

# Start server
Set-Location $Repo
$env:PORT = "$Port"
if (-not $env:TOKEN_SECRET) { $env:TOKEN_SECRET = 'dev-secret-please-change' }
Start-Process -FilePath node -ArgumentList "server.js" -WindowStyle Minimized
Start-Sleep -Seconds 2

# Health check
$ok = $false
for ($i=0; $i -lt 10; $i++) {
  try { if ((Invoke-RestMethod "http://localhost:$Port/health" -TimeoutSec 2).ok) { $ok = $true; break } } catch {}
  Start-Sleep -Milliseconds 500
}
Write-Host ("HEALTH_OK=" + $ok)

# Open OAuth login
Start-Process $LoginUrl


