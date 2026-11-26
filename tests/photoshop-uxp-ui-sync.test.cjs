'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ROOT=path.join(__dirname,'..');
const CEP=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps/index.html'),'utf8');
const UXP=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/index.html'),'utf8');
const CSS=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/panel.css'),'utf8');
const UI=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/cep-ui.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/manifest.json'),'utf8'));

function bodyOf(source){
 const start=source.search(/<body\b/i);
 const openEnd=source.indexOf('>',start);
 const close=source.search(/<\/body\s*>/i);
 assert.ok(start>=0&&openEnd>=0&&close>=0,'<body> 必须完整');
 return source.slice(openEnd+1,close);
}
function stripScripts(source){ return source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''); }
function replaceOnce(source,needle,replacement){
 const at=source.indexOf(needle);
 assert.ok(at>=0,'缺少待替换片段：'+needle.slice(0,60));
 assert.equal(source.indexOf(needle,at+needle.length),-1,'待替换片段出现多次：'+needle.slice(0,60));
 return source.slice(0,at)+replacement+source.slice(at+needle.length);
}
function convertStaticButtons(source){
 const tokens=/<button\b([^>]*)>|<\/button\s*>/gi;
 const stack=[];
 let out='';
 let last=0;
 let match;
 while((match=tokens.exec(source))){
  out+=source.slice(last,match.index);
  if(/^<\/button/i.test(match[0])){
   out+=stack.pop()?'</div>':'</button>';
  }else{
   const attrs=match[1]||'';
   const hasClass=/\bclass\s*=\s*(?:"[^"]*"|'[^']*')/i.test(attrs);
   const isDiagnose=/\bid\s*=\s*(?:"host-diagnose"|'host-diagnose')/i.test(attrs);
   const convert=hasClass&&!isDiagnose;
   if(convert){
    out+='<div role="button" tabindex="0"'+attrs
      .replace(/\s+type\s*=\s*(?:"button"|'button')/i,'')
      .replace(/\s+role\s*=\s*(?:"[^"]*"|'[^']*')/i,'')
      .replace(/\s+tabindex\s*=\s*(?:"[^"]*"|'[^']*')/i,'')+'>';
   }else{
    out+='<button'+attrs+'>';
   }
   stack.push(convert);
  }
  last=tokens.lastIndex;
 }
 out+=source.slice(last);
 assert.deepEqual(stack,[]);
 return out;
}

test('UXP body 只把带 class 的静态按钮降级为 div[role=button]',()=>{
 const cep=convertStaticButtons(stripScripts(bodyOf(CEP)));
 const uxp=stripScripts(bodyOf(UXP));
 assert.ok(cep.length>5000);
 assert.equal(uxp,cep,'除按钮引擎适配外，UXP 不允许维护第二套 HTML 结构');
 assert.equal((uxp.match(/<div role="button"/g)||[]).length,12);
 assert.match(uxp,/class="color-input"[\s\S]*?id="cn-color"[\s\S]*?class="color-swatch" data-color-target="cn-color"/);
 assert.match(uxp,/class="color-input"[\s\S]*?id="en-color"[\s\S]*?class="color-swatch" data-color-target="en-color"/);
 assert.match(uxp,/id="host-diagnose"/);
 assert.ok(uxp.includes('<button type="button" id="host-diagnose">'));
});

test('UXP panel.css 与 CEP <style> 逐字一致',()=>{
 const style=CEP.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
 assert.ok(style,'CEP 必须有 <style>');
 const cepCss=style[1].replace(/^\r?\n/,'');
 assert.equal(CSS,cepCss,'UXP 的视觉规范必须完全来自 CEP');
});

function expectedUi(cep,version){
 let ui=[...cep.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1])[0];
 ui=replaceOnce(ui,"const HOST_EXPECT = '4.4.7';","const HOST_EXPECT = '"+version+"';");
 ui=replaceOnce(ui,'if (searchInput) setTimeout(() => searchInput.focus(), 30);',
   '/* UXP：不自动聚焦搜索框，原生输入框会盖住刚展开的列表 */');
 ui=replaceOnce(ui,'const opt = sel.selectedOptions && sel.selectedOptions[0];',
   "const opt = (sel.selectedOptions && sel.selectedOptions[0]) || "+
   "Array.from(sel.options || []).filter((o) => o.value === sel.value)[0] || null;");
 ui=replaceOnce(ui,
   "      if (searchInput) searchInput.addEventListener('input', () => build(searchInput.value));",
   "      if (searchInput) {\n"+
   "        let searchDebounce = null;\n"+
   "        const runSearch = () => {\n"+
   "          if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }\n"+
   "          build(searchInput.value);\n"+
   "        };\n"+
   "        searchInput.addEventListener('input', () => {\n"+
   "          if (searchDebounce) clearTimeout(searchDebounce);\n"+
   "          searchDebounce = setTimeout(runSearch, 90);\n"+
   "        });\n"+
   "        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });\n"+
   "      }");
 ui=replaceOnce(ui,
   "    $('#preset-search').addEventListener('input', renderPresetPop);",
   "    let presetSearchDebounce = null;\n"+
   "    const runPresetSearch = () => {\n"+
   "      if (presetSearchDebounce) { clearTimeout(presetSearchDebounce); presetSearchDebounce = null; }\n"+
   "      renderPresetPop();\n"+
   "    };\n"+
   "    $('#preset-search').addEventListener('input', () => {\n"+
   "      if (presetSearchDebounce) clearTimeout(presetSearchDebounce);\n"+
   "      presetSearchDebounce = setTimeout(runPresetSearch, 90);\n"+
   "    });\n"+
   "    $('#preset-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPresetSearch(); });");
 ui=replaceOnce(ui,
   "    setInterval(pollSelection, 500);",
   "    setInterval(function () {\n"+
   "      // UXP：滚动、输入、弹层打开期间暂停跨进程选区遍历。\n"+
   "      if (window.__uxpShouldPausePoll && window.__uxpShouldPausePoll()) return;\n"+
   "      pollSelection();\n"+
   "    }, 700);");
 ui=replaceOnce(ui,
   "      def.innerHTML = '<span class=\\\"preset-row-name\\\">默认</span><span class=\\\"preset-row-tip\\\">识别选中</span>';",
   "      def.appendChild(window.__uxpSpan('preset-row-name', '默认'));\n"+
   "      def.appendChild(window.__uxpSpan('preset-row-tip', '识别选中'));");
 ui=ui.replace(/\bnew\s+Event\(/g,'window.__uxpEvent(');
 ui=ui.replace(/\bnew\s+Option\(/g,'window.__uxpOption(');
 ui=ui.replace(/\.append\(/g,'.appendChild(');
 ui=ui.replace(/document\.createElement\((['"])button\1\)/g,'window.__uxpButton()');
 ui=ui.replace(/\blocalStorage\./g,'window.localStorage.');
 return ui+'\n;window.__cep = { getPresets, setPresets, figmaNotify, renderPresetPop };\n';
}

test('cep-ui.js 只包含已登记的 UXP 引擎替换',()=>{
 assert.equal(UI,expectedUi(CEP,manifest.version));
 assert.match(UI,new RegExp("const HOST_EXPECT = '"+manifest.version.replace(/\./g,'\\.')+"'"));
 assert.equal((UI.match(/window\.__uxpEvent\(/g)||[]).length,3);
 assert.equal((UI.match(/window\.__uxpOption\(/g)||[]).length,2);
 assert.equal((UI.match(/window\.__uxpButton\(/g)||[]).length,3);
 assert.equal((UI.match(/window\.localStorage\./g)||[]).length,4);
 assert.doesNotMatch(UI,/\bnew\s+(?:Event|Option)\s*\(/);
 assert.doesNotMatch(UI,/document\.createElement\((['"])button\1\)/);
 assert.doesNotMatch(UI,/(^|[^.\w])localStorage\./m);
});

test('入口只加载桥接脚本，不引用旧 UXP 文件或外部资源',()=>{
 const scripts=[...UXP.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]);
 assert.deepEqual(scripts,['uxp-bootstrap.js','cep-ui.js','uxp-adapt.js']);
 assert.ok(!/<script\b(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/i.test(UXP),'不允许内联脚本');
 assert.ok(!/https?:\/\//i.test(UXP),'不允许外部资源');
 const uxpDir=path.join(ROOT,'com.figmatoolbox.ps.uxp');
 for(const stale of ['main.js','panel.js','boot-diagnostics.js']) {
  assert.equal(fs.existsSync(path.join(uxpDir,stale)),false,stale+' 应已删除');
  assert.ok(!UXP.includes(stale),'index.html 不得引用 '+stale);
 }
});

test('UXP 仅通过兼容层补齐文件选择与诊断，不修改 CEP 业务逻辑',()=>{
 const adapt=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/uxp-adapt.js'),'utf8');
 assert.match(adapt,/getFileForOpening/);
 assert.match(adapt,/getFileForSaving/);
 assert.match(adapt,/host\.dispatch\('diag',\s*null\)/);
 assert.match(adapt,/addEventListener\('click',[\s\S]*?, true\)/,'必须在捕获阶段拦截 CEP 专用的文件/诊断入口');
 assert.match(adapt,/popup-open/);
 assert.match(adapt,/z-index/);
 assert.match(adapt,/uxp-popup-under/,'原生输入只能按实际重叠区域隐藏');
 assert.match(adapt,/getBoundingClientRect/,'必须按弹层与输入框的实际矩形判断是否重叠');
 assert.match(adapt,/__uxpShouldPausePoll/,'选区轮询必须在交互期间暂停');
 assert.match(adapt,/schedulePopupSync/,'弹层同步必须改为事件驱动');
 assert.doesNotMatch(adapt,/setInterval\(syncPopupState/,'不得保留 100ms 无条件布局轮询');
 assert.equal(manifest.requiredPermissions.localFileSystem,'fullAccess');
});

test('UXP 交互路径按需触发，避免周期性布局与搜索重建',()=>{
 assert.doesNotMatch(UI,/setInterval\(pollSelection,\s*500\)/,'不得保留 500ms 无条件选区轮询');
 assert.match(UI,/setInterval\(function \(\)[\s\S]*?__uxpShouldPausePoll[\s\S]*?\},\s*700\);/,'选区轮询应降频并可暂停');
 assert.match(UI,/searchDebounce[\s\S]*?searchDebounce = setTimeout\(runSearch,\s*90\)/,'字体搜索必须防抖');
 assert.match(UI,/presetSearchDebounce[\s\S]*?setTimeout\(runPresetSearch,\s*90\)/,'方案搜索必须防抖');
});

test('字色文本框右侧色块统一触发 Photoshop 拾色器并同步色值',()=>{
 assert.match(UI,/function openPsPicker\(input\)/);
 assert.match(UI,/callHost\('pick-color'/);
 assert.match(UI,/r\.canceled/);
 assert.match(UI,/r\.busy/);
 assert.match(UI,/function syncColorSwatch\(input\)/);
 assert.match(UI,/function syncAllColorSwatches\(\)/);
 assert.match(UI,/closest\('\.color-swatch'\)/);
 assert.match(UI,/syncColorSwatch\(el\)/,'手动输入字色也要同步色块');
 assert.match(UI,/syncColorSwatch\(\$\('#cn-color'\)\)/,'应用方案后中文色块必须同步');
 assert.match(UI,/syncColorSwatch\(\$\('#en-color'\)\)/,'应用方案后英文色块必须同步');
});

test('UXP 兼容 CSS 只补 flex longhand、CEP 字段比例、按钮盒模型与原生输入间距',()=>{
 const compat=fs.readFileSync(path.join(ROOT,'com.figmatoolbox.ps.uxp/uxp-compat.css'),'utf8');
 assert.match(compat,/\.topbar, \.brand, \.seg, \.card-head[\s\S]*?display:\s*flex\s*!important/);
 assert.match(compat,/\.dd-current, \.preset-current\s*\{[^}]*flex-grow:\s*1\s*!important/);
 assert.match(compat,/\.row > \.field\s*\{[^}]*flex-grow:\s*171\s*!important/,'UXP 忽略非 grow 字段的 flex-basis，必须用 grow 权重给字色列 CEP 的 171/334');
 assert.match(compat,/\.row > \.field\.grow\s*\{\s*flex-grow:\s*163\s*!important/,'字号列必须保持 CEP 的 163/334');
 assert.match(compat,/\.row > \.field\s*\{[^}]*flex-basis:\s*0%\s*!important/,'两列以 0 为基准分配剩余宽度');
 assert.doesNotMatch(compat,/\.row > \.field:not\(\.grow\)\s*\{[^}]*flex-basis:\s*171px/,'固定 171px 会在 UXP 滚动条占用宽度时破坏两列对齐');
 assert.match(compat,/\.row > \.field \+ \.field\s*\{[^}]*margin-bottom:\s*10px\s*!important/,'双字段必须补回相同下边距，否则末字段会被抬高 10px');
 assert.match(compat,/\.symbol-btn\[role="button"\][^{]*\{[^}]*display:\s*inline-flex/);
 assert.match(compat,/input\[type="text"\], input\[type="number"\][^{]*\{[^}]*margin:\s*0\s*!important/);
 assert.match(compat,/input\[type="text"\], input\[type="number"\][^{]*\{[^}]*border:\s*1px solid var\(--fill\)\s*!important/,'UXP 圆角填充需用同色描边抗锯齿');
 assert.doesNotMatch(compat,/\.row > \.field\.grow\s*\{[^}]*[^-\w]width:\s*0\s*!important/);
 assert.doesNotMatch(compat,/body\.popup-open input\[type="text"\]/,'不得在任一弹层打开时隐藏整个面板的输入框');
 assert.match(compat,/input\.uxp-popup-under\s*\{[^}]*visibility:\s*hidden\s*!important/,'只隐藏与弹层实际重叠的原生输入');
 assert.match(compat,/\.color-input\s*\{[^}]*display:\s*flex\s*!important/);
 assert.match(compat,/\.color-input > input\[type="text"\]\s*\{[^}]*flex:\s*1 1 0%\s*!important/,'字色输入必须与色块并排收缩');
 assert.match(compat,/\.color-input > \.color-swatch\s*\{[^}]*flex:\s*0 0 30px\s*!important/,'色块不能被原生 input 挤压');
});

test('方案选择器与通用下拉全局互斥',()=>{
 const ddOpen=UI.match(/function open\(\) \{[\s\S]*?\n      \}/);
 const presetOpen=UI.match(/function openPresetPop\(\) \{[\s\S]*?\n    \}/);
 assert.ok(ddOpen,'必须找到通用下拉 open()');
 assert.ok(presetOpen,'必须找到方案下拉 openPresetPop()');
 assert.match(ddOpen[0],/closeAllPickers\(\)/,'打开字体/格式下拉前必须收起方案下拉');
 assert.match(presetOpen[0],/closeAllPickers\(\)/,'打开方案下拉前必须收起字体/格式下拉');
});
