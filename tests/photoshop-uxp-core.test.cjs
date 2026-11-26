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

test('scaled UXP size writes round-trip through verification and displayed aggregation',()=>{
 for (const scale of [0.5,2,-2]) {
  const original=tk('中a',[range(0,2,'Old',10)]);original.transform.xx=scale;
  const config={cnSize:24,enSize:18};
  const next=core.buildTextKey(original,config);
  // CEP writes the requested size raw; Photoshop stores the pre-transform base.
  assert.deepEqual(next.textStyleRange.map(r=>r.textStyle.size._value),[24,18]);
  const readBack=JSON.parse(JSON.stringify(next));
  readBack.textStyleRange.forEach(r=>{r.textStyle.size._value/=Math.abs(scale);});
  assert.deepEqual(core.verifyApplied(readBack,next,config),[]);
  const found=core.aggregate([{id:1,name:'scaled',tk:readBack}]);
  assert.equal(found.fields.cnSize.value,24);assert.equal(found.fields.enSize.value,18);
  assert.equal(original.textStyleRange[0].textStyle.size._value,10);
 }
});
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
test('buildTextKey writes the full font trio so variable-font instances resolve',()=>{
 const original=tk('中文',[{...range(0,2,'Old',12),textStyle:{...range(0,2,'Old',12).textStyle,fontName:'Old Family',fontStyleName:'Light',fontDesignAxes:[{_obj:'fontDesignAxes',fontDesignAxesVectors:300}]}}]);
 const font={family:'Noto Sans SC',style:'Medium',postScriptName:'NotoSansSC-Medium'};
 const out=core.buildTextKey(original,{cnFont:font,enFont:font});
 const style=out.textStyleRange[0].textStyle;
 assert.equal(style.fontPostScriptName,'NotoSansSC-Medium');
 assert.equal(style.fontName,'Noto Sans SC');
 assert.equal(style.fontStyleName,'Medium');
 assert.equal(style.fontAvailable,true);
 // Photoshop prefers a cloned face's design axis over the new named instance, so a
 // stale Light axis (300) must never survive into the Medium write.
 assert.equal(style.fontDesignAxes,undefined);
});
test('buildTextKey can omit the PS name so a variable-font named instance resolves by family/style',()=>{
 const original=tk('中文',[{...range(0,2,'Old',12),textStyle:{...range(0,2,'Old',12).textStyle,fontDesignAxes:[{_obj:'fontDesignAxes',fontDesignAxesVectors:300}]}}]);
 const font={family:'Noto Sans SC',style:'Medium',postScriptName:'NotoSansSC-Medium'};
 const out=core.buildTextKey(original,{cnFont:font,enFont:font},{fontMode:'family-style'});
 const style=out.textStyleRange[0].textStyle;
 assert.equal(style.fontPostScriptName,undefined);
 assert.equal(style.fontName,'Noto Sans SC');
 assert.equal(style.fontStyleName,'Medium');
 assert.equal(style.fontAvailable,true);
 assert.equal(style.fontDesignAxes,undefined);
});
test('buildTextKey clears a stale variable-font axis on every split range',()=>{
 const original=tk('中a',[{from:0,to:2,textStyle:{fontPostScriptName:'NotoSansSC-Light',fontName:'Noto Sans SC',fontStyleName:'Light',fontDesignAxes:[{_obj:'fontDesignAxes',fontDesignAxesVectors:300}],size:{_value:12}}}]);
 const cn={family:'Noto Sans SC',style:'Medium',postScriptName:'NotoSansSC-Medium'};
 const en={family:'Bahnschrift',style:'Bold Condensed',postScriptName:'Bahnschrift-BoldCondensed'};
 const out=core.buildTextKey(original,{cnFont:cn,enFont:en});
 assert.equal(out.textStyleRange.length,2);
 for (const range of out.textStyleRange) assert.equal(range.textStyle.fontDesignAxes,undefined);
});
test('verifyApplied accepts a normalized PS name when family/style is the requested instance',()=>{
 const expected=tk('中',[range(0,1,'NotoSansSC-Medium',12)]);
 const actual=tk('中',[{from:0,to:1,textStyle:{fontPostScriptName:'NotoSansSC-Light',fontName:'Noto Sans SC',fontStyleName:'Medium',size:{_value:12}}}]);
 const config={cnFont:{family:'Noto Sans SC',style:'Medium',postScriptName:'NotoSansSC-Medium'},cnSize:null,syncColor:false};
 assert.deepEqual(core.verifyApplied(actual,expected,config),[]);
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
 assert.equal(manifest.featureFlags.CSSNextSupport,true,'box-shadow/transform need the UXP CSSNextSupport flag');
 assert.equal(manifest.requiredPermissions.localFileSystem,'fullAccess');
 const host=fs.readFileSync(path.join(uxp,'host.js'),'utf8');
 assert.equal(/const HOST_VERSION='([^']+)'/.exec(host)[1],manifest.version,'host.js 版本必须与 manifest 一致');
 assert.match(host,/require\('photoshop'\)/);assert.match(host,/activeLayers/);assert.match(host,/executeAsModal/);assert.doesNotMatch(host,/evalScript|CSInterface|window\.cep|selectedLayers|activeLayers\s*=/);
 const files=fs.readdirSync(uxp);assert.ok(files.includes('manifest.json'));assert.ok(files.includes('index.html'));assert.ok(files.every(n=>!n.toLowerCase().includes('install-photoshop-plugin')));
 const cepManifest=fs.readFileSync(path.join(cep,'CSXS','manifest.xml'),'utf8');assert.match(cepManifest,/com\.figmatoolbox\.ps/);assert.doesNotMatch(cepManifest,/com\.figmatoolbox\.ps\.uxp/);
});

