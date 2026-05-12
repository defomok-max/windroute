# scripts\enable-autostart.ps1
# Creates a shortcut in the user's Startup folder that launches windbu on login.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$start = Join-Path $PSScriptRoot 'start.ps1'
$icon = Join-Path $root 'assets\icon.ico'

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'windbu.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7        # minimized
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon }
$lnk.Description = 'windbu — local gateway for Windsurf AI'
$lnk.Save()

Write-Host "Autostart enabled: $lnkPath" -ForegroundColor Green
Write-Host 'windbu will launch automatically on next login.'
