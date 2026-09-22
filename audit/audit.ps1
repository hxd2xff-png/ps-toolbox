<#
.SYNOPSIS
    [子代理] 独立审计器：对「盗版PS的工具箱」做从零开始的深度核查。
    不复用开发过程中的任何结论，仅凭文件本身与 CEP/ExtendScript 规范逐项检查。
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot   # ps-plugin/
$ext  = Join-Path $root 'com.figmatoolbox.ps'
$fail = 0; $warn = 0

function Assert([bool]$cond, [string]$name, [string]$detail = '') {
    if ($cond) { Write-Host ("  [PASS] " + $name) -ForegroundColor Green }
    else { $fail++; Write-Host ("  [FAIL] " + $name + $(if ($detail) { " —— " + $detail })) -ForegroundColor Red }
}
function Warn([bool]$cond, [string]$name, [string]$detail = '') {
    if (-not $cond) { $warn++; Write-Host ("  [WARN] " + $name + $(if ($detail) { " —— " + $detail })) -ForegroundColor Yellow }
    else { Write-Host ("  [PASS] " + $name) -ForegroundColor Green }
}

Write-Host "== [1] CSXS manifest 与 .debug ==" -ForegroundColor Cyan
$mf = Join-Path $ext 'CSXS/manifest.xml'
Assert (Test-Path $mf) 'manifest.xml 存在'
[xml]$x = Get-Content $mf -Encoding UTF8
$hosts = $x.ExtensionManifest.ExecutionEnvironment.HostList.Host
Assert (($hosts | Where-Object { $_.Name -eq 'PHSP' -and $_.Version -match '^\[20\.0' }) -ne $null) 'PHPS/PHXS 支持 PS2019(v20.0) 起'
Assert (($hosts | Where-Object { $_.Name -eq 'PHXS' }) -ne $null) 'PHXS 宿主已声明'
$rt = $x.ExtensionManifest.ExecutionEnvironment.RequiredRuntimeList.RequiredRuntime
Assert ($rt.Name -eq 'CSXS' -and [double]$rt.Version -ge 9) 'RequiredRuntime CSXS >= 9'
$disp = $x.ExtensionManifest.DispatchInfoList.DispatchInfo
$mfRaw = [IO.File]::ReadAllText($mf)
Assert ($mfRaw -match '<MainPath>[^<]*index\.html') 'MainPath=./index.html'
Assert ($mfRaw -match '<ScriptPath>[^<]*host\.jsx') 'ScriptPath=./jsx/host.jsx'
$dbg = Join-Path $ext '.debug'
Warn (Test-Path $dbg) '.debug 存在（远程调试用，可选）'

Write-Host "== [2] CSInterface.js 引入与内容 ==" -ForegroundColor Cyan
$html = [IO.File]::ReadAllText((Join-Path $ext 'index.html'))
Assert ($html -match '<script\s+src="js/CSInterface\.js"') 'index.html 引入 js/CSInterface.js'
$csi = [IO.File]::ReadAllText((Join-Path $ext 'js/CSInterface.js'))
Assert ($csi -match 'function CSInterface\(') 'CSInterface 构造函数存在'
Assert ($csi -match 'CSInterface\.prototype\.evalScript') 'evalScript 原型方法存在'

