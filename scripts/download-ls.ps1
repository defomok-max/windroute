# scripts\download-ls.ps1
# Downloads language_server_windows_x64.exe from the official Windsurf CDN
# into %USERPROFILE%\.windbu\ls\, so windbu works without a full Windsurf
# install. Idempotent — if the binary already exists and is >50MB, skipped.
#
# Usage:
#   .\scripts\download-ls.ps1                   # downloads default version
#   .\scripts\download-ls.ps1 -Version 2.12.5   # specific version
#   .\scripts\download-ls.ps1 -Force            # re-download even if present
#
# Prints the final absolute path on success, or exits non-zero on failure.

[CmdletBinding()]
param(
  [string]$Version = '2.12.5',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$lsDir = Join-Path $env:USERPROFILE '.windbu\ls'
$lsExe = Join-Path $lsDir 'language_server_windows_x64.exe'
$gzPath = Join-Path $lsDir 'language_server_windows_x64.exe.gz'

$null = New-Item -ItemType Directory -Path $lsDir -Force -ErrorAction SilentlyContinue

# Skip if binary already present and reasonable size
if (-not $Force -and (Test-Path -LiteralPath $lsExe)) {
  $size = (Get-Item -LiteralPath $lsExe).Length
  if ($size -gt 50MB) {
    Write-Host "Language Server already present: $lsExe ($([math]::Round($size/1MB)) MB)" -ForegroundColor Green
    Write-Output $lsExe
    exit 0
  }
  Write-Host "Existing binary is suspiciously small ($([math]::Round($size/1MB,2)) MB), re-downloading..." -ForegroundColor Yellow
  Remove-Item -LiteralPath $lsExe -Force -ErrorAction SilentlyContinue
}

# Known-good CDN URLs (gz-compressed). Multiple candidates for resilience.
$urls = @(
  "https://releases.codeiumdata.com/windsurf/$Version/language_server_windows_x64.exe.gz",
  "https://releases.codeiumdata.com/$Version/language_server_windows_x64.exe.gz"
)

$downloaded = $false
foreach ($url in $urls) {
  Write-Host "Fetching Language Server v$Version..."
  Write-Host "  URL: $url" -ForegroundColor DarkGray
  try {
    # Use WebClient for progress visibility on large downloads
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('User-Agent', "windbu-installer/1.0 (PowerShell)")
    $wc.DownloadFile($url, $gzPath)
    $gzSize = (Get-Item -LiteralPath $gzPath).Length
    if ($gzSize -lt 10MB) {
      Write-Host "  Downloaded file too small ($gzSize bytes) - probably a 404 page. Trying next URL..." -ForegroundColor Yellow
      Remove-Item -LiteralPath $gzPath -Force -ErrorAction SilentlyContinue
      continue
    }
    Write-Host "  Downloaded $([math]::Round($gzSize/1MB)) MB (gzipped)"
    $downloaded = $true
    break
  } catch {
    Write-Host "  Failed: $($_.Exception.Message)" -ForegroundColor Yellow
    continue
  }
}

if (-not $downloaded) {
  Write-Host ''
  Write-Host 'All download mirrors failed.' -ForegroundColor Red
  Write-Host 'Install Windsurf from https://windsurf.com to get the Language Server bundled,'
  Write-Host 'or pass -Version <version> with a known-good version number.'
  exit 1
}

# Decompress gz -> exe
Write-Host "Decompressing..."
try {
  $gzStream = [System.IO.File]::OpenRead($gzPath)
  $gz = New-Object System.IO.Compression.GZipStream($gzStream, [System.IO.Compression.CompressionMode]::Decompress)
  $out = [System.IO.File]::Create($lsExe)
  $gz.CopyTo($out)
  $out.Close(); $gz.Close(); $gzStream.Close()
} catch {
  Write-Host "Decompression failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Remove-Item -LiteralPath $gzPath -Force -ErrorAction SilentlyContinue
}

$exeSize = (Get-Item -LiteralPath $lsExe).Length
if ($exeSize -lt 50MB) {
  Write-Host "Extracted file too small ($([math]::Round($exeSize/1MB,2)) MB) - aborting." -ForegroundColor Red
  Remove-Item -LiteralPath $lsExe -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host "Language Server installed: $lsExe ($([math]::Round($exeSize/1MB)) MB)" -ForegroundColor Green
Write-Output $lsExe
