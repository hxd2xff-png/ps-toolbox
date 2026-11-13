'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../com.figmatoolbox.ps.uxp/core.js');
const root=path.resolve(__dirname,'..');
const uxp=path.join(root,'com.figmatoolbox.ps.uxp');
const cep=path.join(root,'com.figmatoolbox.ps');
const manifest=JSON.parse(fs.readFileSync(path.join(uxp,'manifest.json'),'utf8'));
const tk=(text,ranges)=>({textKey:text,textStyleRange:ranges,paragraphStyleRange:[],transform:{xx:1}});
const range=(from,to,font,size,color={red:255,grain:0,blue:0})=>({from,to,textStyle:{fontPostScriptName:font,size:{_value:size},color}});

test('segmentsOf returns contiguous UTF-16 character ownership',()=>{
 assert.deepEqual(core.segmentsOf('中文abc，'),[{from:0,to:2,side:'cn'},{from:2,to:5,side:'en'},{from:5,to:6,side:'cn'}]);
});
test('validateRanges rejects gaps and incomplete coverage',()=>{
 assert.throws(()=>core.validateRanges(tk('ab',[range(0,1,'A',12),range(2,2,'A',12)])),/不连续/);
 assert.throws(()=>core.validateRanges(tk('abc',[range(0,2,'A',12)])),/覆盖不完整/);
});
test('aggregate scans all layers and surfaces cross-layer mixed values',()=>{
 const fonts=[{family:'Song',style:'Regular',postScriptName:'Song'},{family:'Sans',style:'Regular',postScriptName:'Sans'}];
 const records=[{id:1,name:'A',tk:tk('中a',[range(0,1,'Song',12),range(1,2,'Sans',10)])},{id:2,name:'B',tk:tk('中b',[range(0,1,'Other',12),range(1,2,'Sans',10)])}];
 const out=core.aggregate(records,fonts);
 assert.equal(out.fields.cnFont.state,'unrecognized');
 assert.equal(out.fields.enFont.state,'consistent');
 assert.equal(out.fields.cnSize.state,'consistent');
 assert.equal(out.fields.cnFont.sources.length,2);
});
test('buildTextKey splits ranges and applies side-specific requested properties',()=>{
 const original=tk('中a',[range(0,2,'Old',10)]);
 const config={cnFont:{postScriptName:'Song'},enFont:{postScriptName:'Sans'},cnSize:14,enSize:9,cnTracking:20,enTracking:-5,cnColor:{r:0,g:1,b:0},enColor:{r:0,g:0,b:1},syncColor:true};
 const out=core.buildTextKey(original,config);
 assert.deepEqual(out.textStyleRange.map(r=>[r.from,r.to,r.textStyle.fontPostScriptName,r.textStyle.size._value]),[[0,1,'Song',14],[1,2,'Sans',9]]);
 assert.equal(out.textStyleRange[0].textStyle.tracking,20);
 assert.equal(out.textStyleRange[1].textStyle.tracking,-5);
 assert.equal(out.textStyleRange[0].textStyle.color.grain,255);
 assert.equal(out.textStyleRange[1].textStyle.color.blue,255);
 assert.equal(original.textStyleRange.length,1);
});
test('verifyApplied detects a font substitution after write',()=>{
 const expected=tk('中a',[range(0,1,'Song',12),range(1,2,'Sans',10)]);
 const actual=tk('中a',[range(0,1,'Fallback',12),range(1,2,'Sans',10)]);
 assert.equal(core.verifyApplied(actual,expected,{cnFont:{postScriptName:'Song'},enFont:{postScriptName:'Sans'},cnSize:null,enSize:null,syncColor:false}).length,1);
});
test('aggregate and write preserve numeric tracking on both sides',()=>{
 const source=tk('中a',[{...range(0,2,'Song',12),textStyle:{...range(0,2,'Song',12).textStyle,tracking:5}}]);
 const fonts=[{family:'Song',style:'Regular',postScriptName:'Song'}];
 const found=core.aggregate([{id:1,name:'A',tk:source}],fonts);
 assert.equal(found.fields.cnTracking.value,5);
 const next=core.buildTextKey(source,{cnTracking:20,enTracking:-5});
 assert.equal(next.textStyleRange[0].textStyle.tracking,20);
 assert.equal(next.textStyleRange[1].textStyle.tracking,-5);
 assert.deepEqual(core.verifyApplied(next,next,{cnTracking:20,enTracking:-5}),[]);
});
test('manifest and runtime boundaries keep UXP separate from CEP',()=>{
 assert.equal(manifest.manifestVersion,5);assert.equal(manifest.id,'com.figmatoolbox.ps.uxp');assert.equal(manifest.host.app,'PS');assert.equal(manifest.host.minVersion,'25.0');assert.equal(manifest.host.data.apiVersion,2);
 const host=fs.readFileSync(path.join(uxp,'host.js'),'utf8');
 assert.match(host,/require\('photoshop'\)/);assert.match(host,/activeLayers/);assert.match(host,/executeAsModal/);assert.doesNotMatch(host,/evalScript|CSInterface|window\.cep|selectedLayers|activeLayers\s*=/);
 const files=fs.readdirSync(uxp);assert.ok(files.includes('manifest.json'));assert.ok(files.includes('index.html'));assert.ok(files.every(n=>!n.toLowerCase().includes('install-photoshop-plugin')));
 const cepManifest=fs.readFileSync(path.join(cep,'CSXS','manifest.xml'),'utf8');assert.match(cepManifest,/com\.figmatoolbox\.ps/);assert.doesNotMatch(cepManifest,/com\.figmatoolbox\.ps\.uxp/);
});

