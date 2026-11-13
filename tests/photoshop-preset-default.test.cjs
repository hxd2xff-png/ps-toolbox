'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../com.figmatoolbox.ps/index.html'), 'utf8');
function section(start, end) {
  const i = source.indexOf(start), j = source.indexOf(end, i);
  assert.ok(i >= 0 && j > i, start);
  return source.slice(i, j);
}
function harness() {
  function element() {
    return {value:'', placeholder:'', textContent:'', style:{}, children:[], listeners:{},
      classList:{toggle(){},remove(){}},
      append(child){this.children.push(child);},
      addEventListener(type, fn){this.listeners[type]=fn;},
      set innerHTML(value){this.children=[];}, get innerHTML(){return '';}};
  }
  const nodes = {};
  const $ = key => nodes[key] || (nodes[key] = element());
  const context = vm.createContext({ $, document:{createElement:element},
    closePresetPop(){}, figmaNotify(){}, rgbToHex:()=> '#112233',setSymbolFontSide(){},
    activeTab:'font',hostReady:true,detectRequestPending:false,detectAgainQueued:false,
    polls:[],pollSelection(force){context.polls.push(force);},
    ddRegistry:{},fontSel:{}, lastSyncColor:false,
    lsWrite(){},send(){} });
  vm.runInContext(
    section('    function detectActive()', '    // 把识别到的文本图层') +
    section('    const userTouched =', '    // 主进程已开始处理') +
    section('    function fontLabel(', '    // ---- 字体混排：应用') +
    section('    const PK =', '    function lsRead(') +
    section('    const getPresets =', '    // 读取当前表单') +
    section('    function setCurrentLabel(', '    function moveFontPreset(') +
    section('    function renderPresetPop(', '    function deletePreset(') +
    section('    function applyPresetToForm(', '    function openPresetPop(') +
    'globalThis.api={selectPreset,renderPresetPop,fillFontFromDetect, getScheme:()=>currentScheme, touched:userTouched, setPresets:(p)=>{fontPresets=p;}};', context);
  const api = context.api;
  const preset = {name:'Saved',cnFont:{family:'Preset CN',style:'Regular'},enFont:{family:'Preset EN',style:'Bold'},cnSize:30,enSize:31};
  api.setPresets([preset]);
  const detected = {cnFont:{family:'Detected CN',style:'Regular'},enFont:{family:'Detected EN',style:'Regular'},cnSize:14,enSize:15,layerCount:1};
  function clickDefault(){api.renderPresetPop();$('#preset-pop-list').children[0].onclick();}
  function touchFonts(){['cn','en'].forEach(side=>$('#'+side+'-font').listeners.input());}
  return {context,api,$,preset,detected,clickDefault,touchFonts};
}
test('saved preset then default clears edit guards and refills both fonts from detection',()=>{
  const h=harness();h.api.selectPreset('Saved');h.touchFonts();
  h.clickDefault();
  assert.equal(h.api.getScheme(),'');
  assert.deepEqual(Array.from(h.context.polls),[true]);
  h.api.fillFontFromDetect(h.detected);
  assert.equal(h.context.fontSel.cn.family,'Detected CN');
  assert.equal(h.context.fontSel.en.family,'Detected EN');
  assert.equal(h.$('#cn-size').value,14);
});
test('clicking current preset to return to default also restores detection refill',()=>{
  const h=harness();h.api.selectPreset('Saved');h.touchFonts();
  h.api.renderPresetPop();h.$('#preset-pop-list').children[1].onclick();
  h.api.fillFontFromDetect(h.detected);
  assert.equal(h.context.fontSel.cn.family,'Detected CN');
  assert.equal(h.context.fontSel.en.family,'Detected EN');
});
test('automatic detection still preserves a selected preset and new manual edits in default',()=>{
  const h=harness();h.api.selectPreset('Saved');h.api.fillFontFromDetect(h.detected);
  assert.equal(h.context.fontSel.cn.family,'Preset CN');
  h.clickDefault();h.api.fillFontFromDetect(h.detected);h.touchFonts();
  h.api.fillFontFromDetect({...h.detected,cnFont:{family:'Other',style:'Regular'}});
  assert.equal(h.context.fontSel.cn.family,'Detected CN');
});
test('saved preset then default without edits requests and refills both fonts',()=>{
  const h=harness();h.api.selectPreset('Saved');h.clickDefault();h.api.fillFontFromDetect(h.detected);
  assert.equal(h.context.fontSel.cn.family,'Detected CN');
  assert.equal(h.context.fontSel.en.family,'Detected EN');
});
