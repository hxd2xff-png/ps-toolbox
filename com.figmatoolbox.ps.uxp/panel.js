'use strict';
const host=require('./host.js');
const $=id=>document.getElementById(id);
const touched=new Set();
let scheme='',presets=[],busy=false;
const keys=['cn-font','en-font','cn-size','en-size','cn-color','en-color','cn-tracking','en-tracking'];
const status=text=>{$('status').textContent=text;};
function color(value) {
  if (!value.trim()) return null;
  if (!/^#[a-f0-9]{6}$/i.test(value)) throw Error('颜色格式须为 #RRGGBB');
  return {r:parseInt(value.slice(1,3),16)/255,g:parseInt(value.slice(3,5),16)/255,b:parseInt(value.slice(5,7),16)/255};
}
function hex(rgb) { return '#'+[rgb.r,rgb.g,rgb.b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''); }
function config() {
  const out={};
  for (const side of ['cn','en']) {
    out[side+'Font']=$(side+'-font').value?JSON.parse($(side+'-font').value):null;
    const raw=$(side+'-size').value.trim();
    if (raw && (!Number.isFinite(Number(raw)) || Number(raw)<=0)) throw Error('字号须为正数');
    out[side+'Size']=raw?Number(raw):null;
    const tracking=$(side+'-tracking').value.trim();
    if (tracking && !Number.isInteger(Number(tracking))) throw Error('字距 tracking 须为整数');
    out[side+'Tracking']=tracking?Number(tracking):null;
    out[side+'Color']=color($(side+'-color').value);
  }
  return out;
}
function fill(result) {
  if (scheme) { status('保留方案值；识别结果未覆盖'); return; }
  const notes=[];
  for (const side of ['cn','en']) for (const kind of ['Font','Size','Color','Tracking']) {
    const id=side+'-'+(kind==='Tracking'?'tracking':kind.toLowerCase()),f=result.fields && result.fields[side+kind] || {state:result.error?'error':'empty',value:null};
    notes.push(id+'：'+(touched.has(id)?'保留用户值':({consistent:'一致',mixed:'混合',unrecognized:'未识别',empty:'无内容',error:'读取失败'}[f.state]))+(f.convenience?'（另一侧便利回填）':''));
    if (touched.has(id)) continue;
    $(id).value=f.value==null?'':kind==='Font'?JSON.stringify(f.value):kind==='Color'?hex(f.value):String(f.value);
  }
  status((result.error?'识别失败：'+result.error:'识别 '+(result.layerCount || 0)+' 个文本层')+(result.sourceNotes && result.sourceNotes.length?'\n诊断：'+result.sourceNotes.join('；'):'')+'\n'+notes.join('\n'));
}
async function run(work) {
  if (busy) return;
  busy=true;
  for (const id of ['detect','reset','apply','apply-color','save','remove']) $(id).disabled=true;
  try { await work(); } catch(e) { status(String(e.message || e)); }
  finally { busy=false; for (const id of ['detect','reset','apply','apply-color','save','remove']) $(id).disabled=false; }
}
async function detect() { try { fill(await host.detect()); } catch(e) { fill({error:String(e.message || e)}); } }
async function apply(syncColor) {
  const c=config();c.syncColor=syncColor;
  if (!c.cnFont && !c.enFont && c.cnSize==null && c.enSize==null && c.cnTracking==null && c.enTracking==null && !(syncColor && (c.cnColor || c.enColor))) throw Error('请至少设置一侧字体、字号、字距或同步颜色');
  status('正在逐层应用并回读…');
  const result=await host.apply(c);
  status('回读通过 '+result.ok+' / '+result.total+' 层'+(result.cancelled?'；操作已取消，未确认当前层状态':'')+(result.error?'\n'+result.error:'')+'\n'+result.failed.map(f=>f.name+'：'+f.reason+'；'+(f.integrity || f.stage)).join('\n'));
}
function renderPresets() {
  const select=$('preset');select.textContent='';
  const empty=document.createElement('option');empty.value='';empty.textContent='当前识别 / 用户值';select.appendChild(empty);
  presets.forEach((p,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=p.name;select.appendChild(option);});
  select.value=scheme;
}
function persist() { localStorage.setItem('ps-font-mixer-uxp-presets',JSON.stringify(presets)); renderPresets(); }
keys.forEach(id=>$(id).addEventListener('input',()=>touched.add(id)));
$('cn-font').addEventListener('change',()=>touched.add('cn-font'));
$('en-font').addEventListener('change',()=>touched.add('en-font'));
$('detect').addEventListener('click',()=>run(detect));
$('reset').addEventListener('click',()=>run(async()=>{scheme='';$('preset').value='';touched.clear();await detect();}));
$('apply').addEventListener('click',()=>run(()=>apply(false)));
$('apply-color').addEventListener('click',()=>run(()=>apply(true)));
$('preset').addEventListener('change',()=>{
  scheme=$('preset').value;
  if (scheme==='') { touched.clear();run(detect);return; }
  const p=presets[Number(scheme)];
  for (const side of ['cn','en']) {
    $(side+'-font').value=p.config[side+'Font']?JSON.stringify(p.config[side+'Font']):'';
    $(side+'-size').value=p.config[side+'Size']==null?'':String(p.config[side+'Size']);
    $(side+'-tracking').value=p.config[side+'Tracking']==null?'':String(p.config[side+'Tracking']);
    $(side+'-color').value=p.config[side+'Color']?hex(p.config[side+'Color']):'';
  }
  status('使用方案：'+p.name);
});
$('save').addEventListener('click',()=>run(async()=>{const name=$('preset-name').value.trim();if (!name) throw Error('填写方案名称');presets.push({name,config:config()});scheme=String(presets.length-1);persist();status('方案已保存');}));
$('remove').addEventListener('click',()=>run(async()=>{if(scheme==='')return;presets.splice(Number(scheme),1);scheme='';persist();touched.clear();await detect();}));
run(async()=>{
  const list=host.fonts();
  for (const side of ['cn','en']) for (const font of list) {
    const option=document.createElement('option');option.value=JSON.stringify({family:font.family,style:font.style});option.textContent=font.family+' / '+font.style;$(side+'-font').appendChild(option);
  }
  try { presets=JSON.parse(localStorage.getItem('ps-font-mixer-uxp-presets') || '[]'); if(!Array.isArray(presets))presets=[]; } catch(e) { presets=[]; }
  renderPresets();await detect();
});
