# scripts\start.ps1
# Starts windbu in this window.
# If .env is missing, redirects to install.ps1.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
  Write-Host ''
  Write-Host 'windbu is not configured yet.' -ForegroundColor Yellow
  Write-Host 'Running installer...' -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'install.ps1')
  exit $LASTEXITCODE
}

# Single-instance guard
$pidFile = Join-Path $env:USERPROFILE '.windbu\windbu.pid'
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) {
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match '^node') {
      $env = Get-Content -LiteralPath (Join-Path $root '.env') -Raw -ErrorAction SilentlyContinue
      $port = if ($env -match 'PORT=(\d+)') { $matches[1] } else { '20129' }
      Write-Host "windbu is already running (PID $oldPid)." -ForegroundColor Green
      Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
      exit 0
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# Write our PID for stop.ps1 / future start.ps1 calls to find us
$null = New-Item -ItemType Directory -Path (Split-Path $pidFile) -Force -ErrorAction SilentlyContinue
$PID | Out-File -LiteralPath $pidFile -Encoding ascii -Force

Set-Location -LiteralPath $root
try {
  & node 'src\index.js'
} finally {
  if (Test-Path -LiteralPath $pidFile) {
    $cur = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ("$cur" -eq "$PID") { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  }
}
