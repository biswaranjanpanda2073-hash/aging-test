param([Parameter(Mandatory=$true)][string]$LanIP)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($LanIP, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'Enter the laptop Wi-Fi IPv4 address from ipconfig.' }
if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) { throw 'Install mkcert first. See README.md.' }
New-Item -ItemType Directory -Force "$ProjectRoot/certs" | Out-Null
mkcert -install
if ($LASTEXITCODE -ne 0) { throw 'Local CA installation failed.' }
mkcert -key-file "$ProjectRoot/certs/lan-key.pem" -cert-file "$ProjectRoot/certs/lan.pem" localhost 127.0.0.1 $LanIP 192.168.137.1
if ($LASTEXITCODE -ne 0) { throw 'Certificate generation failed.' }
$ExistingLines = @()
if (Test-Path "$ProjectRoot/frontend/.env") { $ExistingLines = @(Get-Content "$ProjectRoot/frontend/.env" | Where-Object { $_ -notmatch '^(LAN_IP|TLS_CERT|TLS_KEY)=' }) }
@($ExistingLines + @("LAN_IP=$LanIP", 'TLS_CERT=../certs/lan.pem', 'TLS_KEY=../certs/lan-key.pem')) | Set-Content "$ProjectRoot/frontend/.env" -Encoding ascii
Write-Host "Phone URL: https://${LanIP}:5173"
$CaRoot = (mkcert -CAROOT).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $CaRoot 'rootCA.pem'))) { throw 'Could not locate the generated public CA certificate.' }
New-Item -ItemType Directory -Force "$ProjectRoot/phone-setup" | Out-Null
Copy-Item (Join-Path $CaRoot 'rootCA.pem') "$ProjectRoot/phone-setup/tohands-development-ca.crt" -Force
Write-Host 'Install phone-setup/tohands-development-ca.crt as a CA certificate on your Android test phone.'
Write-Host 'Only the public CA certificate was copied. Never transfer rootCA-key.pem or lan-key.pem.' 
