$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
foreach ($Port in @(5173,8000)) {
  $Conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($Conns) {
    foreach ($Conn in $Conns) {
      Write-Host "Port $Port was in use by PID $($Conn.OwningProcess). Stopping existing process..."
      Stop-Process -Id $Conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 600
  }
}
if (-not (Test-Path "$ProjectRoot/certs/lan.pem")) { throw 'Run scripts/setup-https.ps1 -LanIP <your-IP> first.' }
if (-not (Test-Path "$ProjectRoot/backend/.venv/Scripts/python.exe")) { throw 'Install backend dependencies first; see README.md.' }
Push-Location "$ProjectRoot/frontend"
try {
  npm run check:setup
  if ($LASTEXITCODE -ne 0) { throw 'HTTPS/build setup validation failed.' }
} finally { Pop-Location }
$BackendProcess = Start-Process -FilePath "$ProjectRoot/backend/.venv/Scripts/python.exe" -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' -WorkingDirectory "$ProjectRoot/backend" -PassThru
try {
  $Healthy = $false
  for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
    if ($BackendProcess.HasExited) { throw 'Backend failed to start. Check the backend window.' }
    try { $Result = Invoke-RestMethod 'http://127.0.0.1:8000/api/health'; if ($Result.status -eq 'ok') { $Healthy = $true; break } } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $Healthy) { throw 'Backend did not become ready. Check Excel path and workbook format.' }
  Write-Host 'Backend: http://127.0.0.1:8000 (laptop only)'
  $LanLine = Get-Content "$ProjectRoot/frontend/.env" | Where-Object { $_ -match '^LAN_IP=' } | Select-Object -First 1
  $LanAddress = $LanLine -replace '^LAN_IP=', ''
  Write-Host "Frontend / phone URL: https://${LanAddress}:5173"
  Push-Location "$ProjectRoot/frontend"
  try { npm run serve } finally { Pop-Location }
} finally {
  if (-not $BackendProcess.HasExited) { Stop-Process -Id $BackendProcess.Id }
}
