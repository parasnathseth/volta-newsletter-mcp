# Builds dist/volta-newsletter-skill.zip with standard forward-slash entry names
# (Compress-Archive on Windows PowerShell 5.1 writes backslashes, which some tools reject).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'skill/volta-newsletter'
$dist = Join-Path $root 'dist'
$zipPath = Join-Path $dist 'volta-newsletter-skill.zip'
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
    $rel = 'volta-newsletter/' + $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
Write-Host "Built $zipPath"
