[CmdletBinding()]
param(
    [switch]$RemoveDebugMode
)

$ErrorActionPreference = 'Stop'
$extensionsRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$target = Join-Path $extensionsRoot 'com.figmatoolbox.ps'
$registryPaths = @(9..19 | ForEach-Object { "HKCU:\Software\Adobe\CSXS.$_" })

if (Test-Path -LiteralPath $target) {
    $resolvedTarget = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $target).Path)
    $resolvedRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $extensionsRoot).Path)
    if (-not $resolvedTarget.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "目标路径校验失败：$resolvedTarget"
    }
    [IO.Directory]::Delete($resolvedTarget, $true)
    Write-Host "已删除插件目录：$target" -ForegroundColor Green
}

if ($RemoveDebugMode) {
    foreach ($registryPath in $registryPaths) {
        if (-not (Test-Path -LiteralPath $registryPath)) { continue }
        $entry = Get-ItemProperty -Path $registryPath
        if ($null -ne $entry.PSObject.Properties['PlayerDebugMode']) {
            Remove-ItemProperty -Path $registryPath -Name 'PlayerDebugMode'
            Write-Host "已删除：$registryPath\PlayerDebugMode" -ForegroundColor Green
        }
    }
}

Write-Host '卸载处理完成。请重启 Photoshop。'

