# scripts\add-account.ps1
# Helper to add a Windsurf token to the pool via the /auth/login endpoint.
#
# Usage:
#   .\scripts\add-account.ps1 -Token 'eyJhbGciOi...'
#   .\scripts\add-account.ps1 -Token 'ott$...' -Label 'acc-1'

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  Write-Error "windbu is not installed. Run scripts\install.ps1 first."
  exit 1
}
$envText = Get-Content -LiteralPath $envPath -Raw
$port = if ($envText -match 'PORT=(\d+)') { [int]$matches[1] } else { 20129 }
# NOTE: $host is a PowerShell automatic variable; use a non-reserved name.
$bindHost = if ($envText -match 'HOST=([\w\.\-]+)') { $matches[1] } else { '127.0.0.1' }

$payload = @{ token = $Token }
if ($Label) { $payload.label = $Label }

try {
  $resp = Invoke-RestMethod `
    -Uri "http://${bindHost}:${port}/auth/login" `
    -Method Post `
    -ContentType 'application/json' `
    -Body ($payload | ConvertTo-Json -Compress) `
    -TimeoutSec 20
  if ($resp.success) {
    Write-Host "Account added: $($resp.account.email) (id=$($resp.account.id))" -ForegroundColor Green
    Write-Host "Pool: $($resp.total) total, $($resp.active) active"
  } else {
    Write-Host "Failed to add account:" -ForegroundColor Red
    $resp | ConvertTo-Json -Depth 4
    exit 1
  }
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Is windbu running? Try:  .\scripts\start.ps1" -ForegroundColor Yellow
  exit 1
}
