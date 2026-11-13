[CmdletBinding()]
param(
    [switch]$KeepExistingPlugin
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'com.figmatoolbox.ps'
$extensionsRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target = Join-Path $extensionsRoot 'com.figmatoolbox.ps'
$registryPath = 'HKCU:\Software\Adobe\CSXS.9'

if (-not (Test-Path -LiteralPath (Join-Path $source 'CSXS\manifest.xml'))) {
    throw "源插件目录无效：$source"
}

New-Item -ItemType Directory -Path $extensionsRoot -Force | Out-Null

if ((Test-Path -LiteralPath $target) -and -not $KeepExistingPlugin) {
    $resolvedTarget = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $target).Path)
    $resolvedRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $extensionsRoot).Path)
    if (-not $resolvedTarget.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "目标路径校验失败：$resolvedTarget"
    }
    [IO.Directory]::Delete($resolvedTarget, $true)
}

if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
}
Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $target -Recurse -Force

New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name 'PlayerDebugMode' -PropertyType String -Value '1' -Force | Out-Null

$sourceFiles = @(Get-ChildItem -LiteralPath $source -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($source.Length).ToLowerInvariant() })
$targetFiles = @(Get-ChildItem -LiteralPath $target -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($target.Length).ToLowerInvariant() })
$missing = @($sourceFiles | Where-Object { $_ -notin $targetFiles })
$debugMode = (Get-ItemProperty -Path $registryPath -Name 'PlayerDebugMode').PlayerDebugMode

if ($missing.Count -gt 0 -or $debugMode -ne '1') {
    throw "安装校验失败：缺少文件 $($missing.Count)，PlayerDebugMode=$debugMode"
}

Write-Host 'Photoshop 插件安装完成。' -ForegroundColor Green
Write-Host "插件目录：$target"
Write-Host "开发加载：$registryPath\PlayerDebugMode = $debugMode"
Write-Host '请重启 Photoshop 后打开 CEP 扩展。'

