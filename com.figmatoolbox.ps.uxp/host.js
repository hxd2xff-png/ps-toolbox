'use strict';
const ps=require('photoshop');
const logic=require('./core.js');
function selection() {
  const doc=ps.app.activeDocument;
  if (!doc) return {doc:null,layers:[],source:'no-document',failed:[]};
  const layers=[],seen=new Set(),failed=[];
  function visit(layer) {
    try {
      if (seen.has(layer.id)) return;
      seen.add(layer.id);
      if (layer.kind===ps.constants.LayerKind.GROUP) for (const child of layer.layers) visit(child);
      else if (layer.kind===ps.constants.LayerKind.TEXT) layers.push(layer);
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
function fonts() {
  return Array.from(ps.app.fonts).map(f=>({family:f.family,style:f.style,postScriptName:f.postScriptName}));
}
async function detect() {
  const s=selection(),records=[],failed=[...s.failed];
  for (const l of s.layers) {
    try { records.push({id:l.id,name:l.name,tk:await readText(l.id)}); }
    catch(e) { failed.push({id:l.id,name:l.name,stage:'read',reason:String(e.message || e)}); }
  }
  return {...logic.aggregate(records,fonts(),failed),source:s.source,documentId:s.doc?s.doc.id:null};
}
function resolveConfig(config) {
  const available=fonts(),resolved={...config};
  for (const side of ['cn','en']) {
    const wanted=config[side+'Font'];
    if (!wanted && config[side+'Size']==null && config[side+'Tracking']==null && !(config.syncColor && config[side+'Color'])) continue;
    const match=wanted && available.find(f=>f.family===wanted.family && f.style===wanted.style);
    if (wanted && !match) throw Error((side==='cn'?'中文':'英文')+'字体未安装或样式不存在');
    resolved[side+'Font']=match || null;
  }
  return resolved;
}
async function apply(config) {
  const s=selection(),out={operation:'font-mixer',source:s.source,documentId:s.doc?s.doc.id:null,total:s.layers.length,ok:0,failed:[...s.failed],layers:[]};
  if (!s.doc || !s.layers.length) return out;
  const resolved=resolveConfig(config);
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
          const next=logic.buildTextKey(original,resolved);
          stage='suspend-history';
          suspension=await ctx.hostControl.suspendHistory({documentID:s.doc.id,name:'字体混排 UXP：'+layer.name});
          if (ctx.isCancelled) { out.cancelled=true; await recordFailure(Error('操作已取消'),true); return; }
          stage='write'; attempted=true;
          await command({_obj:'set',_target:[{_ref:'textLayer',_id:layer.id}],to:{...next,_obj:'textLayer'},_options:{dialogOptions:'dontDisplay'}});
          if (ctx.isCancelled) { out.cancelled=true; await recordFailure(Error('写入后操作已取消'),true); return; }
          stage='verify';
          const actual=await readText(layer.id),problems=logic.verifyApplied(actual,next,resolved);
          if (problems.length) { const e=Error('区间回读与请求不符'); e.ranges=problems; throw e; }
          stage='commit-history';
          await ctx.hostControl.resumeHistory(suspension,true);
          suspension=null;out.ok++;out.layers.push({id:layer.id,name:layer.name,state:'verified'});
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
  const done=out.ok+out.failed.length+out.layers.filter(l=>l.state==='empty').length;
  out.unprocessed=Math.max(0,s.layers.length-done);
  return out;
}
module.exports={selection,fonts,detect,apply,readText};