test('selection falls back to structure when LayerKind is unavailable',async()=>{
 const fake={
  constants:{},
  app:{activeDocument:{id:1,activeLayers:[{id:2,name:'group',kind:'?',layers:[{id:3,name:'text',kind:'?',textItem:{kind:'text'}}]}]}},
  action:{batchPlay:async()=>[{}]},
  core:{executeAsModal:async(fn)=>fn({isCancelled:false,hostControl:{}})},
 };
 await withFakePhotoshop(fake,async host=>{
  const s=host.selection();
  assert.deepEqual(s.layers.map(l=>l.id),[3]);
  assert.equal(s.failed.length,0);
 });
});

const Module=require('node:module');
async function withFakePhotoshop(fake,work){
 const filename=path.join(uxp,'host.js'), original=Module._load;
 delete require.cache[filename];
 Module._load=function(request,parent,isMain){if(request==='photoshop'&&parent.filename===filename)return fake;return original.call(this,request,parent,isMain);};
 try{return await work(require(filename));}finally{Module._load=original;delete require.cache[filename];}
}
// Options are read from an explicit object, not a destructured parameter list: a
// destructured default rewrites a passed `undefined`, and `arguments` stops mirroring
// the parameters the moment anyone turns this into an arrow function.
function makePhotoshop(options){
 const opts=options||{}, {cancelAfterWrite=false,failRollback=false,modalError=null,failWriteOn=[],layerIds=[1],kerningReadBack='opticalKern',kerningEnum='autoKernType',kerningText='中a',fonts=['New'],substituteFont=false,variableFontNeedsFamilyOnly=false,failSize=false,staleReadsAfterWrite=0}=opts;
 const docs=new Map(layerIds.map(id=>[id,tk(kerningText,[range(0,kerningText.length,'Old',12)])]));
 const kerning=new Map(layerIds.map(id=>[id,kerningReadBack]));
 let writes=0,kerningWrites=0,resumes=0,cancelled=false,stale=staleReadsAfterWrite;
 // UXP exposes auto-kerning through TextItem.characterStyle.autoKerning. Model a host
 // that accepts the write only when the requested read-back is optical; every other
 // case keeps the old value and exposes how a refused layer actually behaves.
 const activeLayers=layerIds.map(id=>{
   const layer={id,name:'L'+id,kind:'text'};
   layer.textItem={characterStyle:{
     get autoKerning(){
       const value=kerning.get(id);
       return kerningEnum && kerningEnum!=='autoKernType' && value!=null
         ? {_enum:kerningEnum,_value:value} : value;
     },
     set autoKerning(value){
       kerningWrites++;
       if(kerningReadBack==='opticalKern') kerning.set(id,value);
     }
   }};
   return layer;
 });
 const fake={constants:{LayerKind:{GROUP:'group',TEXT:'text'},AutoKernType:{OPTICAL:'opticalKern',METRICS:'metrics',MANUAL:'manual'}},app:{activeDocument:{id:7,activeLayers},fonts:fonts.map(f=>typeof f==='string'?{family:f,style:'Regular',postScriptName:f}:f)},action:{batchPlay:async([d])=>{
   if(d._obj==='get'){
     const doc=docs.get(d._target[1]._id);
     const out={...doc};
     if(writes>0 && stale>0){
       stale--;
       out.textStyleRange=out.textStyleRange.map(r=>({...r,textStyle:{...r.textStyle,size:{...r.textStyle.size,_value:999}}}));
     }
     return [{textKey:out}];
   }
   if(d._obj==='set'){const id=d._target[0]._id;if(failWriteOn.includes(id))throw Error('write rejected by host');writes++;
     // Store the new content only: d.to is the write *descriptor*, and keeping it whole
     // would leave the fake document without the textKey a read-back has to find.
     const previous=docs.get(id);
     const oldSize=previous.textStyleRange[0] && previous.textStyleRange[0].textStyle.size;
     const written=(d.to.textStyleRange||previous.textStyleRange).map(r=>{
       const style={...r.textStyle};
       if(variableFontNeedsFamilyOnly && style.fontName){
         if(style.fontPostScriptName){
           style.fontPostScriptName='NotoSansSC-Light';
           style.fontStyleName='Light';
         }else style.fontPostScriptName='NotoSansSC-Medium';
       }
       if(substituteFont && (style.fontPostScriptName || style.fontName)){
         style.fontPostScriptName='Fallback';
         style.fontName='Fallback';
         style.fontStyleName='Regular';
       }
       if(failSize && oldSize) style.size={...oldSize};
       return {...r,textStyle:style};
     });
     docs.set(id,{...previous,textStyleRange:written});
     if(cancelAfterWrite)cancelled=true;return [{}];}
   throw Error('unexpected descriptor');
 }},core:{executeAsModal:async(fn)=>{if(modalError)throw Error(modalError);return fn({get isCancelled(){return cancelled;},hostControl:{suspendHistory:async()=>({id:1}),resumeHistory:async(_s,commit)=>{resumes++;if(!commit&&failRollback)throw Error('rollback failed');}}});}}};
 return {fake,docs,stats:()=>({writes,kerningWrites,resumes})};
}
test('host apply records write cancellation and verifies rollback before claiming recovery',async()=>{
 const f=makePhotoshop({cancelAfterWrite:true,layerIds:[1,2]});
 await withFakePhotoshop(f.fake,async host=>{
   const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
   assert.equal(out.failed.length,1);assert.equal(out.failed[0].id,1);assert.equal(out.failed[0].writeAttempted,true);assert.equal(out.failed[0].cancelled,true);assert.equal(out.failed[0].state,'unknown');assert.match(out.failed[0].integrity,/未知/);assert.equal(out.cancelled,true);
   assert.deepEqual(f.stats(),{writes:1,kerningWrites:0,resumes:1});
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
// CEP host.jsx:826 reassigns *every* symbol position when symbolFontSide is set and
// puts no CJK guard in front of it, so fullwidth punctuation (U+FF0C, U+3002 and the
// rest of the U+3000-303F / U+FF00-FFEF punctuation run) must follow the chosen side.
// Without this the option only worked for halfwidth , . ( — the CJK punctuation a
// Chinese user cares about silently stayed on the cn font.
test('symbolFontSide moves fullwidth punctuation to the requested side',()=>{
 const font=ps=>({family:ps,style:'Regular',postScriptName:ps});
 const mixed=tk('a，b。c',[range(0,6,'Old',12)]);
 const en=core.buildTextKey(mixed,{cnFont:font('CNFont'),enFont:font('ENFont'),symbolFontSide:'en'});
 const tail=r=>r.from>=mixed.textKey.length?'':mixed.textKey.slice(r.from,r.to);
 // buildTextKey keeps a terminal open-ended range (host.jsx does the same) with no
 // characters of its own; the character ranges are the first five.
 assert.deepEqual(en.textStyleRange.slice(0,5).map(r=>[tail(r),r.textStyle.fontPostScriptName]),
   [['a','ENFont'],['，','ENFont'],['b','ENFont'],['。','ENFont'],['c','ENFont']],'选英文符号时全角标点必须走英文');
 assert.deepEqual(core.verifyApplied(en,en,{cnFont:font('CNFont'),enFont:font('ENFont'),symbolFontSide:'en'}),[]);
 const cn=core.buildTextKey(mixed,{cnFont:font('CNFont'),enFont:font('ENFont'),symbolFontSide:'cn'});
 assert.deepEqual(cn.textStyleRange.slice(0,5).map(r=>[tail(r),r.textStyle.fontPostScriptName]),
   [['a','ENFont'],['，','CNFont'],['b','ENFont'],['。','CNFont'],['c','ENFont']],'选中文符号时全角标点走中文，字母不受影响');
 assert.deepEqual(core.verifyApplied(cn,cn,{cnFont:font('CNFont'),enFont:font('ENFont'),symbolFontSide:'cn'}),[]);
 const neutral=core.buildTextKey(mixed,{cnFont:font('CNFont'),enFont:font('ENFont')});
 assert.deepEqual(neutral.textStyleRange.slice(0,5).map(r=>[tail(r),r.textStyle.fontPostScriptName]),
   [['a','ENFont'],['，','CNFont'],['b','ENFont'],['。','CNFont'],['c','ENFont']],'未选符号侧时保持 CEP 默认：符号跟随所属段');
 const cjk=tk('中文，文',[range(0,4,'Old',12)]);
 const cjkEn=core.buildTextKey(cjk,{cnFont:font('CNFont'),enFont:font('ENFont'),symbolFontSide:'en'});
 assert.deepEqual(cjkEn.textStyleRange.slice(0,3).map(r=>[cjk.textKey.slice(r.from,r.to),r.textStyle.fontPostScriptName]),
   [['中文','CNFont'],['，','ENFont'],['文','CNFont']],'汉字本身不能因为符号侧设置被改走英文');
});
// CEP host.jsx:1132-1133 reads TextItem.autoKerning back and demands OPTICAL. UXP used
// to accept any read-back at all, so a layer that refused the setting (still manual or
// metrics) was counted as a success and the panel said "optical:1".
test('host auto-kerning only counts a layer whose read-back is optical',async()=>{
 for (const [readBack,expectApplied] of [['opticalKern',1],['optical',1],['manual',0],['metrics',0],['none',0],[null,0]]) {
  // A fresh fake per case: the previous one stored the last write as the document text,
  // which is what the read-back would then see.
  const f=makePhotoshop({layerIds:[1],kerningReadBack:readBack});
  await withFakePhotoshop(f.fake,async host=>{
   const out=await host.dispatch('auto-kerning',null);
   assert.equal(out.applied,expectApplied,`回读 ${String(readBack)} 时 applied 应为 ${expectApplied}`);
   assert.equal(out.optical,expectApplied);
   assert.equal(f.stats().kerningWrites,1,'必须通过 CharacterStyle.autoKerning 写入一次');
   assert.equal(f.stats().writes,0,'视觉字距不得依赖 batchPlay textKey 回读');
   if (expectApplied) { assert.equal(out.failed,0); assert.equal(out.mode,'optical'); }
   else { assert.equal(out.failed,1); assert.equal(out.mode,'unsupported'); assert.match(out.skipped[0],/未生效/); }
  });
 }
});
test('host auto-kerning writes CharacterStyle.autoKerning instead of textKey',async()=>{
 const f=makePhotoshop({layerIds:[1,2],kerningReadBack:'opticalKern'});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.dispatch('auto-kerning',null);
  assert.equal(out.applied,2);
  assert.equal(out.optical,2);
  assert.equal(out.failed,0);
  assert.equal(f.stats().kerningWrites,2);
  assert.equal(f.stats().writes,0,'所有字距写入都必须走 UXP CharacterStyle');
 });
});
// P2 regression: CEP host.jsx:928 counts an empty text layer as a success (`if (!text.length)
// { out.ok++; continue; }`). Reading back the textKey descriptor is the only way to stay
// equal: judging the descriptor's text rejected every empty layer as "回读失败" even when
// Photoshop did apply the kerning.
test('host auto-kerning counts an empty text layer that reports a textKey descriptor',async()=>{
 const f=makePhotoshop({layerIds:[1],kerningText:''});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.dispatch('auto-kerning',null);
  assert.equal(out.applied,1,'空文本层回读到描述符应计成功');
  assert.equal(out.failed,0);
  assert.equal(out.skipped.length,0);
 });
});
// P3 regression: a descriptor whose _enum names another type is not the autoKerning enum,
// so its _value says nothing about kerning. Counting it as optical was a false success.
test('host auto-kerning rejects a descriptor whose _enum is another type',async()=>{
 const f=makePhotoshop({layerIds:[1],kerningReadBack:'opticalKern',kerningEnum:'someOtherEnum'});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.dispatch('auto-kerning',null);
  assert.equal(out.applied,0,'_enum 不是 autoKernType 时不得计成功');
  assert.equal(out.optical,0);
  assert.equal(out.failed,1);
  assert.match(out.skipped[0],/未生效/);
 });
});
test('host auto-kerning names the actual read-back when the write is refused',async()=>{
 const f=makePhotoshop({layerIds:[1],kerningReadBack:'manual'});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.dispatch('auto-kerning',null);
  assert.equal(out.applied,0);
  assert.equal(out.failed,1);
  assert.match(out.skipped[0],/回读 manual/);
 });
});
// P2 regression: a single selected layer that gets cancelled must still report
// cancelled. Counting "processed < total" cannot see this: 0 ok + 1 failed == 1 total.
test('host reports a font Photoshop does not have and writes nothing (P1)',async()=>{
 // CEP stops before the first write and names the missing font (host.jsx:914-916). The
 // UXP host must not count layers as done when every glyph stayed unchanged.
 const f=makePhotoshop({layerIds:[1,2],fonts:['New']});
 const out=await withFakePhotoshop(f.fake,async host=>host.apply({cnFont:{family:'Ghost',style:'Regular'},enFont:{family:'New',style:'Regular'}}));
 assert.deepEqual(out.missingFonts,['Ghost Regular']);
 assert.equal(out.ok,0);
 assert.equal(out.layers.length,0);
 assert.equal(f.stats().writes,0);
});

