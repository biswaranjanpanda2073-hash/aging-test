$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path $PSScriptRoot -Parent
function Test-PythonRuntime {
  param([string]$Executable, [string[]]$Arguments)
  try {
    $null = & $Executable @Arguments -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info < (3, 15) else 1)" 2>&1
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

Push-Location "$ProjectRoot/backend"
try {
  $VenvPython = Join-Path $PWD '.venv/Scripts/python.exe'
  if (Test-Path $VenvPython) {
    if (Test-PythonRuntime $VenvPython @()) {
      $VenvVersion = (& $VenvPython --version 2>&1).Trim()
      Write-Host "Reusing existing compatible virtual environment ($VenvVersion)."
    } else {
      $VenvVersion = (& $VenvPython --version 2>&1).Trim()
      throw "Existing virtual environment at '$VenvPython' ($VenvVersion) is incompatible with project requirements (requires Python 3.12 or 3.14). To recreate the environment cleanly, back up and remove 'backend/.venv', then re-run install.ps1."
    }
  } else {
    $HasPy = [bool](Get-Command py -ErrorAction SilentlyContinue)
    $HasPython = [bool](Get-Command python -ErrorAction SilentlyContinue)

    if (-not $HasPy -and -not $HasPython) {
      throw 'Neither Python launcher (py.exe) nor python.exe was found in PATH. Please install Python 3.12 from python.org (ensure "Add Python to PATH" is checked). See README.md.'
    }

    $SelectedRuntime = $null
    $SelectedArgs = @()

    if ($HasPy -and (Test-PythonRuntime 'py' @('-3.12'))) {
      $SelectedRuntime = 'py'
      $SelectedArgs = @('-3.12')
    } elseif ($HasPy -and (Test-PythonRuntime 'py' @('-3.14'))) {
      $SelectedRuntime = 'py'
      $SelectedArgs = @('-3.14')
    } elseif ($HasPy -and (Test-PythonRuntime 'py' @('-3'))) {
      $SelectedRuntime = 'py'
      $SelectedArgs = @('-3')
    } elseif ($HasPython -and (Test-PythonRuntime 'python' @())) {
      $SelectedRuntime = 'python'
      $SelectedArgs = @()
    } else {
      throw 'No compatible Python runtime (Python 3.12 or 3.14) was found. Please install Python 3.12 from official sources as specified in README.md.'
    }

    & $SelectedRuntime @SelectedArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
  }
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
