$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Push-Location "$ProjectRoot/backend"
try {
  if (py -3.12 --version 2>$null) { py -3.12 -m venv .venv }
  elseif (py -3.14 --version 2>$null) { py -3.14 -m venv .venv }
  else { py -3 -m venv .venv }
  if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
  & ./.venv/Scripts/python.exe -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
} finally { Pop-Location }
Push-Location "$ProjectRoot/frontend"
try {
  npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
  npm run ocr-assets
  if ($LASTEXITCODE -ne 0) { throw 'Local OCR asset preparation failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Write-Host 'Dependencies installed. Next configure the serial format and HTTPS certificate as described in README.md.'
