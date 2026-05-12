# scripts\uninstall.ps1
# Stops windbu, removes autostart entry, deletes runtime data dir and desktop shortcut.
# Does NOT delete the source folder.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:USERPROFILE '.windbu'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'windbu.lnk'

Write-Host 'Stopping windbu if running...' -ForegroundColor Yellow
& (Join-Path $PSScriptRoot 'stop.ps1') | Out-Null

Write-Host 'Disabling autostart...' -ForegroundColor Yellow
& (Join-Path $PSScriptRoot 'disable-autostart.ps1') | Out-Null

if (Test-Path -LiteralPath $shortcut) {
  Remove-Item -LiteralPath $shortcut -Force
  Write-Host "Removed desktop shortcut: $shortcut"
}

if (Test-Path -LiteralPath $data) {
  $confirm = Read-Host "Delete runtime data at $data (accounts, stats, logs)? [y/N]"
  if ($confirm -eq 'y' -or $confirm -eq 'Y') {
    Remove-Item -LiteralPath $data -Recurse -Force
    Write-Host "Deleted: $data" -ForegroundColor Green
  } else {
    Write-Host "Kept: $data"
  }
}

$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
  Remove-Item -LiteralPath $envFile -Force
  Write-Host "Deleted: $envFile"
}

Write-Host ''
Write-Host 'Uninstall complete. Source folder left at:' -ForegroundColor Green
Write-Host "  $root"
Write-Host 'Delete it manually if you want to remove everything.'
