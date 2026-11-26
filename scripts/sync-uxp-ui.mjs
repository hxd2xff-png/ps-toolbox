// 以 CEP 面板为唯一 UI 源，生成 UXP 的 index.html / panel.css / cep-ui.js。
// 用法：node scripts/sync-uxp-ui.mjs
//
// 口径（2026-11-26 用户明确要求）：
//   1. CEP 的 HTML body、CSS、UI 交互脚本原样复用，不再维护第二套 UI 代码。
//   2. UXP 只允许两类差异：
//      a. panel.css 之外单独加载 uxp-compat.css（引擎兼容补丁，不含视觉规范）。
//      b. cep-ui.js 只替换 UXP 缺失的 DOM/JS 能力（Event/Option/append/按钮控件/
//         搜索框自动聚焦/host 版本号），不改变业务逻辑与界面结构。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cepPath = join(root, 'com.figmatoolbox.ps', 'index.html');
const uxpDir = join(root, 'com.figmatoolbox.ps.uxp');
const manifest = JSON.parse(readFileSync(join(uxpDir, 'manifest.json'), 'utf8'));
const hostVersion = String(manifest.version);

const cep = readFileSync(cepPath, 'utf8');

function bodyInner(source) {
  const start = source.search(/<body\b/i);
  if (start < 0) throw new Error('CEP 缺少 <body>');
  const openEnd = source.indexOf('>', start);
  const close = source.search(/<\/body\s*>/i);
  if (openEnd < 0 || close < 0) throw new Error('CEP <body> 结构不完整');
  return source.slice(openEnd + 1, close);
}

