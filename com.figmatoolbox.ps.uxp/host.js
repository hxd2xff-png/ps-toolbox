'use strict';
const ps=require('photoshop');
const logic=require('./core.js');
const HOST_VERSION='0.2.6';
function selection() {
  const doc=ps.app.activeDocument;
  if (!doc) return {doc:null,layers:[],source:'no-document',failed:[]};
  const layers=[],seen=new Set(),failed=[];
  // LayerKind 在部分 UXP 运行时不可读（ps.constants 或 LayerKind 为 undefined）。
  // 不能直接比较枚举：那会在第一层就抛错，被 catch 后表现为「选中文本却 0 个文本层」。
  // 枚举可用时以它为准，不可用时退回结构判断：有 layers = 组，有 textItem = 文本层。
  let K=null;
  try { K=ps.constants && ps.constants.LayerKind; } catch (e) { K=null; }
  const TEXT=K && K.TEXT!=null ? K.TEXT : null;
  const GROUP=K && K.GROUP!=null ? K.GROUP : null;
  function isText(layer) {
    try { if (TEXT!=null && layer.kind===TEXT) return true; } catch (e) {}
    try { return !!layer.textItem; } catch (e) { return false; }
  }
  function children(layer) {
    try {
      if (GROUP!=null && layer.kind===GROUP) return layer.layers || null;
    } catch (e) {}
    try {
      const inner=layer.layers;
      return inner && inner.length ? inner : null;
    } catch (e) { return null; }
  }
  function visit(layer) {
    try {
      if (!layer) return;
      const id=layer.id;
      if (id!=null) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      const kids=children(layer);
      if (kids) { for (const child of kids) visit(child); return; }
      if (isText(layer)) layers.push(layer);
    } catch (e) { failed.push({id:layer.id,name:layer.name,stage:'collect',reason:String(e.message || e)}); }
  }
  for (const layer of doc.activeLayers || []) visit(layer);
  return {doc,layers,failed,source:'activeLayers'};
}
async function command(desc) {
  const results=await ps.action.batchPlay([desc],{});
  const result=results[0];
  if (!result || result._obj==='error') throw Error(result && result.message || 'batchPlay 未返回有效结果');
  return result;
}
async function readText(id) {
  const result=await command({_obj:'get',_target:[{_property:'textKey'},{_ref:'layer',_id:id}],_options:{dialogOptions:'dontDisplay'}});
  return logic.validateRanges(result.textKey);
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Photoshop may acknowledge a textLayer set before the layer's textKey read-back is
// fully settled (font substitution/range normalization). Reading once made the same
// apply intermittently fail verification and roll back. Re-read a few times before
// declaring a mismatch; every attempt still has to verify against the request.
async function verifyWrite(id,expected,config) {
  let last=null,problems=[],lastError=null,fontOnly=null;
  const waits=[0,50,100,200,400];
  for (const wait of waits) {
    if (wait) await delay(wait);
    try {
      last=await readText(id);
      problems=logic.verifyApplied(last,expected,config);
      const hard=problems.filter(p=>p.field!=='font');
      const font=problems.filter(p=>p.field==='font');
      // CEP treats a Photoshop font substitution as a distinct outcome: the write
      // stays, the layer is not counted as verified, and it is reported as
      // "字体被替换" (host.jsx:944-973). Rolling the layer back here made a normal
      // substitution look like an intermittent apply failure.
      if (!hard.length) {
        if (!font.length) return {textKey:last,substitutions:[]};
        // A read immediately after the write can still show the old font. Confirm
        // the mismatch once more before calling it a real substitution.
        if (fontOnly) return {textKey:last,substitutions:font};
        fontOnly=font;
        continue;
      }
      fontOnly=null;
    } catch(e) {
      lastError=e;problems=[];
    }
  }
  if (lastError && !problems.length) throw lastError;
  if (fontOnly) return {textKey:last,substitutions:fontOnly};
  const err=Error('区间回读与请求不符');
  err.ranges=problems;
  err.hardProblems=problems.filter(p=>p.field!=='font');
  err.attempts=waits.length;
  throw err;
}
// The CEP host caches its font index for the whole session (host.jsx:382). UXP
// font instances are cross-process proxies, so reading family/style/name costs
// one round trip each: enumerating without a cache is what froze Photoshop while
// the panel opened. Cache once, reuse for detect() and resolveConfig().
let fontCache=null;
function fonts() {
  if (fontCache) return fontCache;
  const list=[];
  try {
    for (const f of ps.app.fonts) {
      try { list.push({family:f.family,style:f.style,postScriptName:f.postScriptName}); } catch(e) {}
    }
  } catch(e) { return []; }
  list.sort((a,b)=>{
    const x=(a.family+' '+a.style).toLowerCase(),y=(b.family+' '+b.style).toLowerCase();
    return x<y?-1:x>y?1:0;
  });
  fontCache=list;
  return fontCache;
}
function invalidateFonts() { fontCache=null; }
// Detection only needs the fonts the selection actually uses. ps.app.fonts has a
// documented by-name lookup (PS 23.0+), so resolve the PostScript names found in
// the text descriptors instead of enumerating the whole library per detect().
const psFontCache=new Map();
async function fontsByPSName(names) {
  const out=[];
  for (const name of names) {
    if (!name) continue;
    if (psFontCache.has(name)) { const hit=psFontCache.get(name); if (hit) out.push(hit); continue; }
    let hit=null;
    try {
      const f=typeof ps.app.fonts.getByName==='function' ? await ps.app.fonts.getByName(name) : null;
      if (f) hit={family:f.family,style:f.style,postScriptName:f.postScriptName||name};
    } catch(e) { hit=null; }
    // Some runtime builds expose the collection but not getByName. Falling back
    // to the cached index keeps detected fonts recognizable instead of blanking
    // every field as "unrecognized".
    if (!hit) hit=fonts().find(f=>f.postScriptName===name) || null;
    psFontCache.set(name,hit);
    if (hit) out.push(hit);
  }
  return out;
}
function psNamesIn(records) {
  const seen=new Set();
  for (const r of records) for (const rg of (r.tk && r.tk.textStyleRange) || []) {
    const n=rg.textStyle && rg.textStyle.fontPostScriptName;
    if (n) seen.add(n);
  }
  return Array.from(seen);
}
async function detect() {
  const s=selection(),records=[],failed=[...s.failed];
  for (const l of s.layers) {
    try { records.push({id:l.id,name:l.name,tk:await readText(l.id)}); }
    catch(e) { failed.push({id:l.id,name:l.name,stage:'read',reason:String(e.message || e)}); }
  }
  const subset=await fontsByPSName(psNamesIn(records));
  return {...logic.aggregate(records,subset,failed),source:s.source,documentId:s.doc?s.doc.id:null};
}
// CEP stops before the first write when a requested font is not installed and
// reports which family+style is missing (host.jsx:911-917). The same answer has to
// reach the panel here, so resolveConfig reports the gap instead of throwing on it.
function resolveConfig(config) {
  const available=fonts(),resolved={...config},missingFonts=[];
  for (const side of ['cn','en']) {
    const wanted=config[side+'Font'];
    if (!wanted && config[side+'Size']==null && config[side+'Tracking']==null && !(config.syncColor && config[side+'Color'])) continue;
    const match=wanted && available.find(f=>f.family===wanted.family && f.style===wanted.style);
    if (wanted && !match) missingFonts.push(String(wanted.family)+(wanted.style?' '+String(wanted.style):''));
    resolved[side+'Font']=match || null;
  }
  resolved.missingFonts=missingFonts;
  return resolved;
}
async function apply(config) {
  const s=selection(),out={operation:'font-mixer',source:s.source,documentId:s.doc?s.doc.id:null,total:s.layers.length,ok:0,failed:[...s.failed],missingFonts:[],substituted:[],notes:[],layers:[]};
  if (!s.doc || !s.layers.length) return out;
  const resolved=resolveConfig(config);
  // Nothing is written when a font is missing: telling the user the layer count they
  // asked for while every glyph stays unchanged is the one failure mode they cannot
  // see for themselves.
  if (resolved.missingFonts.length) { out.missingFonts=resolved.missingFonts.slice(); return out; }
  try {
    await ps.core.executeAsModal(async ctx=>{
      for (const layer of s.layers) {
        if (ctx.isCancelled) { out.cancelled=true; return; }
        let original=null,suspension=null,attempted=false,stage='read';
        const recordFailure=async(e,cancelled)=>{
          let state=attempted?'unknown':'unchanged',rollbackError=null;
          if (suspension!==null) {
            try {
              await ctx.hostControl.resumeHistory(suspension,false); suspension=null;
              const back=await readText(layer.id);
              if (logic.restored(back,original)) state='rolled-back';
            } catch(rollback) { rollbackError=String(rollback.message || rollback); }
          }
          out.failed.push({id:layer.id,name:layer.name,stage,reason:String(e.message || e),ranges:e.ranges || [],writeAttempted:attempted,state,rollbackError,cancelled:!!cancelled,
            integrity:state==='rolled-back'?'回滚后逐区间复核通过':state==='unchanged'?'未发生写入':'可能部分修改，混排完整性未知'});
        };
        try {
          original=await readText(layer.id);
          if (!original.textKey.length) { out.layers.push({id:layer.id,name:layer.name,state:'empty'}); continue; }
          let next=logic.buildTextKey(original,resolved);
          let verifyConfig=resolved;
          let sizeNote=null;
          stage='suspend-history';
          suspension=await ctx.hostControl.suspendHistory({documentID:s.doc.id,name:'字体混排 UXP：'+layer.name});
          if (ctx.isCancelled) { out.cancelled=true; await recordFailure(Error('操作已取消'),true); return; }
          stage='write'; attempted=true;
          await command({_obj:'set',_target:[{_ref:'textLayer',_id:layer.id}],to:{...next,_obj:'textLayer'},_options:{dialogOptions:'dontDisplay'}});
          if (ctx.isCancelled) { out.cancelled=true; await recordFailure(Error('写入后操作已取消'),true); return; }
          stage='verify';
          let verified;
          try {
            verified=await verifyWrite(layer.id,next,resolved);
          } catch(e) {
            const hard=(e && e.hardProblems) || [];
            // CEP's size mode fallback rewrites without the size and keeps the
            // font/colour result when Photoshop silently refuses the size
            // (host.jsx:669-704). Do the same instead of failing the whole layer.
            if (!hard.length || !hard.every(p=>p.field==='size')) throw e;
            const withoutSize={...resolved,cnSize:null,enSize:null};
            next=logic.buildTextKey(original,withoutSize);
            verifyConfig=withoutSize;
            await command({_obj:'set',_target:[{_ref:'textLayer',_id:layer.id}],to:{...next,_obj:'textLayer'},_options:{dialogOptions:'dontDisplay'}});
            verified=await verifyWrite(layer.id,next,verifyConfig);
            const first=hard[0]||{};
            sizeNote='字号未能写入'+(first.wanted!=null?'（请求 '+first.wanted+'）':'')+'，已只应用字体';
          }
          // Photoshop can keep every size/colour/tracking value but resolve a variable
          // font's PostScript name to the collection's default instance. Rewriting only
          // the font metadata without a PostScript name lets the host select the named
          // instance by family/style; the read-back then proves which path worked.
          if (verified.substitutions && verified.substitutions.length &&
              (resolved.cnFont || resolved.enFont)) {
            stage='font-fallback';
            const fallback=logic.buildTextKey(original,verifyConfig,{fontMode:'family-style'});
            await command({_obj:'set',_target:[{_ref:'textLayer',_id:layer.id}],to:{...fallback,_obj:'textLayer'},_options:{dialogOptions:'dontDisplay'}});
            if (ctx.isCancelled) { out.cancelled=true; await recordFailure(Error('字体回退写入后操作已取消'),true); return; }
            stage='verify-font-fallback';
            next=fallback;
            verified=await verifyWrite(layer.id,next,verifyConfig);
          }
          stage='commit-history';
          await ctx.hostControl.resumeHistory(suspension,true);
          suspension=null;
          if (sizeNote) out.notes.push(layer.name+'：'+sizeNote);
          const substituted=(verified && verified.substitutions) || [];
          if (substituted.length) {
            const first=substituted[0];
            const wanted=first.wantedLabel || first.wanted || '?';
            const got=[first.gotFamily,first.gotStyle].filter(Boolean).join(' / ') || first.got || '?';
            out.substituted.push(layer.name+' -> 字体被 Photoshop 替换：请求 '+
              wanted+'，实际 '+got+
              '（区间 '+first.from+'-'+first.to+'）');
            out.layers.push({id:layer.id,name:layer.name,state:'substituted'});
          } else {
            out.ok++;
            out.layers.push({id:layer.id,name:layer.name,state:'verified'});
          }
        } catch(e) {
          await recordFailure(e,ctx.isCancelled);
          if (ctx.isCancelled) { out.cancelled=true; return; }
          if (suspension!==null) return; // Stop immediately; leave modal so host cancellation is honored.
        }
      }
    },{commandName:'字体混排 UXP'});
  } catch(e) { out.error=String(e.message || e); out.stage='modal'; }
  // Cancellation is a fact reported by the host, not something to infer from
  // how many layers were processed: one cancelled layer out of one is still a
  // cancellation. Count the layers we never reached separately.
  const done=out.ok+out.substituted.length+out.failed.length+out.layers.filter(l=>l.state==='empty').length;
  out.unprocessed=Math.max(0,s.layers.length-done);
  return out;
}
// The UXP CharacterStyle property is the supported route for layer-scoped
// auto-kerning. batchPlay's textKey read-back does not carry autoKerning, so
// treating textKey as the source made every layer look like a failed write.
// Accept the plain enum value and the descriptor form used by other hosts.
function kerningOf(value) {
  if (value==null) return null;
  if (typeof value!=='object') return String(value);
  // An enum from another type is not the autoKerning enum, whatever its _value
  // says. Hosts that omit _enum still get through: the value is all we can read.
  if (value._enum!=null && String(value._enum)!=='autoKernType') return null;
  return value._value!=null ? String(value._value) : null;
}
function opticalKerningValue() {
  try {
    const types=ps.constants && ps.constants.AutoKernType;
    return types && types.OPTICAL!=null ? types.OPTICAL : null;
  } catch(e) { return null; }
}
function describeKerning(value) {
  try {
    if (value==null) return String(value);
    if (typeof value!=='object') return String(value);
    const json=JSON.stringify(value);
    return json && json!=='{}' ? json : Object.prototype.toString.call(value);
  } catch(e) { return Object.prototype.toString.call(value); }
}
function isOpticalKerning(value,optical) {
  if (value===optical) return true;
  const read=kerningOf(value),wanted=kerningOf(optical);
  if (read==null || wanted==null) return false;
  // Photoshop's UXP constant is "opticalKern"; some hosts/descriptors expose the
  // CEP spelling "optical". Both name the same kerning mode.
  const norm = s => String(s).toLowerCase().replace(/kern$/,'');
  return norm(read)===norm(wanted);
}
function autoKerning() {
  // leadingRequested:false is a fact — this build never asks Photoshop for auto
  // leading, and the panel reads the missing key as "was asked", misreporting.
  const s=selection(),out={nodes:0,applied:0,failed:0,empty:true,mode:'optical',optical:0,skipped:[],source:s.source,leadingRequested:false};
  out.nodes=s.layers.length;
  if (!s.layers.length) return out;
  out.empty=false;
  const optical=opticalKerningValue();
  if (optical==null) {
    out.mode='unsupported';
    out.failed=out.nodes;
    out.skipped.push('AutoKernType.OPTICAL unavailable in this Photoshop version');
    return out;
  }
  // CharacterStyle.autoKerning is the UXP equivalent of CEP's
  // TextItem.autoKerning = AutoKernType.OPTICAL. It is layer-scoped, so one
  // write and one read-back per selected text layer is enough.
  return ps.core.executeAsModal(async ctx=>{
    for (const layer of s.layers) {
      if (ctx.isCancelled) { out.cancelled=true; break; }
      try {
        const characterStyle=layer && layer.textItem && layer.textItem.characterStyle;
        if (!characterStyle) throw Error('CharacterStyle 不可用');
        characterStyle.autoKerning=optical;
        const back=characterStyle.autoKerning;
        if (!isOpticalKerning(back,optical)) throw Error('视觉字距未生效（回读 '+describeKerning(back)+'）');
        out.applied++;out.optical=out.applied;
      } catch(e) { out.failed++;out.skipped.push(String(layer.name)+': '+String(e.message||e)); }
    }
    out.mode=out.failed?'unsupported':(out.applied?'optical':'none');
    return out;
  },{commandName:'视觉字距 UXP'}).catch(e=>({...out,error:String(e.message||e),mode:'unsupported'}));
}
let colorPickerOpen=false;
async function pickColor(args) {
  if (colorPickerOpen) return {ok:false,busy:true,api:'pick-color'};
  colorPickerOpen=true;
  const rgb=args||{};
  const toByte=v=>Math.max(0,Math.min(255,Math.round((Number(v)||0)*255)));
  const clamp01=v=>Math.max(0,Math.min(1,Number(v)||0));
  const openPicker={
    _target:{_ref:'application'},
    _obj:'showColorPicker',
    context:'选择字色',
    color:{_obj:'RGBColor',red:toByte(rgb.r),green:toByte(rgb.g),blue:toByte(rgb.b)}
  };
  try {
    const results=await ps.core.executeAsModal(
      () => ps.action.batchPlay([openPicker],{}),
      {commandName:'选择字色'}
    );
    const result=Array.isArray(results) ? results[0] : results;
    if (!result || result._obj==='error') {
      throw Error(result && result.message || '拾色器没有返回有效结果');
    }
    if (result.value===false || result.canceled===true) {
      return {ok:false,canceled:true,api:'pick-color'};
    }
    const picked=result.RGBFloatColor || result.color || result;
    let sawChannel=false;
    function read(byteKeys,floatKeys) {
      for (const key of floatKeys) {
        const value=Number(picked[key]);
        if (picked[key]!=null && isFinite(value)) { sawChannel=true; return clamp01(value); }
      }
      for (const key of byteKeys) {
        const value=Number(picked[key]);
        if (picked[key]!=null && isFinite(value)) { sawChannel=true; return clamp01(value/255); }
      }
      return 0;
    }
    const out={
      ok:true,
      r:read(['red'],['redFloat']),
      g:read(['grain','green'],['greenFloat','grainFloat']),
      b:read(['blue'],['blueFloat']),
      notes:''
    };
    if (!sawChannel) throw Error('拾色器未返回 RGB 颜色');
    return out;
  } catch(e) {
    return {
      ok:false,
      error:String(e && e.message || e),
      api:'pick-color',
      stage:'showColorPicker',
      resultUnknown:false
    };
  } finally {
    colorPickerOpen=false;
  }
}
// The CEP host creates a throw-away document to prove the write path. UXP has no
// ExtendScript temporary-document path, so this reports the capability gap as a
// value the panel can label, never as a crash and never as a fake pass.
function selfTest() {
  return {
    operation:'selftest',
    supported:false,
    ok:false,
    skipped:true,
    reason:'UXP 版不做临时文档自检，请直接在真实图层上验证区间写入',
    checks:[{name:'temp-document',state:'unsupported'},{name:'range-write',state:'covered-by-font-mixer'}]
  };
}
function fontList() {
  const families=new Map();
  for (const f of fonts()) {
    if (!families.has(f.family)) families.set(f.family,[]);
    const styles=families.get(f.family);
    if (styles.indexOf(f.style)<0) styles.push(f.style);
  }
  return {families:Array.from(families.keys()).sort().map(family=>({family,styles:families.get(family)}))};
}
function selectionSig() {
  const s=selection();
  const ids=s.layers.map(l=>l.id).sort((a,b)=>a-b);
  return {sig:String(s.doc?s.doc.id:0)+':'+ids.join(','),from:s.source,textCount:ids.length,targetSig:ids.join(','),readState:s.failed.length?'partial':'ready',sourceNotes:[],failed:s.failed};
}
function ping() { return {pong:true,version:HOST_VERSION,syncColor:true}; }
// app.name / app.version 在部分 UXP 运行时读不到（面板里会显示 "undefined undefined"）。
// 只做属性读取，绝不走 BatchPlay：Get 在非 modal 状态下会弹 Photoshop 原生警告，
// 把「读诊断」变成打断用户的对话框。
function appInfo() {
  let name='Photoshop',version='',uxpHost='';
  try { if (ps.app.name) name=String(ps.app.name); } catch(e) {}
  try { if (ps.app.version) version=String(ps.app.version); } catch(e) {}
  try { const uxp=require('uxp'); uxpHost=String((uxp.host && uxp.host.version) || ''); } catch(e) {}
  return {name,version,uxpHost};
}
// One entry point for the panel. Every reply keeps the CEP shape
// {error, stage, ...}: a failure is a value the panel can show, never a
// silent rejection, and it says whether the layer may already be written.
async function dispatch(type,args) {
  let stage='call '+type;
  try {
    if (type==='ping') return ping();
    if (type==='sel-sig') return selectionSig();
    if (type==='diag') {
      const info=appInfo();
      const s=selection();
      return {host:HOST_VERSION,
        ps:info.version ? info.name+' '+info.version : info.name+'（版本不可读）',
        uxpHost:info.uxpHost || 'unknown',
        fonts:fontCache?fontCache.length:'not-indexed',layerSource:'activeLayers',
        textLayers:s.layers.length,selectionFailed:s.failed.slice(0,3),document:!!ps.app.activeDocument};
    }
    if (type==='list-fonts') return fontList();
    if (type==='pick-color') return pickColor(args);
    if (type==='selftest') return selfTest();
    if (type==='detect-font') return await detect();
    if (type==='font-mixer') return await apply(args || {});
    if (type==='auto-kerning') return autoKerning();
    return {error:'unknown type: '+type,api:type,stage,resultUnknown:false};
  } catch(e) {
    const writeAttempted=type==='font-mixer' && !!(e && e.writeAttempted);
    return {error:String(e && e.message || e),api:type,stage:String(e && e.stage || stage),writeAttempted,state:writeAttempted?'unknown':'unchanged',resultUnknown:writeAttempted};
  }
}
module.exports={selection,fonts,invalidateFonts,fontList,detect,apply,readText,selectionSig,ping,dispatch};
