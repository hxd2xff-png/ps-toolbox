'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const panel=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps/index.html'),'utf8');
const host=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps/jsx/host.jsx'),'utf8');
const version=/const HOST_EXPECT = '([^']+)'/.exec(panel)[1];
function part(a,b){const s=panel.indexOf(a),e=panel.indexOf(b,s);assert.ok(s>=0&&e>s,a);return panel.slice(s,e);}
const source=part('    const CEP =','    // ---- 宿主自检')+part('    function hostCallExpr(','    // 对照模式')+part("    let lastSelSig =",'    setInterval(pollSelection')+part('    function send(msg)','    // 统一回包处理')+part('    function startPanelHostRequests()',"    $('#kerning-apply')")+part('    function detectActive()','    // 把识别到的')+part('    function refreshFontDropdowns()','    // 字体键');
function harness({type='function',loader='LOADED',defer=[],pings=[],responses={}}={}){
 const calls=[],pending=[],results=[],notices=[],status={},timers=new Map();let time=0,id=0;
 const queues=Object.fromEntries(Object.entries(responses).map(([k,v])=>[k,v.slice()]));pings=pings.slice();
 const b={window:{__adobe_cep__:{}},SystemPath:{EXTENSION:'extension'},document:{getElementById:()=>status},figmaNotify:r=>notices.push(r),$:()=>status,fillFontFromDetect:r=>results.push(r),handleHostMsg:r=>results.push(r),applyFontList:r=>{b.fontReply=r;run('fontLoading=false;fontFamilies=fontReply.families;fontError=fontReply.error||""');results.push(r);},setTimeout(fn,ms){const n=++id;timers.set(n,{fn,at:time+ms});return n;},clearTimeout:n=>timers.delete(n),cs:{getSystemPath:()=>'/fixture',evalScript(s,cb){
 if(s.includes('f.open("a")')){cb('');return;}
 const k=s==='typeof cephostDispatch'?'typeof':s.includes('function pick()')?'loader':/return f\("([^"]+)",/.exec(s)[1];calls.push(k);
 if(defer.includes(k)){pending.push({k,cb});return;}
 let r=k==='typeof'?type:k==='loader'?loader:k==='ping'?(pings.length?pings.shift():{pong:true,version}):k==='sel-sig'?{sig:'A',textCount:1}:k==='list-fonts'?{families:[]}:{};
 if(queues[k]?.length)r=queues[k].shift();cb(typeof r==='string'?r:JSON.stringify(r));
 }}};
 vm.createContext(b);const run=s=>vm.runInContext(s,b);run('let activeTab="font",fontFamilies=null,fontLoading=false,fontError="";'+source);
 return {calls,results,status,notices,run,start:()=>run('ensureHost()'),detect:()=>run('detectActive()'),fonts:()=>run('requestFontList()'),poll:()=>run('pollSelection()'),state:()=>JSON.parse(run('JSON.stringify({hostReady,hostBusy,selectionPollPending,detectRequestPending})')),complete(k,r){const i=pending.findIndex(x=>x.k===k);assert.ok(i>=0,k);pending.splice(i,1)[0].cb(typeof r==='string'?r:JSON.stringify(r));},advance(ms){time+=ms;for(const [n,t]of [...timers])if(t.at<=time){timers.delete(n);t.fn();}},reconnect:()=>run('hostTried=false;ensureHost()')};
}
const count=(h,k)=>h.calls.filter(x=>x===k).length;
test('automatic startup connects and requests fonts without manual diagnostics',()=>{const h=harness();h.run(part('    // 对照模式','    // CEP 没有主动推送'));assert.equal(h.calls.length,0);h.advance(200);assert.equal(h.state().hostReady,true);assert.equal(count(h,'list-fonts'),1);assert.equal(count(h,'detect-font'),1);});
test('panel and host versions match',()=>assert.equal(version,/var HOST_VERSION = '([^']+)'/.exec(host)[1]));
test('host JSX remains ASCII and BOM free',()=>{assert.equal(/[^\x00-\x7f]/.test(host),false);assert.notEqual(host.charCodeAt(0),0xfeff);});
test('font mixer waits 80 seconds and timeout reports unknown without replay',()=>{
 const h=harness({defer:['font-mixer']});h.start();h.run('send({type:"font-mixer",config:{}})');
 const done=()=>h.results.filter(r=>r.type==='font-mixer-done');
 h.advance(15000);assert.equal(done().length,0);h.advance(64999);assert.equal(done().length,0);
 h.advance(1);assert.equal(done().length,1);assert.equal(done()[0].resultUnknown,true);
 h.complete('font-mixer',{ok:1});assert.equal(done().length,1);assert.equal(count(h,'font-mixer'),1);
});
test('font mixer completion before 80 seconds remains accepted',()=>{
 const h=harness({defer:['font-mixer']});h.start();h.run('send({type:"font-mixer",config:{}})');h.advance(79000);
 h.complete('font-mixer',{ok:1,total:1});const done=h.results.filter(r=>r.type==='font-mixer-done');assert.equal(done.length,1);assert.equal(done[0].ok,1);assert.notEqual(done[0].resultUnknown,true);
});
test('matching host READY starts reads only once',()=>{const h=harness();h.start();assert.equal(h.state().hostReady,true);assert.deepEqual(h.calls,['typeof','ping','diag','sel-sig','detect-font','list-fonts']);h.start();assert.equal(count(h,'detect-font'),1);});
test('old host reload requires a new verified ping',()=>{const h=harness({pings:[{pong:true,version:'old'},{pong:true,version}],loader:'LOADED head=47,'});h.start();assert.deepEqual(h.calls,['typeof','ping','loader','ping','sel-sig','detect-font','list-fonts']);});
test('READY gate retains early UI requests without early submission',()=>{const h=harness({type:'undefined',defer:['loader']});h.detect();h.fonts();h.poll();assert.deepEqual(h.calls,[]);h.start();h.detect();h.fonts();assert.deepEqual(h.calls,['typeof','loader']);h.complete('loader','ALREADY');assert.equal(h.state().hostReady,true);assert.equal(count(h,'detect-font'),1);assert.equal(count(h,'list-fonts'),1);});
test('invalid loader responses never start reads',()=>{for(const loader of ['ERR missing-file','EvalScript error.','NOT_LOADED','LOADED_BROKEN','']){const h=harness({type:'undefined',loader});h.start();assert.equal(h.state().hostReady,false);assert.equal(count(h,'detect-font'),0);assert.match(h.status.textContent,/宿主加载失败/);}});
test('load acknowledgement still requires valid pong and version',()=>{for(const pg of [{pong:true,version:'old'},{version},{pong:false,version},'EvalScript error.']){const h=harness({type:'undefined',pings:[pg]});h.start();assert.equal(h.state().hostReady,false);assert.equal(count(h,'detect-font'),0);}});
test('polling has only one in-flight request',()=>{const h=harness({defer:['sel-sig']});h.start();h.poll();h.poll();assert.equal(count(h,'sel-sig'),1);h.complete('sel-sig',{sig:'A',textCount:1});h.poll();assert.equal(count(h,'sel-sig'),2);});
test('new selection queues one rerun and stale detection never fills UI',()=>{const h=harness({defer:['detect-font','sel-sig']});h.start();h.complete('sel-sig',{sig:'A',textCount:1});h.poll();h.complete('sel-sig',{sig:'B',textCount:1});assert.equal(count(h,'detect-font'),1);h.complete('detect-font',{marker:'old'});assert.equal(h.results.some(x=>x.marker==='old'),false);h.complete('sel-sig',{sig:'B',textCount:1});assert.equal(count(h,'detect-font'),2);h.complete('detect-font',{marker:'latest'});assert.equal(h.results.at(-1).marker,'latest');});
test('NOHOST forces reload and fresh reads',()=>{const h=harness({type:'undefined',responses:{'sel-sig':['__NOHOST__']}});h.start();h.poll();assert.equal(count(h,'loader'),2);assert.equal(h.state().hostReady,true);assert.equal(count(h,'detect-font'),1);assert.equal(h.state().selectionPollPending,false);});
test('timeout releases locks, pauses requests and ignores late callbacks',()=>{const h=harness({defer:['detect-font','sel-sig']});h.start();h.complete('sel-sig',{sig:'A',textCount:1});h.poll();h.advance(15000);assert.deepEqual(h.state(),{hostReady:false,hostBusy:false,selectionPollPending:false,detectRequestPending:false});const n=h.calls.length;h.poll();h.advance(15000);assert.equal(h.calls.length,n);h.complete('detect-font',{marker:'late'});assert.equal(h.results.some(x=>x.marker==='late'),false);assert.match(h.status.textContent,/超时/);h.complete('sel-sig',{sig:'old',textCount:1});h.reconnect();assert.equal(h.state().hostReady,true);h.complete('sel-sig',{sig:'A',textCount:1});assert.equal(count(h,'detect-font'),2);});
test('initial probe timeout leaves busy state and ignores late probe',()=>{const h=harness({defer:['typeof']});h.start();h.advance(15000);assert.equal(h.state().hostBusy,false);assert.equal(h.state().hostReady,false);h.complete('typeof','function');assert.equal(count(h,'ping'),0);});
test('ping timeout never falls through to loading or READY',()=>{const h=harness({defer:['ping']});h.start();h.advance(15000);assert.equal(h.state().hostReady,false);assert.equal(h.state().hostBusy,false);assert.equal(count(h,'loader'),0);assert.equal(count(h,'detect-font'),0);});
test('NOHOST during detection refreshes reads without replaying stale callback',()=>{const h=harness({responses:{'detect-font':['__NOHOST__']}});h.start();assert.equal(h.state().hostReady,true);assert.equal(count(h,'typeof'),2);assert.equal(count(h,'detect-font'),2);assert.equal(h.results.some(x=>x.error==='__NOHOST__'),false);});
test('old selection callback cannot unlock a new connection poll',()=>{const h=harness({defer:['sel-sig','detect-font']});h.start();h.poll();h.advance(15000);h.reconnect();h.poll();assert.equal(h.state().selectionPollPending,true);h.complete('sel-sig',{sig:'old'});assert.equal(h.state().selectionPollPending,true);h.complete('sel-sig',{sig:'new'});assert.equal(h.state().selectionPollPending,false);});
test('loader timeout stops startup and a late loader reply is ignored',()=>{const h=harness({type:'undefined',defer:['loader']});h.start();h.advance(15000);assert.equal(h.state().hostReady,false);assert.equal(h.state().hostBusy,false);h.complete('loader','LOADED');assert.equal(count(h,'ping'),0);});
test('first poll after completed startup detection refreshes latest selection',()=>{const h=harness({responses:{'detect-font':[{marker:'A'},{marker:'B'}],'sel-sig':[{sig:'A',textCount:1},{sig:'B',textCount:1},{sig:'B',textCount:1}]}});h.start();assert.equal(h.results.some(r=>r.marker==='A'),true);h.poll();h.poll();assert.equal(count(h,'detect-font'),2);assert.equal(h.results.at(-1).marker,'B');});
test('poll timeout settles concurrent write once as unknown and ignores late completion',()=>{const h=harness({defer:['sel-sig','font-mixer']});h.start();h.poll();h.run('send({type:"font-mixer",config:{}})');h.advance(15000);const done=()=>h.results.filter(r=>r.type==='font-mixer-done');assert.equal(done().length,1);assert.equal(done()[0].state,'unknown');assert.equal(done()[0].resultUnknown,true);h.complete('font-mixer',{ok:1});h.advance(20000);assert.equal(done().length,1);assert.equal(count(h,'font-mixer'),1);});
test('write timeout settles concurrent kerning and detection without replay',()=>{const h=harness({defer:['font-mixer','auto-kerning','detect-font']});h.start();h.run('send({type:"font-mixer",config:{}});send({type:"auto-kerning"})');h.advance(15000);for(const type of ['font-mixer-done','auto-kerning-done']){const done=h.results.filter(r=>r.type===type);assert.equal(done.length,1);assert.equal(done[0].resultUnknown,true);}h.complete('auto-kerning',{optical:1});assert.equal(h.results.filter(r=>r.type==='auto-kerning-done').length,1);});
test('unknown font result clears wait guard and never asks to repeat application',()=>{const status={};const timers=new Map();let i=0;const b={$:()=>status,setTimeout:fn=>{timers.set(++i,fn);return i;},clearTimeout:id=>timers.delete(id)};vm.createContext(b);vm.runInContext('let fontGuard=null;let bridgeTimeoutMs=15000;'+part('    function onFontMixStart(', '    // 字距结果'),b);vm.runInContext('onFontMixStart({});showFontMixResult({error:"timeout",resultUnknown:true});',b);assert.equal(timers.size,0);assert.match(status.textContent,/结果未知/);assert.doesNotMatch(status.textContent,/请再点一次/);});
test('polling pauses during writes and while panel is hidden',()=>{const h=harness({defer:['font-mixer']});h.start();h.run('send({type:"font-mixer",config:{}})');const before=count(h,'sel-sig');h.poll();assert.equal(count(h,'sel-sig'),before);h.complete('font-mixer',{ok:1});h.poll();assert.equal(count(h,'sel-sig'),before+1);h.run('document.hidden=true');h.poll();assert.equal(count(h,'sel-sig'),before+1);});
test('nontext selection skips detection at startup and after text selection',()=>{
 const h=harness({responses:{'sel-sig':[{sig:'shape',textCount:0},{sig:'text',textCount:1},{sig:'group-empty',textCount:0}]}});
 h.start();assert.equal(count(h,'detect-font'),0);h.poll();assert.equal(count(h,'detect-font'),1);h.poll();assert.equal(count(h,'detect-font'),1);assert.equal(h.results.at(-1).empty,true);
});
test('startup and unchanged first poll share one detection',()=>{const h=harness();h.start();h.poll();assert.equal(count(h,'detect-font'),1);});
test('switching to nontext invalidates a pending text result without replay',()=>{
 const h=harness({defer:['detect-font'],responses:{'sel-sig':[{sig:'text',textCount:1},{sig:'shape',textCount:0}]}});
 h.start();h.poll();h.complete('detect-font',{marker:'stale-text'});assert.equal(h.results.some(r=>r.marker==='stale-text'),false);assert.equal(count(h,'detect-font'),1);
});
test('same selected IDs recover from failed read and trigger exactly one detection',()=>{
 const h=harness({responses:{'sel-sig':[
  {sig:'A',textCount:0,targetSig:'',readState:'partial'},
  {sig:'A',textCount:1,targetSig:'1',readState:'ready'},
  {sig:'A',textCount:1,targetSig:'1',readState:'ready'}]}});
 h.start();assert.equal(count(h,'detect-font'),0);h.poll();assert.equal(count(h,'detect-font'),1);h.poll();assert.equal(count(h,'detect-font'),1);
});
test('same selected IDs refresh when resolved text targets or read state change',()=>{
 const h=harness({responses:{'sel-sig':[
  {sig:'A',textCount:1,targetSig:'1',readState:'partial'},
  {sig:'A',textCount:1,targetSig:'1',readState:'ready'},
  {sig:'A',textCount:1,targetSig:'2',readState:'ready'}]}});
 h.start();h.poll();h.poll();assert.equal(count(h,'detect-font'),3);
});
