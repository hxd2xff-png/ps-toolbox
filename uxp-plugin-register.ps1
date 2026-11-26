[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [string]$ManifestPath,
  [string]$FolderName = 'com.figmatoolbox.ps.uxp',
  [string]$PluginId = 'com.figmatoolbox.ps.uxp'
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Info-Path {
  Join-Path $env:APPDATA 'Adobe\UXP\PluginsInfo\v1\PS.json'
}

function Read-Plugin-List([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = [IO.File]::ReadAllText($path)
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return ($text | ConvertFrom-Json)
}

function Write-Json-Atomic([string]$path, $payload) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $backup = $null
  if (Test-Path -LiteralPath $path) {
    $backup = $path + '.bak'
    Copy-Item -LiteralPath $path -Destination $backup -Force
  }
  $tmp = $path + '.tmp'
  $json = $payload | ConvertTo-Json -Depth 10 -Compress
  [IO.File]::WriteAllText($tmp, $json, $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return $backup
}

$infoPath = Get-Info-Path

if ($Action -eq 'remove') {
  if (-not (Test-Path -LiteralPath $infoPath)) {
    Write-Output 'Plugin list not present; nothing to unregister.'
    exit 0
  }
  try {
    $root = Read-Plugin-List $infoPath
  } catch {
    Write-Warning 'PS.json is not valid JSON; left untouched.'
    exit 0
  }
  if ($null -eq $root) {
    Write-Output 'Plugin list is empty; nothing to unregister.'
    exit 0
  }
  $kept = New-Object System.Collections.ArrayList
  foreach ($entry in @($root.plugins)) {
    if ($null -eq $entry) { continue }
    if ([string]$entry.pluginId -ne $PluginId) { [void]$kept.Add($entry) }
  }
  if ($kept.Count -eq @($root.plugins).Count) {
    Write-Output 'Plugin was not registered; nothing to unregister.'
    exit 0
  }
  $payload = [pscustomobject][ordered]@{ plugins = @($kept) }
  Write-Json-Atomic $infoPath $payload | Out-Null
  Write-Output ('Removed plugin entry: ' + $PluginId)
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ManifestPath) -or -not (Test-Path -LiteralPath $ManifestPath)) {
  Write-Error ('Manifest not found: ' + $ManifestPath)
  exit 1
}

try {
  $manifest = [IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
} catch {
  Write-Error ('Manifest is not valid JSON: ' + $ManifestPath)
  exit 1
}

if ([string]$manifest.id -ne $PluginId) {
  Write-Error ('Manifest id is not ' + $PluginId)
  exit 1
}

$entry = [pscustomobject][ordered]@{
  hostMinVersion = [string]$manifest.host.minVersion
  name           = [string]$manifest.name
  path           = '$localPlugins\External\' + $FolderName
  pluginId       = [string]$manifest.id
  status         = 'enabled'
  type           = 'uxp'
  versionString  = [string]$manifest.version
}

$backup = $null
try {
  $root = $null
  try {
    $root = Read-Plugin-List $infoPath
  } catch {
    throw ('PS.json is not valid JSON; refusing to overwrite it: ' + $infoPath)
  }

  $list = New-Object System.Collections.ArrayList
  $replaced = $false
  if ($null -ne $root) {
    foreach ($existing in @($root.plugins)) {
      if ($null -eq $existing) { continue }
      if ([string]$existing.pluginId -eq $PluginId) {
        if (-not $replaced) {
          [void]$list.Add($entry)
          $replaced = $true
        }
      } else {
        [void]$list.Add($existing)
      }
    }
  }
  if (-not $replaced) { [void]$list.Add($entry) }

  $payload = [pscustomobject][ordered]@{ plugins = @($list) }
  $backup = Write-Json-Atomic $infoPath $payload

  $verify = [IO.File]::ReadAllText($infoPath) | ConvertFrom-Json
  $match = @($verify.plugins) | Where-Object { [string]$_.pluginId -eq $PluginId }
  if (-not $match) { throw 'Plugin entry is missing after write.' }

  Write-Output ('Registered plugin: ' + $PluginId + ' -> ' + $entry.path)
  exit 0
} catch {
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $backup -Destination $infoPath -Force
  }
  Write-Error ('Could not update the Photoshop plugin list: ' + $_.Exception.Message)
  exit 1
}