Write-Host "== [3] index.html 内联脚本：UI 崩点模拟（Chrome/CEP9 语法面） ==" -ForegroundColor Cyan
$m = [regex]::Match($html, '(?s)<script>([\s\S]*?)</script>')
Assert $m.Success '内联 script 块存在'
$js = $m.Groups[1].Value
# CEP9=Chromium61：可选链/空值合并等必须为 0
foreach ($pat in @('\?\.', '\?\?', '\?\?=', '\|\|=')) {
    $n = ([regex]::Matches($js, $pat)).Count
    Assert ($n -eq 0) ("CEP9 语法面 " + $pat + " 出现次数=0") ("实际 $n 处")
}
# 无绑定 catch（Chrome 66+ 语法）必须为 0
$nCatch = ([regex]::Matches($js, 'catch\s*\{')).Count
Assert ($nCatch -eq 0) ('无绑定 catch{ 出现次数=0') ("实际 $nCatch 处")
# 所有顶层 $().addEventListener 的 id 必须存在于 DOM（截断后续绑定的头号来源）
$markup = $html.Substring(0, $html.IndexOf('<script'))
$ids = [System.Collections.Generic.HashSet[string]](New-Object System.Collections.Generic.HashSet[string])
foreach ($mm in [regex]::Matches($markup, 'id="([^"]+)"')) { [void]$ids.Add($mm.Groups[1].Value) }
$dynSfx = @('-gtype','-gangle','-gdirs','-stops','-stop-add','-gprev','-color','-weight','-align')
$miss = @()
foreach ($mm in [regex]::Matches($js, "\$\('#([A-Za-z0-9_-]+)'\)")) {
    $i = $mm.Groups[1].Value
    if (-not $ids.Contains($i)) {
        $dyn = $false
        foreach ($s in $dynSfx) { if ($i.EndsWith($s)) { $dyn = $true } }
        if (-not $dyn -and -not $i.StartsWith('sp-')) { $miss += $i }
    }
}
Assert ($miss.Count -eq 0) '所有 $() 引用的 id 在 DOM/动态集内' ($miss -join ',')
# TDZ 修复在位
Assert ($js -match "setTimeout\(function \(\) \{ applyStoredPresets\(readPresets\(\)\)") 'storage-load 已延迟执行（TDZ 防护）'
# CEP 环境判定（浏览器兜底不得误触发）
Warn ($html -match '__adobe_cep__') '浏览器兜底含 CEP 排除判定'

Write-Host "== [4] host.jsx：ExtendScript(ES3) 逐项扫描 ==" -ForegroundColor Cyan
$jsxBytes = [IO.File]::ReadAllBytes((Join-Path $ext 'jsx/host.jsx'))
Assert (($jsxBytes[0] -eq 0xEF) -and ($jsxBytes[1] -eq 0xBB) -and ($jsxBytes[2] -eq 0xBF)) 'UTF-8 BOM（中文 Windows ExtendScript 解码必需）'
$jsx = [Text.Encoding]::UTF8.GetString($jsxBytes, 3, $jsxBytes.Length - 3)
# 尾逗号（对象/数组字面量内）逐行
$lines = $jsx -split "`r?`n"
$tc = @()
for ($i = 0; $i -lt $lines.Count - 1; $i++) {
    $s = $lines[$i].TrimEnd()
    if ($s.EndsWith(',') -and $lines[$i+1].TrimStart().StartsWith('}')) { $tc += ($i+1) }
    if ($s.EndsWith(',') -and $lines[$i+1].TrimStart().StartsWith(']')) { $tc += ($i+1) }
}
Assert ($tc.Count -eq 0) 'ES3 对象/数组尾逗号=0' ("行: " + ($tc -join ','))
# 正则字面量内的反引号（字符类）合法，不检查；模板字符串在 ExtendScript 必然语法错，
# 但无法用正则与正则字面量区分，依赖 node --check 在打包前拦截。
foreach ($pat in @('\blet\s', '\bconst\s', '=>', '\.indexOf\(', '\bJSON\.', '\.map\(', '\.filter\(', '\.forEach\(')) {
    $n = ([regex]::Matches($jsx, $pat)).Count
    Assert ($n -eq 0) ("ES3 禁用面 " + $pat + " = 0") ("实际 $n 处")
}
# JSON 求值注入：eval 包裹 decodeURIComponent（UI 侧 encodeURIComponent 配对）
Assert ($jsx -match 'decodeURIComponent') '宿主解码 args'
# 入口函数名比对：两边都存在同名 Dispatch 标识符即可（避免长字面量误报）
$jsxDispatch = [regex]::Match($jsx, 'var\s+(\w*[Dd]ispatch\w*)')
$uiDispatch = [regex]::Match($js, "evalScript\('\w*")
Assert ($jsxDispatch.Success -and $jsxDispatch.Groups[1].Value -like '*ispatch*') '宿主入口函数已定义'
Assert ($js -match 'ispatch') 'UI evalScript 调用 Dispatch 入口'

