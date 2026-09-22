/* ============================================================
   PS 插件全量独立核查器（无需 Photoshop）
   用法：node ps-plugin/audit/verify-all.js
   逐项验证并打印证据，任何 FAIL 都会让进程以 1 退出。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');            // 仓库根
const PLUGIN = path.join(ROOT, 'ps-plugin');
const SRC = path.join(PLUGIN, 'com.figmatoolbox.ps');        // 插件源码
const EXT = path.join(process.env.APPDATA || '', 'Adobe', 'CEP', 'extensions', 'com.figmatoolbox.ps');

let pass = 0, fail = 0;
const results = [];
function ok(cond, label, evidence) {
  if (cond) { pass++; results.push(['PASS', label, evidence]); }
  else { fail++; results.push(['FAIL', label, evidence]); }
}
function section(name) { results.push(['----', name, '']); }

/* ---------- A. 文件与安装状态 ---------- */
section('A. 文件与安装');
const files = ['.debug', 'CSXS/manifest.xml', 'index.html', 'js/CSInterface.js', 'jsx/host.jsx'];
for (const f of files) {
  const a = path.join(SRC, f);
  const b = path.join(EXT, f);
  const ea = fs.existsSync(a), eb = fs.existsSync(b);
  ok(ea, '源码存在 ' + f);
  if (!ea) continue;
  if (eb) {
    const ha = fs.readFileSync(a), hb = fs.readFileSync(b);
    ok(ha.equals(hb), '已安装副本与源码逐字节一致 ' + f, ha.length + 'B');
  } else {
    ok(false, '已安装副本缺失 ' + f, EXT);
  }
}

