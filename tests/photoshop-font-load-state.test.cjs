'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const panel=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps/index.html'),'utf8');
function part(a,b){const i=panel.indexOf(a),j=panel.indexOf(b,i);assert.ok(i>=0&&j>i,a);return panel.slice(i,j);}
function harness({fail=false,deferFonts=false,deferConnect=false}={}) {
 const pending=[],calls=[],statuses={},renders=[];let time=0,id=0;const timers=new Map();
 const context={window:{__adobe_cep__:{}},SystemPath:{EXTENSION:'extension'},document:{getElementById:id=>statuses[id]||(statuses[id]={})},$:id=>statuses[id]||(statuses[id]={}),figmaNotify(){},fillFontFromDetect(){},handleHostMsg(){},setTimeout(fn,ms){timers.set(++id,{fn,at:time+ms});return id;},clearTimeout(id){timers.delete(id);},setFontValue(){},cs:{getSystemPath:()=>'/fixture',evalScript(s,cb){
 if(s.includes('f.open("a")')){cb('');return;}
 const k=s==='typeof cephostDispatch'?'typeof':s.includes('function pick()')?'loader':/return f\("([^"]+)",/.exec(s)[1];calls.push(k);
 if((k==='typeof'&&deferConnect)||(k==='list-fonts'&&deferFonts)){pending.push({k,cb});return;}
 const value=k==='typeof'?(fail?'undefined':'function'):k==='loader'?'ERR fixture':k==='ping'?{pong:true,version:/const HOST_EXPECT = '([^']+)'/.exec(panel)[1]}:k==='sel-sig'?{sig:'shape',textCount:0}:k==='list-fonts'?{families:[]} : {};
 cb(typeof value==='string'?value:JSON.stringify(value));}}};
 vm.createContext(context);
 const source=part('    const CEP =','    // ---- 宿主自检')+part('    function hostCallExpr(','    // 对照模式')+part('    let lastSelSig =','    setInterval(pollSelection')+part('    function send(msg)','    // 统一回包处理')+part('    function startPanelHostRequests()',"    $('#kerning-apply')")+part('    function detectActive()','    // 把识别到的')+part('    let fontFamilies =','    /* ============================================================\n       通用下拉');
 const run=s=>vm.runInContext(s,context);
 context.capture=()=>renders.push(run('fontListStateText()'));
 run('let activeTab="font";let fontSel={cn:null,en:null};let fontPresets=[];const ddRegistry={"cn-font":{refresh:capture},"en-font":{refresh:capture}};'+source);
 return {run,calls,renders,statuses,start:()=>run('ensureHost()'),open:()=>run('requestFontList()'),state:()=>JSON.parse(run('JSON.stringify({fontLoading,fontError,fontFamilies,queued:!!requestFontList.queued,waiters:readyWaiters.length,text:fontListStateText()})')),advance(ms){time+=ms;for(const [n,t]of [...timers])if(t.at<=time){timers.delete(n);t.fn();}},complete(k,value){const i=pending.findIndex(x=>x.k===k);assert.ok(i>=0,k);pending.splice(i,1)[0].cb(typeof value==='string'?value:JSON.stringify(value));}};
}
test('failed connection before first dropdown open fails immediately without waiter or font call',()=>{const h=harness({fail:true});h.start();h.open();assert.equal(h.state().waiters,0);assert.equal(h.state().queued,false);assert.match(h.state().text,/失败/);assert.equal(h.calls.includes('list-fonts'),false);assert.equal(h.renders.length,2);});
test('waiting dropdown settles failure through real applyFontList and refreshes both dropdowns',()=>{const h=harness({deferConnect:true});h.open();assert.match(h.state().text,/等待/);h.start();h.complete('typeof','undefined');assert.equal(h.state().fontLoading,false);assert.match(h.state().text,/失败/);assert.equal(h.state().queued,false);assert.equal(h.renders.length,4);});
test('pending font request shows loading and is deduplicated',()=>{const h=harness({deferFonts:true});h.start();h.open();h.open();assert.equal(h.calls.filter(x=>x==='list-fonts').length,1);assert.match(h.state().text,/正在加载/);h.complete('list-fonts',{families:[]});assert.equal(h.state().text,'');assert.equal(h.statuses['#font-status'].textContent,'字体库为空');});
test('font timeout clears loading and ignores late success then explicit reconnect recovers',()=>{const h=harness({deferFonts:true});h.start();h.advance(15000);assert.equal(h.state().fontLoading,false);assert.match(h.state().text,/超时/);h.complete('list-fonts',{families:[{family:'late',styles:['Regular']}]});assert.equal(h.state().fontFamilies.length,0);h.run('hostTried=false;hostErr="";ensureHost()');assert.match(h.state().text,/正在加载/);h.complete('list-fonts',{families:[{family:'Test',styles:['Regular']}]});assert.equal(h.state().fontFamilies[0].family,'Test');assert.equal(h.state().fontError,'');assert.equal(h.statuses['#font-status'].textContent,'字体库已加载');});
test('malformed font reply is failure distinct from valid empty font list',()=>{const h=harness({deferFonts:true});h.start();h.complete('list-fonts',{});assert.match(h.state().text,/返回格式无效/);h.open();h.complete('list-fonts',{families:[]});assert.equal(h.state().fontError,'');assert.equal(h.statuses['#font-status'].textContent,'字体库为空');});
test('real dropdown build renders waiting loading failure and valid empty separately',()=>{
 const emptyEl={style:{}},list={innerHTML:''};
 const b={emptyEl,list,opts:{getItems:()=>null,getStateText:()=> '等待宿主连接…'}};
 vm.createContext(b);vm.runInContext(part('      function build(q)', '      // 选中后回调'),b);
 vm.runInContext('build("")',b);assert.equal(emptyEl.textContent,'等待宿主连接…');
 b.opts.getStateText=()=> '正在加载字体库…';vm.runInContext('build("")',b);assert.equal(emptyEl.textContent,'正在加载字体库…');
 b.opts.getItems=()=>[];b.opts.getStateText=()=> '字体库加载失败：fixture';vm.runInContext('build("")',b);assert.equal(emptyEl.textContent,'字体库加载失败：fixture');
 b.opts.getStateText=()=>'';b.opts.emptyText='无匹配字体';vm.runInContext('build("")',b);assert.equal(emptyEl.textContent,'无匹配字体');
});
