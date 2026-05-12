# scripts\detect-ls.ps1
# Finds Windsurf Language Server binary on this machine.
# Prints the absolute path on success; exits 1 on failure.
#
# Usage:
#   .\scripts\detect-ls.ps1              # silent, prints path or nothing
#   .\scripts\detect-ls.ps1 -Verbose     # shows candidate checks

[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'

function Get-Candidates {
  $list = @()

  # User-scoped installs (most common)
  if ($env:LOCALAPPDATA) {
    $list += Join-Path $env:LOCALAPPDATA 'Programs\Windsurf\resources\app\extensions\windsurf\bin\language_server_windows_x64.exe'
    $list += Join-Path $env:LOCALAPPDATA 'Windsurf\bin\language_server_windows_x64.exe'
  }
  if ($env:APPDATA) {
    $list += Join-Path $env:APPDATA 'Windsurf\bin\language_server_windows_x64.exe'
  }

  # Machine-scoped installs
  if ($env:ProgramFiles) {
    $list += Join-Path $env:ProgramFiles 'Windsurf\resources\app\extensions\windsurf\bin\language_server_windows_x64.exe'
    $list += Join-Path $env:ProgramFiles 'Windsurf\language_server_windows_x64.exe'
  }
  if (${env:ProgramFiles(x86)}) {
    $list += Join-Path ${env:ProgramFiles(x86)} 'Windsurf\resources\app\extensions\windsurf\bin\language_server_windows_x64.exe'
  }

  # VS Code Codeium extension variant (rare but works)
  if ($env:USERPROFILE) {
    $list += Join-Path $env:USERPROFILE '.vscode\extensions'
  }

  # windbu-owned location (e.g. downloaded via install.ps1)
  if ($env:USERPROFILE) {
    $list += Join-Path $env:USERPROFILE '.windbu\ls\language_server_windows_x64.exe'
  }

  return $list
}

$candidates = Get-Candidates
foreach ($c in $candidates) {
  if (-not $c) { continue }
  Write-Verbose "check: $c"
  if (Test-Path -LiteralPath $c -PathType Leaf) {
    Write-Output $c
    exit 0
  }
  # Handle VS Code extension dir (need to search inside versioned folders)
  if ($c -like '*\.vscode\extensions') {
    $match = Get-ChildItem -LiteralPath $c -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^codeium|^windsurf' } |
      ForEach-Object {
        Get-ChildItem -Path $_.FullName -Recurse -Filter 'language_server_windows_x64.exe' -ErrorAction SilentlyContinue -Force |
          Select-Object -First 1
      } | Select-Object -First 1
    if ($match) {
      Write-Output $match.FullName
      exit 0
    }
  }
}

exit 1