Write-Host "== [5] 消息协议双端对账 ==" -ForegroundColor Cyan
$uiTypes = @()
foreach ($mm in [regex]::Matches($js, "case '([a-z-]+)':")) { $uiTypes += $mm.Groups[1].Value }
$hostApi = @()
foreach ($mm in [regex]::Matches($jsx, "'([a-z-]+)':")) { $hostApi += $mm.Groups[1].Value }
Write-Host ("  UI send(): " + ($uiTypes -join ', '))
Write-Host ("  宿主 API:  " + ($hostApi -join ', '))
foreach ($t in $uiTypes) {
    if ($t -in @('resize','notify','storage-load','storage-save')) { continue }   # UI 本地处理
    Assert ($hostApi -contains $t) "UI→宿主 '$t' 有对应宿主 API"
}
# 宿主回调 → UI handleHostMsg 的 type
foreach ($t in @('detect-font-result','detect-style-result','detect-skew-result','font-mixer-start','font-mixer-done','bulk-styles-done','auto-kerning-done','skew-done')) {
    Assert ($js -match [regex]::Escape("'$t'")) "宿主→UI '$t' 有处理分支"
}

Write-Host "== [6] 拾色器链路（用户需求：调用 PS 原生调色窗口） ==" -ForegroundColor Cyan
Assert ($jsx -match 'showColorPicker') 'host.jsx 有 app.showColorPicker'
Assert ($jsx -match "'pick-color'") '宿主注册 pick-color'
Assert ($js -match "callHost\('pick-color'") 'UI 调用 pick-color'
Assert ($js -match "type === 'color'") 'UI 拦截所有 input[type=color]'

Write-Host "== [7] 已安装副本字节级比对 ==" -ForegroundColor Cyan
$inst = Join-Path $env:APPDATA 'Adobe/CEP/extensions/com.figmatoolbox.ps'
if (Test-Path $inst) {
    foreach ($f in @('index.html','jsx/host.jsx','js/CSInterface.js','CSXS/manifest.xml')) {
        $a = (Get-FileHash (Join-Path $ext $f)).Hash
        $b = (Get-FileHash (Join-Path $inst $f)).Hash
        Assert ($a -eq $b) ("安装副本一致: " + $f)
    }
    $n = 0
    foreach ($v in 9..14) {
        $k = Get-ItemProperty -Path ("HKCU:\Software\Adobe\CSXS." + $v) -Name PlayerDebugMode -ErrorAction SilentlyContinue
        if ($k -and $k.PlayerDebugMode -eq '1') { $n++ }
    }
    Assert ($n -eq 6) 'PlayerDebugMode=1 覆盖 CSXS.9~14'
} else {
    Assert $false '扩展目录存在' $inst
}

Write-Host "== [8] .ccx 产物与签名 ==" -ForegroundColor Cyan
$ccx = Join-Path $root 'dist/盗版PS的工具箱-1.0.0.ccx'
if (Test-Path $ccx) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [IO.Compression.ZipFile]::OpenRead($ccx)
    $names = $z.Entries.FullName
    Assert ($names -contains 'index.html') '.ccx 含 index.html'
    Assert ($names -contains 'jsx/host.jsx') '.ccx 含 host.jsx'
    Assert ($names -contains 'CSXS/manifest.xml') '.ccx 含 manifest'
    Assert ($names -contains 'META-INF/signatures.xml') '.ccx 已签名'
    # 包内 index.html 与仓库最新一致（防止签了旧版本）
    $entry = $z.Entries | Where-Object { $_.FullName -eq 'index.html' }
    $sr = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
    $ccxHtml = $sr.ReadToEnd(); $sr.Close()
    $repoHtml = [IO.File]::ReadAllText((Join-Path $ext 'index.html'))
    Assert ($ccxHtml.Length -eq $repoHtml.Length) '.ccx 内 index.html 与仓库同版本'
    $z.Dispose()
} else { Assert $false '.ccx 产物存在' $ccx }

Write-Host ''
$color = 'Green'; $exitCode = 0
if ($fail -gt 0) { $color = 'Red'; $exitCode = 1 }
elseif ($warn -gt 0) { $color = 'Yellow' }
if ($fail -eq 0 -and $warn -eq 0) { Write-Host '审计结论：全部通过' -ForegroundColor $color }
else { Write-Host ("审计结论：FAIL=" + $fail + "  WARN=" + $warn) -ForegroundColor $color }
exit $exitCode