const Module=require('node:module');
async function withFakePhotoshop(fake,work){
 const filename=path.join(uxp,'host.js'), original=Module._load;
 delete require.cache[filename];
 Module._load=function(request,parent,isMain){if(request==='photoshop'&&parent.filename===filename)return fake;return original.call(this,request,parent,isMain);};
 try{return await work(require(filename));}finally{Module._load=original;delete require.cache[filename];}
}
function makePhotoshop({cancelAfterWrite=false,failRollback=false,modalError=null,failWriteOn=[],layerIds=[1]}){
 const docs=new Map(layerIds.map(id=>[id,tk('中a',[range(0,2,'Old',12)])]));
 let writes=0,resumes=0,cancelled=false;
 const fake={constants:{LayerKind:{GROUP:'group',TEXT:'text'}},app:{activeDocument:{id:7,activeLayers:layerIds.map(id=>({id,name:'L'+id,kind:'text'}))},fonts:[{family:'New',style:'Regular',postScriptName:'New'}]},action:{batchPlay:async([d])=>{
   if(d._obj==='get') return [{textKey:docs.get(d._target[1]._id)}];
   if(d._obj==='set'){const id=d._target[0]._id;if(failWriteOn.includes(id))throw Error('write rejected by host');writes++;docs.set(id,d.to);if(cancelAfterWrite)cancelled=true;return [{}];}
   throw Error('unexpected descriptor');
 }},core:{executeAsModal:async(fn)=>{if(modalError)throw Error(modalError);return fn({get isCancelled(){return cancelled;},hostControl:{suspendHistory:async()=>({id:1}),resumeHistory:async(_s,commit)=>{resumes++;if(!commit&&failRollback)throw Error('rollback failed');}}});}}};
 return {fake,docs,stats:()=>({writes,resumes})};
}
test('host apply records write cancellation and verifies rollback before claiming recovery',async()=>{
 const f=makePhotoshop({cancelAfterWrite:true,layerIds:[1,2]});
 await withFakePhotoshop(f.fake,async host=>{
   const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
   assert.equal(out.failed.length,1);assert.equal(out.failed[0].id,1);assert.equal(out.failed[0].writeAttempted,true);assert.equal(out.failed[0].cancelled,true);assert.equal(out.failed[0].state,'unknown');assert.match(out.failed[0].integrity,/未知/);assert.equal(out.cancelled,true);
   assert.deepEqual(f.stats(),{writes:1,resumes:1});
 });
});
test('host apply leaves state unknown if history rollback fails',async()=>{
 const f=makePhotoshop({cancelAfterWrite:true,failRollback:true});
 await withFakePhotoshop(f.fake,async host=>{
   const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
   assert.equal(out.failed[0].state,'unknown');assert.match(out.failed[0].rollbackError,/rollback failed/);
 });
});
test('host surfaces modal collision without attempting document writes',async()=>{
 const f=makePhotoshop({modalError:'modal collision'});
 await withFakePhotoshop(f.fake,async host=>{const out=await host.apply({cnFont:{family:'New',style:'Regular'}});assert.equal(out.stage,'modal');assert.match(out.error,/modal collision/);assert.equal(f.stats().writes,0);});
});
test('host continues with later layers after a layer-local read failure',async()=>{
 const f=makePhotoshop({layerIds:[1,2]});let first=true;const original=f.fake.action.batchPlay;
 f.fake.action.batchPlay=async([d],opts)=>{if(d._obj==='get'&&d._target[1]._id===1&&first){first=false;throw Error('read failed');}return original([d],opts);};
 await withFakePhotoshop(f.fake,async host=>{const out=await host.apply({cnFont:{family:'New',style:'Regular'}});assert.equal(out.failed[0].id,1);assert.equal(out.ok,1);assert.equal(out.layers[0].id,2);});
});
// P2 regression: a single selected layer that gets cancelled must still report
// cancelled. Counting "processed < total" cannot see this: 0 ok + 1 failed == 1 total.
test('host apply flags cancellation even when the only selected layer was the cancelled one',async()=>{
 const f=makePhotoshop({cancelAfterWrite:true,layerIds:[1]});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
  assert.equal(out.cancelled,true,'单层取消也必须显式标记 cancelled');
  assert.equal(out.failed.length,1);
  assert.equal(out.unprocessed,0,'已处理的层数要单独统计，不从 cancelled 反推');
 });
});
// Cancellation before the first write: nothing attempted, nothing to roll back.
test('host apply flags cancellation before any write without claiming a rollback',async()=>{
 const f=makePhotoshop({layerIds:[1]});
 let reads=0;const original=f.fake.action.batchPlay;
 f.fake.action.batchPlay=async([d],opts)=>{if(d._obj==='get'&&reads++===0)throw Object.assign(Error('cancelled'),{isCancelled:true});return original([d],opts);};
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'}});
  assert.equal(f.stats().writes,0,'未发生写入');
  assert.equal(out.failed[0].writeAttempted,false);
  assert.equal(out.failed[0].state,'unchanged','写入前失败不能声称已回滚');
 });
});
// Positive path for the rollback machinery: the host rejects the write, history
// is resumed without commit, and the layer really reads back unchanged.
test('host apply reports rolled-back only after reading the restored text back',async()=>{
 const f=makePhotoshop({failWriteOn:[1],layerIds:[1,2]});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
  assert.equal(out.failed.length,1);
  assert.equal(out.failed[0].id,1);
  assert.equal(out.failed[0].state,'rolled-back');
  assert.match(out.failed[0].integrity,/回滚后逐区间复核通过/);
  assert.equal(out.ok,1,'后一层应继续并成功');
  assert.equal(out.layers[0].id,2);
  assert.equal(out.unprocessed,0);
  assert.notEqual(out.cancelled,true,'非取消失败不能标成取消');
 });
});