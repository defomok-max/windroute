# scripts\stop.ps1
# Stops any running windbu instance by PID file, then by port probe as a fallback.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $env:USERPROFILE '.windbu\windbu.pid'

function Stop-PidTree([int]$Pid) {
  if (-not $Pid) { return }
  # Use taskkill to tear down children (LS instances) too.
  & taskkill /PID $Pid /T /F 2>$null | Out-Null
}

$stopped = $false
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) {
    Stop-PidTree -Pid ([int]$oldPid)
    Write-Host "Stopped windbu (PID $oldPid)." -ForegroundColor Green
    $stopped = $true
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# Fallback: find whatever is listening on windbu's port.
$port = 20129
$envPath = Join-Path $root '.env'
if (Test-Path -LiteralPath $envPath) {
  $envText = Get-Content -LiteralPath $envPath -Raw
  if ($envText -match 'PORT=(\d+)') { $port = [int]$matches[1] }
}
$owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $owners) {
  Stop-PidTree -Pid $p
  Write-Host "Stopped process on port $port (PID $p)." -ForegroundColor Green
  $stopped = $true
}

if (-not $stopped) {
  Write-Host 'windbu is not running.' -ForegroundColor Yellow
}