test('host names both sides when neither requested font is installed (P1)',async()=>{
 const f=makePhotoshop({layerIds:[1],fonts:[]});
 const out=await withFakePhotoshop(f.fake,async host=>host.apply({cnFont:{family:'Ghost',style:'Regular'},enFont:{family:'Phantom',style:'Bold'}}));
 assert.deepEqual(out.missingFonts,['Ghost Regular','Phantom Bold']);
 assert.equal(out.ok,0);
 assert.equal(f.stats().writes,0);
});

test('host still writes when the requested fonts exist (P1 regression)',async()=>{
 const f=makePhotoshop({layerIds:[1],fonts:['New']});
 const out=await withFakePhotoshop(f.fake,async host=>host.apply({cnFont:{family:'New',style:'Regular'}}));
 assert.deepEqual(out.missingFonts,[]);
 assert.equal(out.ok,1);
 assert.ok(f.stats().writes>0);
});

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

test('host reports a Photoshop font substitution without rolling the layer back',async()=>{
 const f=makePhotoshop({substituteFont:true});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'}});
  assert.equal(out.failed.length,0);
  assert.equal(out.ok,0);
  assert.equal(out.substituted.length,1);
  assert.match(out.substituted[0],/字体被 Photoshop 替换/);
  assert.equal(out.layers[0].state,'substituted');
  assert.equal(out.unprocessed,0,'替换也是已处理，不能报成漏处理');
 assert.deepEqual(f.stats(),{writes:2,kerningWrites:0,resumes:1},'先写完整 trio，再尝试 family/style 回退');
});
});

