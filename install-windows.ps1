<#
.SYNOPSIS
    「盗版PS的工具箱」Windows 一键安装 / 卸载脚本（CEP 扩展，Photoshop 2019+）
.DESCRIPTION
    1. 把 com.figmatoolbox.ps 复制到用户级 CEP 扩展目录
    2. 写入 HKCU CSXS.9~14 的 PlayerDebugMode = 1（自签扩展需要）
    全程只写当前用户（HKCU / %APPDATA%），不需要管理员权限。
.PARAMETER Uninstall
    卸载：删除扩展目录 + 清除本脚本写入的注册表值
.PARAMETER WhatIf
    演练模式：只打印将要执行的动作，不实际修改系统
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
    powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# ---------- 常量 ----------
$ExtensionId = 'com.figmatoolbox.ps'
$BrandName   = '盗版PS的工具箱'
# 脚本所在目录 = 插件源目录的父目录（脚本放在 ps-plugin/ 下）
$SourceDir   = Join-Path $PSScriptRoot 'com.figmatoolbox.ps'
$TargetDir   = Join-Path $env:APPDATA ('Adobe\CEP\extensions\' + $ExtensionId)
# PS 2019(23.x CSXS 9) ~ 最新版的全部 CSXS 键；只动本脚本关心的值
$CsxsKeys    = 9..14

function Show-Step([string]$msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Show-Ok([string]$msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Show-Warn([string]$msg) { Write-Host "  $msg" -ForegroundColor Yellow }

Write-Host ''
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " $BrandName · Windows 一键安装脚本" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ''

# ---------- 前置检查 ----------
if (-not (Test-Path (Join-Path $SourceDir 'CSXS\manifest.xml'))) {
    Write-Host "[错误] 未找到插件目录：$SourceDir" -ForegroundColor Red
    Write-Host "       请保持本脚本与 com.figmatoolbox.ps 目录在同一父目录下再运行。" -ForegroundColor Red
    exit 1
}

# ---------- 卸载 ----------
if ($Uninstall) {
    Write-Host "[卸载] $BrandName" -ForegroundColor Cyan

    if (Test-Path $TargetDir) {
        if ($PSCmdlet.ShouldProcess($TargetDir, '删除扩展目录')) {
            Remove-Item -Recurse -Force $TargetDir
            Show-Ok "已删除 $TargetDir"
        }
    } else {
        Show-Warn "扩展目录不存在（可能已卸载）：$TargetDir"
    }

    foreach ($v in $CsxsKeys) {
        $key = "HKCU:\Software\Adobe\CSXS.$v"
        if (Test-Path $key) {
            $prop = Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue
            if ($prop -and $prop.PlayerDebugMode -eq '1') {
                if ($PSCmdlet.ShouldProcess($key, '删除 PlayerDebugMode')) {
                    Remove-ItemProperty -Path $key -Name PlayerDebugMode
                    Show-Ok "已清除 $key -> PlayerDebugMode"
                }
            }
        }
    }

    Write-Host ''
    Write-Host "[完成] 卸载完成。若 Photoshop 正在运行，请重启它。" -ForegroundColor Green
    exit 0
}

# ---------- 安装 ----------
Write-Host "[安装] $BrandName -> $TargetDir" -ForegroundColor Cyan

# 1) 复制扩展（先删旧目录，保证是全新副本，不留陈旧文件）
if ($PSCmdlet.ShouldProcess($TargetDir, '复制扩展目录')) {
    if (Test-Path $TargetDir) {
        Show-Step "检测到旧版本，先移除 $TargetDir"
        Remove-Item -Recurse -Force $TargetDir
    }
    Copy-Item -Recurse -Force $SourceDir $TargetDir
    Show-Ok "扩展已复制到 $TargetDir"
}

# 2) 写入 PlayerDebugMode（HKCU，用户级，无需管理员）
foreach ($v in $CsxsKeys) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if ($PSCmdlet.ShouldProcess($key, "写入 PlayerDebugMode=1")) {
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value "1" -Force | Out-Null
        Show-Ok "PlayerDebugMode=1 -> $key"
    }
}

# ---------- 完成提示 ----------
Write-Host ''
Write-Host "[完成] 安装完成！" -ForegroundColor Green
Write-Host '  下一步：' -ForegroundColor White
Write-Host '  1. 重启 Photoshop（若正在运行，请完全退出再打开）' -ForegroundColor White
Write-Host "  2. 菜单「窗口 -> 扩展功能(Extensions) -> $BrandName」打开面板" -ForegroundColor White
Write-Host ''