/* ---------- B. manifest ---------- */
section('B. manifest（PS 2019+ 兼容声明）');
const manifest = fs.readFileSync(path.join(SRC, 'CSXS/manifest.xml'), 'utf8');
const mv = (manifest.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
const ev = (manifest.match(/<Extension Id="[^"]+" Version="([^"]+)"/) || [])[1];
ok(!!mv && mv === ev, 'bundle 与 extension 版本一致', mv + ' / ' + ev);
ok(/<Host Name="PHSP" Version="\[20\.0,/.test(manifest) && /<Host Name="PHXS" Version="\[20\.0,/.test(manifest),
  'Host 版本下界为 20.0（PS 2019）', (manifest.match(/Version="\[[^\]]+\]"/g) || []).join(' '));
ok(/<RequiredRuntime Name="CSXS" Version="9\.0"\/>/.test(manifest), 'CEPS 运行时声明 9.0');
ok(/<MainPath>\.\/index\.html<\/MainPath>/.test(manifest), 'MainPath 指向 index.html');
const scriptPath = (manifest.match(/<ScriptPath>([^<]+)<\/ScriptPath>/) || [])[1];
ok(scriptPath === './jsx/host.jsx', 'ScriptPath 指向 ./jsx/host.jsx', scriptPath || '(缺失)');
ok(fs.existsSync(path.join(SRC, scriptPath.replace('./', ''))), 'ScriptPath 文件真实存在');
ok(/<AutoVisible>true<\/AutoVisible>/.test(manifest), 'AutoVisible 开启');
ok(/<Type>Panel<\/Type>/.test(manifest), '面板类型 Panel');

/* ---------- C. 宿主 host.jsx ---------- */
section('C. 宿主 host.jsx（ExtendScript/ES3）');
const hostRaw = fs.readFileSync(path.join(SRC, 'jsx/host.jsx'));
const hostSrc = hostRaw.toString('utf8');
ok(hostRaw[0] !== 0xef, '无 UTF-8 BOM（中文 Windows 下 ExtendScript 会按 GBK 误读）');
ok(/^[\x00-\x7f]*$/.test(hostSrc), '纯 ASCII 源码（消除编码类故障）');
const hostCode = hostSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const es3 = [
  [/\b(let|const)\b/, 'let/const'], [/=>/, '箭头函数'], [/`/, '模板字符串'],
  [/\?\./, '可选链'], [/\?\?/, '空值合并'], [/catch\s*\{/, '无绑定 catch'],
  [/\.forEach\(|\.map\(|\.filter\(|\.reduce\(|\.indexOf\(|\.includes\(/, 'ES5+ 数组方法'],
  [/,\s*[}\]]/, '字面量尾逗号'], [/\.\.\./, '展开符'],
];
es3.forEach(([re, n]) => ok(!re.test(hostCode), 'ES3 合规：无 ' + n));

const reserved = /[\{,]\s*(class|default|delete|function|in|do|if|else|for|while|return|this|with|var|case|switch|throw|try|catch|finally|break|continue|instanceof|new|typeof|void|enum|export|import|extends|super|const|let|yield|char|int|byte|long|float|double|boolean|final|native|short|static|public|private|protected|abstract|goto|synchronized|throws|transient|volatile|package|implements|interface)\s*:/.exec(hostCode);
ok(!reserved, 'ES3 合规：无保留字作对象键名', reserved ? reserved[0] : '');

const apiNames = [...hostCode.matchAll(/'([a-z-]+)':\s*(function|applyFontMix|applyAutoKerning)/g)].map((m) => m[1]);
const expectedApi = ['font-mixer', 'detect-font', 'auto-kerning', 'list-fonts', 'sel-sig', 'pick-color', 'diag', 'selftest', 'probe-write', 'ping'];
ok(expectedApi.every((n) => apiNames.includes(n)), '宿主 API 表齐全', apiNames.sort().join(', '));
ok(/\$\.global\.cephostDispatch\s*=\s*cephostDispatch/.test(hostCode), '显式发布到 $.global（不依赖 CEP ScriptPath 自动加载）');

/* 运行时冒烟：用桩对象模拟 Photoshop */
function desc() {
  const s = {};
  return {
    putDouble: (k, v) => { s[k] = v; }, putInteger: (k, v) => { s[k] = v; }, putString: (k, v) => { s[k] = v; },
    putUnitDouble: (k, u, v) => { s[k] = v; }, putObject: (k, t, o) => { s[k] = o; },
    putReference: (k, r) => { s[k] = r; }, putEnumerated: (k, c, v) => { s[k] = v; }, putList: (k, l) => { s[k] = l; },
    hasKey: (k) => Object.prototype.hasOwnProperty.call(s, k),
    getString: (k) => s[k], getInteger: (k) => s[k], getDouble: (k) => s[k],
    getUnitDoubleValue: (k) => s[k], getObjectValue: (k) => s[k], getList: () => ({ count: 0 }),
  };
}
const sandbox = {
  $: { global: {}, evalFile() {} },
  ActionDescriptor: function () { return desc(); },
  ActionReference: function () { return { putIdentifier() {}, putIndex() {} }; },
  ActionList: function () { return { putObject() {} }; },
  executeActionGet: () => ({ getObjectValue: () => ({ getList: () => ({ count: 0, getObjectValue: () => desc() }) }) }),
  executeAction: () => {}, DialogModes: { NO: 3 }, LayerKind: { TEXT: 2 },
  UnitValue: function (v, u) { return { value: v, units: u }; },
  SaveOptions: { DONOTSAVECHANGES: 2 }, NewDocumentMode: { RGB: 3 }, DocumentFill: { TRANSPARENT: 3 },
  stringIDToTypeID: (k) => k.charCodeAt(0) * 65536 + k.length,
  charIDToTypeID: (k) => k.charCodeAt(0) * 65536 + k.length,
  AutoKernType: { MANUAL: 1, METRICS: 2, OPTICAL: 3 },
  SolidColor: function () { this.rgb = { red: 0, green: 0, blue: 0 }; },
  app: {
    fonts: [
      { family: 'PingFang SC', style: 'Regular', postScriptName: 'PingFangSC-Regular' },
      { family: 'PingFang SC', style: 'Bold', postScriptName: 'PingFangSC-Bold' },
      { family: 'Inter', style: 'Regular', postScriptName: 'Inter-Regular' },
    ],
    activeDocument: { activeLayers: [{ id: 7, itemIndex: 1, typename: 'ArtLayer', name: 'l', kind: 2, textItem: { contents: 'hello 世界' } }] },
    documents: { length: 0, add: () => { throw new Error('not used in this check'); } },
    showColorPicker: () => false,
    foregroundColor: null,
  },
  isNaN, isFinite, Math, JSON: undefined,
};
vm.createContext(sandbox);
let loadErr = null;
try { vm.runInContext(hostSrc, sandbox, { filename: 'host.jsx' }); } catch (e) { loadErr = e; }
ok(!loadErr, '宿主整体求值无异常', loadErr ? loadErr.message : '');
const g = sandbox.$ && sandbox.$.global.cephostDispatch;
ok(typeof g === 'function', '入口可从 $.global 取到', typeof g);
if (typeof g === 'function') {
  for (const t of expectedApi) {
    let r = null, err = null;
    try { r = JSON.parse(g(t, '')); } catch (e) { err = e.message; }
    ok(!err && r && typeof r === 'object', 'API 可调用且返回合法 JSON：' + t, err || JSON.stringify(r).slice(0, 60));
  }
  let r = JSON.parse(g('list-fonts', ''));
  ok(Array.isArray(r.families) && r.families.length === 2, 'list-fonts 家族归并正确', JSON.stringify(r.families.map((f) => f.family)));
}

/* ---------- D. 面板 index.html ---------- */
section('D. 面板 index.html');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const inlineBodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(inlineBodies.length === 1, '内联脚本只有一段', String(inlineBodies.length));
const inline = inlineBodies[0] || '';
ok(/<script src="js\/CSInterface\.js"><\/script>/.test(html), '引入了 CSInterface.js（历史故障点）');
ok(/try \{ cs = new CSInterface\(\); \} catch/.test(html), 'CSInterface 构造失败不再连累整个面板');

const tmp = path.join(__dirname, '.inline-check.js');
fs.writeFileSync(tmp, inline);
const chk = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);
ok(chk.status === 0, '内联脚本语法通过', (chk.stderr || '').split('\n')[0]);

const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const refs = new Set();
for (const m of inline.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1]);
for (const m of inline.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1]);
const missingIds = [...refs].filter((r) => !ids.has(r) && r !== 'toast');
ok(missingIds.length === 0, '所有 $()/getElementById 引用都能在 DOM 找到', missingIds.join(', ') || 'none');

const tabs = [...html.matchAll(/class="tab-btn[^"]*" data-tab="([\w-]+)"/g)].map((m) => m[1]);
ok(tabs.length === 1 && tabs[0] === 'font', '只剩「字体混排」一个标签页', tabs.join(','));
const panels = [...html.matchAll(/<section class="panel[^"]*" id="([\w-]+)"/g)].map((m) => m[1]);
ok(panels.length === 1 && panels[0] === 'font', 'DOM 中只有一个 panel', panels.join(','));

const removedWords = ['bulk-style', 'detect-style', 'skew', 'export-btn', 'exp-status', 'cornerRadius', 'radiusOn', 'stylePresets', 'gp-stop', 'buildZip'];
const leftovers = removedWords.filter((w) => inline.includes(w) || html.includes(w));
ok(leftovers.length === 0, '已删功能（批量样式/斜切/导出/圆角）无残留引用', leftovers.join(', ') || 'none');

// 半分按钮与同步颜色开关（syncColor）：左半带颜色、右半不带，方案记录开关状态
ok(/id="font-apply-color"/.test(html) && /id="font-apply-nocolor"/.test(html), '应用按钮已拆分为左右两半');
ok(/<span class="sep"[^>]*>\|<\/span>/.test(html), '两半之间有 "|" 分隔符');
ok(/sendFontMix\(true\)/.test(inline) && /sendFontMix\(false\)/.test(inline), '两半分别调用 sendFontMix(true/false)');
ok(/syncColor: !!withColor/.test(inline), '发送时带 syncColor 开关');
ok(/if \(withColor\)/.test(inline), '关闭时根本不发颜色字段（而不是发空色）');
ok(/lastSyncColor = p\.syncColor === true/.test(inline), '方案回填时 syncColor 缺省按关闭处理（旧方案兼容）');
ok(/args\.syncColor === false \? null : args\.cnColor/.test(inline) === false, 'sanity: 宿主参数不应出现在面板代码里');
const hostSrc2 = fs.readFileSync(path.join(SRC, 'jsx', 'host.jsx'), 'utf8');
ok(/args\.syncColor === false \? null : args\.cnColor/.test(hostSrc2), '宿主：关闭时不构建颜色键');
ok(/args\.syncColor === false \? null : \(isCJK \? args\.cnColor : args\.enColor\)/.test(hostSrc2), '容岝：整层兜底也尊重开关');

// 符号归属开关（symSide）：两卡片互斥按钮、三态语义、配置透传、方案与旧方案兼容
ok(/id="sym-cn"/.test(html) && /id="sym-en"/.test(html), '中/英卡片各有符号归属按钮');
ok(/symSide === 'cn' \? '' : 'cn'/.test(inline), '符号用中文：三态切换（再点回自动）');
ok(/symSide === 'en' \? '' : 'en'/.test(inline), '符号用英文：三态切换（再点回自动）');
ok(/if \(symSide\) cfg\.symSide = symSide/.test(inline), 'auto 时不发 symSide（宿主缺省即自动）');
ok(/setSymSide\(p\.symSide \|\| ''/.test(inline), '方案回填 symSide，缺省按自动（旧方案兼容）');
ok(/function sideOfChar\(ch, symSide\)/.test(hostSrc2), '宿主：符号归属入口 sideOfChar 存在');
ok(/isSymbolChar\(ch\)/.test(hostSrc2) && /symSide === 'cn'/.test(hostSrc2) && /symSide === 'en'/.test(hostSrc2), '宿主：符号三分类（仅符号跟随开关）');
ok(/segmentsOf\(text, symSide\)/.test(hostSrc2), '宿主：分区函数感知 symSide');
ok(/segmentsOf\(text\.substring\(rr\.from, Math\.min\(rr\.to, text\.length\)\), 'auto'\)/.test(hostSrc2), '宿主：识别聚合固定 auto（识别不受开关影响）');
ok(/segmentsOf\(text, args\.symSide\)/.test(hostSrc2), '宿主：整层兜底感知 symSide');

/* ---------- E. 双端消息协议对账 ---------- */
section('E. UI ↔ 宿主 协议对账');
const uiSent = new Set([...inline.matchAll(/send\(\{ type: '([a-z-]+)'/g)].map((m) => m[1]));
const uiToHost = [...uiSent].filter((t) => t !== 'storage-load' && t !== 'storage-save' && t !== 'resize' && t !== 'notify');
const unmapped = uiToHost.filter((t) => !expectedApi.includes(t));
ok(unmapped.length === 0, 'UI 发出的每个请求宿主都有对应 API', unmapped.join(', ') || uiToHost.sort().join(', '));

const callHostTypes = [...inline.matchAll(/callHost\('([a-z-]+)'/g)].map((m) => m[1]);
const unmapped2 = [...new Set(callHostTypes)].filter((t) => !expectedApi.includes(t));
ok(unmapped2.length === 0, 'callHost 直接用到的类型都在宿主 API 内', unmapped2.join(', ') || [...new Set(callHostTypes)].sort().join(', '));

const hostMsgBranches = [...inline.matchAll(/msg\.type === '([a-z-]+)'/g)].map((m) => m[1]);
const produced = [...inline.matchAll(/handleHostMsg\(\{ type: '([a-z-]+)'/g)].map((m) => m[1]);
const unhandled = [...new Set(produced)].filter((t) => !hostMsgBranches.includes(t));
ok(unhandled.length === 0, '面板给自己构造的每种回包都有处理分支', unhandled.join(', ') || [...new Set(produced)].sort().join(', '));

/* ---------- E3. 空选区反馈协议（emptyReason/emptyLayer） ---------- */
section('E3. 空选区反馈协议');
ok(/emptyReason = src\.refs\.length \? 'no-text-layer' : 'no-selection'/.test(hostSrc), '宿主: detect/font-mixer 的空结果带 emptyReason');
ok(/emptyReason = 'empty-text'/.test(hostSrc), '宿主: 空文本层带 emptyReason=empty-text');
ok(/out\.emptyLayer = src\.refs\.length \? String\(src\.refs\[0\]\.name \|\| '\(unnamed\)'\)/.test(hostSrc), '宿主: 空结果带层名 emptyLayer');
ok(/emptyReason === 'no-selection'/.test(inline), '面板: 空结果的三种提示都存在（no-selection）');
ok(/emptyReason === 'no-text-layer'/.test(inline), '面板: 空结果的三种提示都存在（no-text-layer）');
ok(/emptyReason === 'empty-text'/.test(inline), '面板: 空结果的三种提示都存在（empty-text）');
ok(/getDouble\(S\('size'\)\)/.test(hostSrc), '宿主: 字号读取带 getDouble 兜底（非 unit double 也能读）');
ok(/msg\.emptyLayer \? '[^']*' \+ msg\.emptyLayer/.test(inline), '面板: 应用空提示带上层名');

/* ---------- F. 宿主加载器表达式（本轮 bug 所在处） ---------- */
section('F. 宿主加载器表达式');
const block = inline.slice(inline.indexOf('    const CEP ='), inline.indexOf('setTimeout(() => ensureHost(), 200);'));
const bridge = new Function('window', 'cs', 'SystemPath', 'document', 'figmaNotify', 'setTimeout',
  block + '\n; return { hostLoaderExpr: hostLoaderExpr, hostCallExpr: hostCallExpr };')(
  {}, { getSystemPath: () => 'C:\\x\\ext', evalScript: () => {} }, { EXTENSION: 'extension' }, { getElementById: () => null }, () => {}, () => {});
const loader = bridge.hostLoaderExpr();
const callExpr = bridge.hostCallExpr('font-mixer', '');
for (const [expr, name] of [[loader, '加载器'], [callExpr, '调用']]) {
  let e = null; try { new Function(expr); } catch (err) { e = err.message; }
  ok(!e, name + '表达式可解析', e || '');
}
ok(loader.includes('jsx/host.jsx') || loader.includes('jsx\\\\host.jsx'), '加载器指向真实的 host.jsx 路径');
ok(loader.includes('65279'), '加载器会剥离 BOM');
ok(loader.includes('$.global.cephostDispatch=cephostDispatch'), '导出名的拼写与真实函数名一致（本轮修复的 bug）');
ok(!/cephpostDispatch/.test(html), '全文件无 cephostDispatch 拼写错误');
ok(callExpr.includes('__NOHOST__'), '调用表达式带缺失宿主哨兵');

/* ---------- G. CEP 运行时环境 ---------- */
section('G. CEP 运行时环境');
const debug = fs.readFileSync(path.join(SRC, '.debug'), 'utf8');
ok(/PHXS/.test(debug) && /PHSP/.test(debug) && /Port="8092"/.test(debug), '.debug 声明了 PHXS/PHSP 且端口 8092');
for (const v of [9, 10, 11, 12, 13, 14]) {
  const q = cp.spawnSync('reg', ['query', `HKCU\\Software\\Adobe\\CSXS.${v}`, '/v', 'PlayerDebugMode'], { encoding: 'utf8' });
  const hit = /PlayerDebugMode\s+REG_SZ\s+1/.test(q.stdout || '');
  ok(hit, `PlayerDebugMode=1 (CSXS.${v})`, hit ? '' : (q.stdout || '').trim().slice(0, 40));
}

/* ---------- H. 分发产物 ---------- */
section('H. 分发产物');
const ccxFiles = fs.existsSync(path.join(PLUGIN, 'dist'))
  ? fs.readdirSync(path.join(PLUGIN, 'dist')).filter((f) => f.endsWith('.ccx')) : [];
ok(ccxFiles.length === 1, 'dist 下有且仅有一个 .ccx', ccxFiles.join(', '));
if (ccxFiles.length === 1) {
  const ccx = path.join(PLUGIN, 'dist', ccxFiles[0]);
  const vres = cp.spawnSync(path.join(PLUGIN, 'tools', 'ZXPSignCmd.exe'),
    ['-verify', ccx, '-skipOnlineRevocationChecks'], { encoding: 'utf8' });
  ok(/verified successfully/i.test((vres.stdout || '') + (vres.stderr || '')), '.ccx 签名校验通过',
    ((vres.stdout || '') + (vres.stderr || '')).trim().split('\n')[0]);
}

/* ---------- H2. 签名警告一键修复脚本 ---------- */
section('H2. 签名警告一键修复脚本');
const fixer = path.join(PLUGIN, '一键修复签名警告-Windows.cmd');
ok(fs.existsSync(fixer), '修复脚本存在', '一键修复签名警告-Windows.cmd');
if (fs.existsSync(fixer)) {
  const fx = fs.readFileSync(fixer, 'utf8');
  ok(/CSXS\.%%V/.test(fx) && /9 10 11 12 13 14/.test(fx), '脚本覆盖 CSXS.9~14');
  ok(/REG_SZ/.test(fx), '写入类型是 REG_SZ（CEP 只认字符串型 1，DWORD 无效）');
  ok(/KEY_VERIFIED/.test(fx) && /readback found NOTHING/.test(fx), '带回读校验（写入成功但读不到要报警）');
  ok(/setlocal EnableDelayedExpansion/.test(fx), '启用延迟展开（块内变量读取需要）');
  ok(!/\(all windows\) and start/.test(fx), 'echo 内的括号已用 ^( ^) 转义（防「此时不应有 and」）');
  ok(/tasklist \/FI "IMAGENAME eq Photoshop\.exe"/.test(fx), '带 Photoshop 运行检测（提醒必须完全重启）');
}

/* ---------- I. 面板运行时诊断日志 ---------- */
section('I. 面板运行时诊断');
const diagPath = path.join(EXT, 'diag.log');
if (fs.existsSync(diagPath)) {
  const log = fs.readFileSync(diagPath, 'utf8').trim().split('\n');
  const last = log.slice(-6);
  ok(true, '发现 diag.log（面板已运行过），最后几行见下', last.join(' ⏎ '));
} else {
  ok(true, '尚无 diag.log —— 面板自 v1.2.0 起尚未打开过（打开后会自动生成）', diagPath);
}

/* ---------- E2. 字段级契约：UI 读的字段宿主必须真的返回 ---------- */
section('E2. 字段级契约（undefined 类故障的根因检查）');
const hostFields = new Set();
for (const m of hostCode.matchAll(/\b(?:out|o)\.([A-Za-z_][A-Za-z0-9_]*)/g)) hostFields.add(m[1]);
for (const m of hostCode.matchAll(/(?:var\s+)?(?:out|o)\s*=\s*\{([^}]*)\}/g)) {
  for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) hostFields.add(k[1]);
}
for (const m of hostCode.matchAll(/jval\(\{([^}]*)\}\)/g)) {
  for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) hostFields.add(k[1]);
}
function bodyOf(name) {
  const i = inline.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = inline.indexOf('{', i);
  for (let k = j; k < inline.length; k++) {
    if (inline[k] === '{') d++;
    else if (inline[k] === '}') { d--; if (d === 0) return inline.slice(j, k + 1); }
  }
  return '';
}
ok(hostFields.size >= 25, '宿主输出字段可被提取', hostFields.size + ' 个: ' + [...hostFields].slice(0, 12).join(','));
for (const fn of ['showFontMixResult', 'showKerningResult', 'fillFontFromDetect', 'onFontMixStart']) {
  const body = bodyOf(fn);
  ok(!!body, '找到结果处理函数 ' + fn);
  const reads = [...new Set([...body.matchAll(/msg\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  const ghosts = reads.filter((f) => !hostFields.has(f) && f !== 'type');
  ok(ghosts.length === 0, fn + ' 只读取宿主真实返回的字段（否则界面显示 undefined）',
    ghosts.length ? '幽灵字段: ' + ghosts.join(', ') : reads.join(', '));
}
for (const fn of ['showFontMixResult', 'showKerningResult']) {
  ok(/msg\.error/.test(bodyOf(fn)), fn + ' 显式暴露 msg.error');
}

/* ---------- 输出 ---------- */
let cur = '';
for (const [st, label, ev] of results) {
  if (st === '----') { cur = label; console.log('\n=== ' + label + ' ==='); continue; }
  console.log((st === 'PASS' ? '  ✓ ' : '  ✗ ') + label + (ev ? '   [' + ev + ']' : ''));
}
console.log('\n合计：' + pass + ' 项通过 / ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
