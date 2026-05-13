# scripts\start.ps1
# Starts windbu in this window with a crash watchdog.
# If .env is missing, redirects to install.ps1.
#
# Watchdog: if node exits with non-zero code, waits 3s and restarts.
# Gives up after 5 rapid restarts within 60s to avoid infinite crash loops.
# Pass -NoWatchdog to disable.

[CmdletBinding()]
param(
  [switch]$NoWatchdog
)

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
      $envText = Get-Content -LiteralPath (Join-Path $root '.env') -Raw -ErrorAction SilentlyContinue
      $port = if ($envText -match 'PORT=(\d+)') { $matches[1] } else { '20129' }
      Write-Host "windbu is already running (PID $oldPid)." -ForegroundColor Green
      Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
      exit 0
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# Ensure PID dir exists
$null = New-Item -ItemType Directory -Path (Split-Path $pidFile) -Force -ErrorAction SilentlyContinue

Set-Location -LiteralPath $root

# Watchdog state: track rapid-restart failures so we don't loop forever.
$restartHistory = New-Object System.Collections.Generic.Queue[datetime]
$MAX_RAPID_RESTARTS = 5
$RAPID_WINDOW_SEC = 60

while ($true) {
  $nodeProc = $null
  try {
    # Start node via .NET Process so we get the PID immediately while keeping
    # stdout/stderr attached to this console window.
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'node'
    $psi.Arguments = 'src\index.js'
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $nodeProc = [System.Diagnostics.Process]::Start($psi)
    $nodeProc.Id | Out-File -LiteralPath $pidFile -Encoding ascii -Force
    # Block until node exits
    $nodeProc.WaitForExit()
    $exitCode = $nodeProc.ExitCode
  } finally {
    if (Test-Path -LiteralPath $pidFile) {
      $cur = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
      if ($nodeProc -and "$cur" -eq "$($nodeProc.Id)") {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      }
    }
  }

  # Clean exit or user stopped us: done.
  if ($exitCode -eq 0 -or $NoWatchdog) {
    if ($exitCode -ne 0) {
      Write-Host "windbu exited with code $exitCode (watchdog disabled)." -ForegroundColor Yellow
    }
    break
  }

  # Rapid-restart gate
  $now = Get-Date
  $restartHistory.Enqueue($now)
  while ($restartHistory.Count -gt 0 -and ($now - $restartHistory.Peek()).TotalSeconds -gt $RAPID_WINDOW_SEC) {
    [void]$restartHistory.Dequeue()
  }
  if ($restartHistory.Count -ge $MAX_RAPID_RESTARTS) {
    Write-Host ''
    Write-Host "windbu crashed $MAX_RAPID_RESTARTS times within $RAPID_WINDOW_SEC seconds." -ForegroundColor Red
    Write-Host "Watchdog giving up. Check logs at %USERPROFILE%\.windbu\logs\ for the cause." -ForegroundColor Red
    exit 1
  }

  Write-Host ''
  Write-Host "windbu exited with code $exitCode. Restarting in 3s... (restart $($restartHistory.Count)/$MAX_RAPID_RESTARTS within ${RAPID_WINDOW_SEC}s)" -ForegroundColor Yellow
  Start-Sleep -Seconds 3
}
