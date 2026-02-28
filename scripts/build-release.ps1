param(
  [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repoRoot "manifest.json"

if (!(Test-Path -LiteralPath $manifestPath)) {
  throw "manifest.json not found at: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = [string]$manifest.version
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "Version is empty. Pass -Version or set manifest.version."
}

$allowed = @(
  "manifest.json",
  "background.js",
  "content.js",
  "page-bridge.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
)

$releaseDir = Join-Path $repoRoot "release"
$zipName = "chatgpt_exporter-v$Version.zip"
$zipPath = Join-Path $releaseDir $zipName
$tmpDir = Join-Path $repoRoot ".tmp_release_package"

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
if (Test-Path -LiteralPath $tmpDir) {
  Remove-Item -LiteralPath $tmpDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  foreach ($relativePath in $allowed) {
    $sourcePath = Join-Path $repoRoot $relativePath
    if (!(Test-Path -LiteralPath $sourcePath)) {
      throw "Missing release file: $relativePath"
    }

    $destPath = Join-Path $tmpDir $relativePath
    $destDir = Split-Path -Parent $destPath
    if ($destDir -and !(Test-Path -LiteralPath $destDir)) {
      New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    Copy-Item -LiteralPath $sourcePath -Destination $destPath -Force
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $tmpDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entries = @(
      $zip.Entries |
        Where-Object { -not $_.FullName.EndsWith("/") } |
        ForEach-Object { $_.FullName.Replace("\", "/") }
    )
  } finally {
    $zip.Dispose()
  }

  $extra = @($entries | Where-Object { $_ -notin $allowed })
  $missing = @($allowed | Where-Object { $_ -notin $entries })

  if ($extra.Count -gt 0 -or $missing.Count -gt 0) {
    $extraText = if ($extra.Count -gt 0) { $extra -join ", " } else { "none" }
    $missingText = if ($missing.Count -gt 0) { $missing -join ", " } else { "none" }
    throw (
      "ZIP verification failed. " +
      "Extra: " + $extraText + " | " +
      "Missing: " + $missingText
    )
  }

  $zipItem = Get-Item -LiteralPath $zipPath
  Write-Host ("Created " + $zipItem.Name + " (" + $zipItem.Length + " bytes)")
} finally {
  if (Test-Path -LiteralPath $tmpDir) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force
  }
}
