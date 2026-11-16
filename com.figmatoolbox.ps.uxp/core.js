'use strict';
// UTF-16 offsets and character ownership intentionally match the existing CEP implementation.
function isCJK(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 0x3000 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}
function segmentsOf(text) {
  const result = [];
  for (let i = 0; i < text.length; i++) {
    const side = isCJK(text[i]) ? 'cn' : 'en';
    const last = result[result.length - 1];
    if (last && last.side === side) last.to = i + 1;
    else result.push({from:i, to:i+1, side});
  }
  return result;
}
const clone = value => JSON.parse(JSON.stringify(value));
function numberValue(v) { return v && typeof v === 'object' ? v._value : v; }
function scaleOf(tk) {
  const xx = tk.transform && numberValue(tk.transform.xx);
  return Number.isFinite(xx) && Math.abs(xx) > 0.0001 ? Math.abs(xx) : 1;
}
function validateRanges(tk) {
  if (!tk || typeof tk.textKey !== 'string' || !Array.isArray(tk.textStyleRange)) throw Error('textKey/textStyleRange 描述符缺失');
  const len = tk.textKey.length;
  let cursor = 0;
  for (const r of tk.textStyleRange) {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from !== cursor || r.to <= r.from || !r.textStyle) throw Error('文本区间不连续或样式缺失');
    cursor = r.to;
    if (cursor >= len) break; // Photoshop may include one terminal character.
  }
  if (cursor < len) throw Error('文本区间覆盖不完整');
  return tk;
}
function field() { return {state:'empty', value:null, sources:[]}; }
function aggregate(records, fonts = [], failed = []) {
  const fields = {}, seen = {cn:false,en:false};
  for (const side of ['cn','en']) for (const kind of ['Font','Size','Color','Tracking']) fields[side+kind] = field();
  const index = new Map(fonts.map(f => [f.postScriptName || f.name, f]));
  function add(key,value,source) {
    const f = fields[key]; f.sources.push(source);
    if (value == null) { f.state='unrecognized'; f.value=null; }
    else if (f.state==='empty') { f.state='consistent'; f.value=value; }
    else if (f.state==='consistent' && JSON.stringify(f.value)!==JSON.stringify(value)) { f.state='mixed'; f.value=null; }
    else if (f.state==='unrecognized') f.value=null;
  }
  for (const {id,name,tk} of records) {
    validateRanges(tk);
    const scale = scaleOf(tk);
    for (const seg of segmentsOf(tk.textKey)) {
      seen[seg.side] = true;
      for (const r of tk.textStyleRange) {
        const from=Math.max(seg.from,r.from),to=Math.min(seg.to,r.to);
        if (from>=to) continue;
        const st=r.textStyle, f=index.get(st.fontPostScriptName), source={id,name,from,to,psName:st.fontPostScriptName || null};
        add(seg.side+'Font',f?{family:f.family,style:f.style}:null,source);
        const size=numberValue(st.size);
        add(seg.side+'Size',Number.isFinite(size)?Math.round(size*scale*100)/100:null,source);
        const color=st.color;
        add(seg.side+'Color',color && [color.red,color.grain,color.blue].every(Number.isFinite)?{r:color.red/255,g:color.grain/255,b:color.blue/255}:null,source);
        add(seg.side+'Tracking',Number.isInteger(st.tracking)?st.tracking:null,source);
      }
    }
  }
  for (const side of ['cn','en']) for (const kind of ['Font','Size','Color','Tracking']) {
    if (failed.length) fields[side+kind]={...fields[side+kind],state:'error',value:null};
    else if (!seen[side] && seen[side==='cn'?'en':'cn']) fields[side+kind]={...fields[(side==='cn'?'en':'cn')+kind],convenience:true};
    else if (fields[side+kind].state==='empty' && seen[side]) fields[side+kind].state='unrecognized';
  }
  return {operation:'detect-font',empty:!records.some(r=>r.tk.textKey.length),layerCount:records.length,fields,failed,layers:records.map(({id,name})=>({id,name}))};
}
function buildTextKey(original,config) {
  validateRanges(original);
  const tk=clone(original), ranges=[];
  for (const seg of segmentsOf(tk.textKey)) for (const old of original.textStyleRange) {
    const from=Math.max(seg.from,old.from),to=Math.min(seg.to,old.to);
    if (from>=to) continue;
    const item=clone(old), style=item.textStyle;
    item.from=from; item.to=to;
    const f=config[seg.side+'Font'];
    if (f && !f.postScriptName) throw Error('字体缺少 PostScript 名');
    if (f && f.postScriptName) {
      for (const key of ['fontName','fontStyleName','fontScript','fontTechnology','fontAvailable']) delete style[key];
      style.fontPostScriptName=f.postScriptName;
    }
    const tracking=config[seg.side+'Tracking'];
    if (tracking!=null) {
      if (!Number.isFinite(tracking) || !Number.isInteger(tracking)) throw Error('字距 tracking 须为整数');
      style.tracking=tracking;
    }
    const size=config[seg.side+'Size'];
    if (size!=null) {
      if (!Number.isFinite(size) || size<=0) throw Error('字号必须是正数');
      style.size={_unit:'pointsUnit',_value:size/scaleOf(original)};
      delete style.impliedFontSize;
    }
    const color=config[seg.side+'Color'];
    if (config.syncColor && color) {
      if (![color.r,color.g,color.b].every(n=>Number.isFinite(n)&&n>=0&&n<=1)) throw Error('颜色值超出范围');
      style.color={_obj:'RGBColor',red:color.r*255,grain:color.g*255,blue:color.b*255};
    }
    ranges.push(item);
  }
  // Preserve terminal style metadata while avoiding an opaque stale engineData snapshot.
  const terminal=original.textStyleRange.find(r=>r.to>tk.textKey.length);
  if (terminal && tk.textKey.length) ranges.push({...clone(terminal),from:tk.textKey.length});
  tk.textStyleRange=ranges;
  delete tk.engineData;
  return tk;
}
function verifyApplied(actual, expected, config) {
  validateRanges(actual);
  if (actual.textKey!==expected.textKey) throw Error('回读文本发生变化');
  const problems=[],scale=scaleOf(actual);
  for (const p of expected.textStyleRange) {
    if (p.from>=actual.textKey.length) continue;
    for (const a of actual.textStyleRange) {
      const from=Math.max(p.from,a.from),to=Math.min(p.to,a.to,actual.textKey.length);
      if (from>=to) continue;
      const side=isCJK(actual.textKey[from])?'cn':'en';
      const wanted=config[side+'Font'];
      if (wanted && a.textStyle.fontPostScriptName!==wanted.postScriptName) problems.push({from,to,field:'font',wanted:wanted.postScriptName,got:a.textStyle.fontPostScriptName || null});
      if (config[side+'Size']!=null && Number.isFinite(numberValue(a.textStyle.size)) && Math.abs(numberValue(a.textStyle.size)*scale-config[side+'Size'])>0.5) problems.push({from,to,field:'size'});
      if (config[side+'Size']!=null && !Number.isFinite(numberValue(a.textStyle.size))) problems.push({from,to,field:'size'});
      if (config[side+'Tracking']!=null && a.textStyle.tracking!==config[side+'Tracking']) problems.push({from,to,field:'tracking'});
      if (config.syncColor && config[side+'Color']) {
        const color=a.textStyle.color || {},want=config[side+'Color'];
        if (!['red','grain','blue'].every((k,i)=>Number.isFinite(color[k])&&Math.abs(color[k]-want[['r','g','b'][i]]*255)<=1)) problems.push({from,to,field:'color'});
      }
    }
  }
  return problems;
}
function restored(actual, original) {
  validateRanges(actual); validateRanges(original);
  if (actual.textKey!==original.textKey) return false;
  // Compare every original boundary against every overlapping returned style.
  for (const p of original.textStyleRange) for (const a of actual.textStyleRange) {
    if (Math.max(p.from,a.from)>=Math.min(p.to,a.to,original.textKey.length)) continue;
    if (JSON.stringify(p.textStyle)!==JSON.stringify(a.textStyle)) return false;
  }
  return JSON.stringify(actual.paragraphStyleRange)===JSON.stringify(original.paragraphStyleRange) && JSON.stringify(actual.transform)===JSON.stringify(original.transform);
}
module.exports={isCJK,segmentsOf,aggregate,buildTextKey,verifyApplied,validateRanges,restored};