function stripScripts(source) {
  return source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

// UXP 的原生 <button> 不按 HTML 盒模型布局（文字居中、子元素不参与 flex），
// 而 CEP 的按钮是普通 Chromium 按钮。生成 UXP DOM 时把带 class 的静态按钮
// 直接降级成等价的 div[role=button]，避免运行时替换时机不稳定导致布局塌陷。
// 无 class 的“分阶段诊断”按钮保留原生外观和 disabled 行为。
function convertStaticButtons(source) {
  const tokens = /<button\b([^>]*)>|<\/button\s*>/gi;
  const stack = [];
  let out = '';
  let last = 0;
  let converted = 0;
  let match;
  while ((match = tokens.exec(source))) {
    out += source.slice(last, match.index);
    if (/^<\/button/i.test(match[0])) {
      out += stack.pop() ? '</div>' : '</button>';
    } else {
      const attrs = match[1] || '';
      const hasClass = /\bclass\s*=\s*(?:"[^"]*"|'[^']*')/i.test(attrs);
      const isDiagnose = /\bid\s*=\s*(?:"host-diagnose"|'host-diagnose')/i.test(attrs);
      const convert = hasClass && !isDiagnose;
      if (convert) {
        const clean = attrs
          .replace(/\s+type\s*=\s*(?:"button"|'button')/i, '')
          .replace(/\s+role\s*=\s*(?:"[^"]*"|'[^']*')/i, '')
          .replace(/\s+tabindex\s*=\s*(?:"[^"]*"|'[^']*')/i, '');
        out += '<div role="button" tabindex="0"' + clean + '>';
        converted += 1;
      } else {
        out += '<button' + attrs + '>';
      }
      stack.push(convert);
    }
    last = tokens.lastIndex;
  }
  out += source.slice(last);
  if (stack.length) throw new Error('CEP body 里的 button 标签没有成对闭合');
  return { body: out, converted };
}

const style = cep.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
if (!style) throw new Error('CEP 缺少 <style>');
const cepCss = style[1].replace(/^\r?\n/, '');

const inline = [...cep.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]);
if (inline.length !== 1) throw new Error('CEP 必须且只能有一个内联 UI 脚本，实际 ' + inline.length);
let ui = inline[0];

function replaceOnce(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error('CEP 脚本结构已变化，找不到：' + label);
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error('CEP 脚本结构已变化，出现多次：' + label);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

// --- 仅替换 UXP 引擎不可用的能力，业务逻辑保持 CEP 原样 ---
ui = replaceOnce(
  ui,
  "const HOST_EXPECT = '4.4.7';",
  "const HOST_EXPECT = '" + hostVersion + "';",
  'HOST_EXPECT',
);
ui = replaceOnce(
  ui,
  'if (searchInput) setTimeout(() => searchInput.focus(), 30);',
  '/* UXP：不自动聚焦搜索框，原生输入框会盖住刚展开的列表 */',
  'search autofocus',
);
ui = replaceOnce(
  ui,
  'const opt = sel.selectedOptions && sel.selectedOptions[0];',
  "const opt = (sel.selectedOptions && sel.selectedOptions[0]) || " +
    "Array.from(sel.options || []).filter((o) => o.value === sel.value)[0] || null;",
  'selectedOptions',
);
ui = replaceOnce(
  ui,
  "      if (searchInput) searchInput.addEventListener('input', () => build(searchInput.value));",
  "      if (searchInput) {\n" +
    "        let searchDebounce = null;\n" +
    "        const runSearch = () => {\n" +
    "          if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }\n" +
    "          build(searchInput.value);\n" +
    "        };\n" +
    "        searchInput.addEventListener('input', () => {\n" +
    "          if (searchDebounce) clearTimeout(searchDebounce);\n" +
    "          searchDebounce = setTimeout(runSearch, 90);\n" +
    "        });\n" +
    "        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });\n" +
    "      }",
  'font search debounce',
);
ui = replaceOnce(
  ui,
  "    $('#preset-search').addEventListener('input', renderPresetPop);",
  "    let presetSearchDebounce = null;\n" +
    "    const runPresetSearch = () => {\n" +
    "      if (presetSearchDebounce) { clearTimeout(presetSearchDebounce); presetSearchDebounce = null; }\n" +
    "      renderPresetPop();\n" +
    "    };\n" +
    "    $('#preset-search').addEventListener('input', () => {\n" +
    "      if (presetSearchDebounce) clearTimeout(presetSearchDebounce);\n" +
    "      presetSearchDebounce = setTimeout(runPresetSearch, 90);\n" +
    "    });\n" +
    "    $('#preset-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPresetSearch(); });",
  'preset search debounce',
);
ui = replaceOnce(
  ui,
  "    setInterval(pollSelection, 500);",
  "    setInterval(function () {\n" +
    "      // UXP：滚动、输入、弹层打开期间暂停跨进程选区遍历。\n" +
    "      if (window.__uxpShouldPausePoll && window.__uxpShouldPausePoll()) return;\n" +
    "      pollSelection();\n" +
    "    }, 700);",
  'selection poll gating',
);
ui = replaceOnce(
  ui,
  "      def.innerHTML = '<span class=\\\"preset-row-name\\\">默认</span><span class=\\\"preset-row-tip\\\">识别选中</span>';",
  "      def.appendChild(window.__uxpSpan('preset-row-name', '默认'));\n" +
    "      def.appendChild(window.__uxpSpan('preset-row-tip', '识别选中'));",
  'preset default innerHTML',
);

const eventCount = (ui.match(/\bnew\s+Event\(/g) || []).length;
const optionCount = (ui.match(/\bnew\s+Option\(/g) || []).length;
const appendCount = (ui.match(/\.append\(/g) || []).length;
const buttonCreateCount = (ui.match(/document\.createElement\((['"])button\1\)/g) || []).length;
const localStorageCount = (ui.match(/\blocalStorage\./g) || []).length;
if (eventCount === 0) throw new Error('CEP 脚本里没有 new Event，需复核替换规则');
if (optionCount === 0) throw new Error('CEP 脚本里没有 new Option，需复核替换规则');
if (appendCount === 0) throw new Error('CEP 脚本里没有 .append，需复核替换规则');
if (buttonCreateCount !== 3) throw new Error('CEP 动态按钮数量变了：' + buttonCreateCount);
if (localStorageCount === 0) throw new Error('CEP 脚本里没有 localStorage，需复核替换规则');
ui = ui.replace(/\bnew\s+Event\(/g, 'window.__uxpEvent(');
ui = ui.replace(/\bnew\s+Option\(/g, 'window.__uxpOption(');
// 这个脚本里的 .append 全部是单参数调用；UXP 老运行时没有 Element.append。
ui = ui.replace(/\.append\(/g, '.appendChild(');
ui = ui.replace(/document\.createElement\((['"])button\1\)/g, 'window.__uxpButton()');
// UXP 不保证全局 localStorage 可写；bootstrap 会提供 window.localStorage 降级，
// 这里显式走 window，避免裸标识符在部分运行时解析失败。
ui = ui.replace(/\blocalStorage\./g, 'window.localStorage.');
// 让 uxp-adapt.js 复用 CEP 自己的方案读写/提示逻辑，避免复制一份业务代码。
ui += '\n;window.__cep = { getPresets, setPresets, figmaNotify, renderPresetPop };\n';

const buttonized = convertStaticButtons(stripScripts(bodyInner(cep)));
const body = buttonized.body;
if (!body.includes('id="font-apply"') || !body.includes('class="card"')) {
  throw new Error('CEP body 提取异常，缺少关键节点');
}
if (buttonized.converted < 8) {
  throw new Error('CEP 静态按钮数量异常：' + buttonized.converted);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>盗版PS的工具箱</title>
  <link rel="stylesheet" href="panel.css" />
  <link rel="stylesheet" href="uxp-compat.css" />
</head>
<body>${body}<script src="uxp-bootstrap.js"></script><script src="cep-ui.js"></script><script src="uxp-adapt.js"></script></body></html>
`;

writeFileSync(join(uxpDir, 'index.html'), html, 'utf8');
writeFileSync(join(uxpDir, 'panel.css'), cepCss, 'utf8');
writeFileSync(join(uxpDir, 'cep-ui.js'), ui, 'utf8');

console.log('index.html bytes=' + Buffer.byteLength(html));
console.log('panel.css bytes=' + Buffer.byteLength(cepCss) + '（CEP <style> 原文）');
console.log('cep-ui.js bytes=' + Buffer.byteLength(ui) + '（CEP 内联脚本 + 引擎替换）');
console.log('engine replacements: Event=' + eventCount + ' Option=' + optionCount +
  ' append=' + appendCount + ' buttons=' + buttonCreateCount +
  ' localStorage=' + localStorageCount);
console.log('static buttons converted=' + buttonized.converted);
