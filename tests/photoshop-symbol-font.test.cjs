'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const panel=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps/index.html'),'utf8');
const host=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps/jsx/host.jsx'),'utf8');
function section(src,a,b){const i=src.indexOf(a),j=src.indexOf(b,i);assert.ok(i>=0&&j>i,a);return src.slice(i,j);}
const core=section(host,'    function isCJK(', '    function esc(')+section(host,'    function segmentsOf(', '    /* ---------------- leading');
function plan(text,side){return JSON.parse(vm.runInNewContext(core+'JSON.stringify(fontPerChar('+JSON.stringify(text)+',"CN","EN",24,12,{r:1},{r:0},'+JSON.stringify(side)+'))'));}
function chars(text,side){const out=[];for(const p of plan(text,side))for(let i=p.from;i<p.to;i++)out[i]=p;return out;}
test('unset and invalid symbol modes exactly preserve old segmentation',()=>{
 const text='中A1，,! Ａ１　😀';assert.deepEqual(plan(text,null),plan(text,'invalid'));
 const a=chars(text,null);assert.equal(a[3].psName,'CN');assert.equal(a[4].psName,'EN');
});
test('both modes change only Unicode punctuation/symbol fonts, preserving size and color',()=>{
 const text='中Ab19Ａ１　 \t\n，。、“”！？,.!@#$%^&*()—…￥＋÷©★😀';
 const old=chars(text,null);
 for(const side of ['cn','en']){
  const result=chars(text,side);let i=0;
  for(const ch of text){for(let n=0;n<ch.length;n++,i++){
   const symbol=/[\p{P}\p{S}]/u.test(ch);
   assert.equal(result[i].psName,symbol?(side==='cn'?'CN':'EN'):old[i].psName,ch);
   assert.equal(result[i].size,old[i].size,ch);assert.deepEqual(result[i].rgb,old[i].rgb,ch);
  }}
 }
});
test('surrogate pair symbols stay intact and range coverage remains contiguous',()=>{
 const text='A😀中';const p=plan(text,'cn');assert.deepEqual(p.map(x=>[x.from,x.to,x.psName]),[[0,1,'EN'],[1,3,'CN'],[3,4,'CN']]);
});
function ui(){
 const buttons=['cn','en'].map(side=>({dataset:{symbolSide:side},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this[k]=fn;}}));
 const nodes={};const $=id=>nodes[id]||(nodes[id]={value:'',placeholder:''});const messages=[];
 const ctx=vm.createContext({document:{querySelectorAll:()=>buttons},$,fontSel:{cn:{family:'CN'},en:{family:'EN'}},numInput:()=>12,hexToRgb:()=>({r:0}),rgbToHex:()=> '#000000',parseFont:()=>null,send:m=>messages.push(m),figmaNotify(){},onFontMixStart(){},clearTouched(){},setFontValue(){}});
 vm.runInContext(section(panel,'    let symbolFontSide =','    let lastSyncColor =')+'let lastSyncColor=false;'+section(panel,'    function sendFontMix(',"    $('#font-apply-color')")+section(panel,'    function readFormAsScheme(', '    function setCurrentLabel(')+section(panel,'    function applyPresetToForm(', '    function openPresetPop('),ctx);
 return {buttons,messages,run:s=>vm.runInContext(s,ctx)};
}
test('buttons toggle mutually exclusively and clicking the active button clears override',()=>{
 const h=ui();h.buttons[0].click();assert.deepEqual(h.buttons.map(b=>b.attrs['aria-pressed']),['true','false']);h.buttons[1].click();assert.deepEqual(h.buttons.map(b=>b.attrs['aria-pressed']),['false','true']);h.buttons[1].click();assert.deepEqual(h.buttons.map(b=>b.attrs['aria-pressed']),['false','false']);
});
test('both application buttons send chosen symbol mode and preserve color choice',()=>{
 const h=ui();h.buttons[0].click();h.run('sendFontMix(false);sendFontMix(true)');assert.deepEqual(h.messages.map(m=>m.config.symbolFontSide),['cn','cn']);assert.deepEqual(h.messages.map(m=>m.config.syncColor),[false,true]);assert.equal('cnColor' in h.messages[0].config,false);
});
test('presets save mode, restore it and reset legacy presets to default',()=>{
 const h=ui();h.buttons[1].click();assert.equal(h.run('readFormAsScheme("saved").symbolFontSide'),'en');h.run('applyPresetToForm({symbolFontSide:"cn"})');assert.equal(h.buttons[0].attrs['aria-pressed'],'true');h.run('applyPresetToForm({})');assert.deepEqual(h.buttons.map(b=>b.attrs['aria-pressed']),['false','false']);
});
test('symbol buttons occupy their language headers and English title is corrected',()=>{
 const cn=section(panel,'data-page-node-id="SvAAbqnrdcJbydKlFuBJQT"','</div>');
 const en=section(panel,'data-page-node-id="OHbNMT9E012hFuj2odwciv"','</div>');
 assert.match(cn,/data-symbol-side="cn" aria-pressed="false">符号使用中文/);
 assert.match(en,/>英文<\/span>.*data-symbol-side="en" aria-pressed="false">符号使用英文/);
 assert.doesNotMatch(en,/字符设置/);
 assert.match(en,/data-symbol-side="en".*id="kerning-apply"/);
 assert.doesNotMatch(panel,/<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn-ghost" id="kerning-apply"/);
 assert.equal((panel.match(/data-symbol-side="(?:cn|en)"/g)||[]).length,2);
 assert.match(panel,/\.symbol-btn \{ margin-left:auto/);
});
test('the CEP panel keeps its diagnostics card, the UXP panel restores it at the bottom',()=>{
 // The user asked for this block to stay: it is how a broken host load gets traced.
 const uxp=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps.uxp/index.html'),'utf8');
 assert.match(panel,/id="host-diagnostics"/);
 assert.match(panel,/id="host-diagnose"/);
 assert.match(uxp,/id="host-diagnostics"/);
 assert.match(uxp,/id="host-diagnose"/);
 // Bottom of the panel: after the scheme section, inside <main>.
 const diag=uxp.indexOf('id="host-diagnostics"'), scheme=uxp.indexOf('id="preset-export"'), mainEnd=uxp.indexOf('</main>');
 assert.ok(diag>scheme&&diag<mainEnd,'diagnostics card sits below the scheme section and inside main');
 assert.equal((uxp.match(/id="host-diagnostics"/g)||[]).length,1);
});
