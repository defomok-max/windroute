# scripts\disable-autostart.ps1
# Removes the Startup-folder shortcut created by enable-autostart.ps1.

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'windbu.lnk'

if (Test-Path -LiteralPath $lnkPath) {
  Remove-Item -LiteralPath $lnkPath -Force
  Write-Host "Autostart disabled: $lnkPath" -ForegroundColor Green
} else {
  Write-Host 'Autostart was not enabled.' -ForegroundColor Yellow
}