test('host retries a variable-font write by family/style when PS normalizes the PS name',async()=>{
 const font={family:'Noto Sans SC',style:'Medium',postScriptName:'NotoSansSC-Medium'};
 const f=makePhotoshop({fonts:[font],variableFontNeedsFamilyOnly:true});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:font,enFont:font});
  assert.equal(out.failed.length,0);
  assert.equal(out.ok,1);
  assert.equal(out.substituted.length,0);
  assert.equal(out.layers[0].state,'verified');
  assert.deepEqual(f.stats(),{writes:2,kerningWrites:0,resumes:1});
 });
});

test('host retries a stale read-back before declaring a write failed',async()=>{
 const f=makePhotoshop({staleReadsAfterWrite:2});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'}});
  assert.equal(out.failed.length,0);
  assert.equal(out.ok,1);
  assert.deepEqual(f.stats(),{writes:1,kerningWrites:0,resumes:1});
 });
});

test('host falls back to font-only when Photoshop silently refuses the size',async()=>{
 const f=makePhotoshop({failSize:true});
 await withFakePhotoshop(f.fake,async host=>{
  const out=await host.apply({cnFont:{family:'New',style:'Regular'},enFont:{family:'New',style:'Regular'},cnSize:24,enSize:18});
  assert.equal(out.failed.length,0);
  assert.equal(out.ok,1);
  assert.match(out.notes.join(''),/字号未能写入.*已只应用字体/);
  assert.deepEqual(f.stats(),{writes:2,kerningWrites:0,resumes:1});
 });
});

test('host color picker uses modal batchPlay and reads RGBFloatColor',async()=>{
 let descriptor=null,modalOptions=null,modalDepth=0;
 const fake={
  app:{get foregroundColor(){throw Error('拾色器不能改写前景色');}},
  action:{batchPlay:async([d])=>{
   assert.equal(modalDepth,1,'showColorPicker 必须在 executeAsModal 内调用');
   descriptor=d;
   return [{RGBFloatColor:{red:64,grain:128,blue:255}}];
  }},
  core:{executeAsModal:async(fn,options)=>{
   modalDepth++;
   modalOptions=options;
   try{return await fn({});}
   finally{modalDepth--;}
  }},
 };
 await withFakePhotoshop(fake,async host=>{
  const out=await host.dispatch('pick-color',{r:.25,g:.5,b:1});
  assert.equal(out.ok,true);
  assert.ok(Math.abs(out.r-64/255)<1e-12);
  assert.ok(Math.abs(out.g-128/255)<1e-12);
  assert.equal(out.b,1);
 });
 assert.equal(descriptor._obj,'showColorPicker');
 assert.deepEqual(descriptor.color,{_obj:'RGBColor',red:64,green:128,blue:255});
 assert.equal(modalOptions.commandName,'选择字色');
});

test('host color picker keeps the old color on cancel and clamps host channels',async()=>{
 const canceled=await withFakePhotoshop({
  app:{},
  action:{batchPlay:async()=>[{value:false}]},
  core:{executeAsModal:async(fn)=>fn({})},
 },async host=>host.dispatch('pick-color',{r:0,g:0,b:0}));
 assert.deepEqual(canceled,{ok:false,canceled:true,api:'pick-color'});

 const clamped=await withFakePhotoshop({
  app:{},
  action:{batchPlay:async()=>[{RGBFloatColor:{red:300,grain:-20,blue:127.6}}]},
  core:{executeAsModal:async(fn)=>fn({})},
 },async host=>host.dispatch('pick-color',{r:0,g:0,b:0}));
 assert.equal(clamped.ok,true);
 assert.equal(clamped.r,1);
 assert.equal(clamped.g,0);
 assert.ok(Math.abs(clamped.b-127.6/255)<1e-12);

 const lab=await withFakePhotoshop({
  app:{},
  action:{batchPlay:async()=>[{RGBFloatColor:{redFloat:1.4,greenFloat:.5,blueFloat:-.2}}]},
  core:{executeAsModal:async(fn)=>fn({})},
 },async host=>host.dispatch('pick-color',{r:0,g:0,b:0}));
 assert.equal(lab.ok,true);
 assert.equal(lab.r,1);
 assert.equal(lab.g,.5);
 assert.equal(lab.b,0);
});

test('host color picker rejects a second open while the modal is active',async()=>{
 let release=null;
 const fake={
  app:{},
  action:{batchPlay:()=>new Promise((resolve)=>{release=resolve;})},
  core:{executeAsModal:async(fn)=>fn({})},
 };
 await withFakePhotoshop(fake,async host=>{
  const first=host.dispatch('pick-color',{r:0,g:0,b:0});
  const second=await host.dispatch('pick-color',{r:1,g:1,b:1});
  assert.deepEqual(second,{ok:false,busy:true,api:'pick-color'});
  release([{RGBFloatColor:{red:1,grain:2,blue:3}}]);
  const done=await first;
  assert.equal(done.ok,true);
 });
});
