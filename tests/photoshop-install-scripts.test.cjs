'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=n=>fs.readFileSync(path.join(__dirname,'..',n),'utf8');
test('PowerShell installer and optional cleanup cover CSXS 9 through 19',()=>{
 const install=read('scripts/install-photoshop-plugin.ps1'),remove=read('scripts/uninstall-photoshop-plugin.ps1');
 for(const s of [install,remove]) {
  const bounds=/\$registryPaths = @\((\d+)\.\.(\d+) \| ForEach-Object/.exec(s);assert.ok(bounds);
  assert.deepEqual([Number(bounds[1]),Number(bounds[2])],[9,19]);
  assert.match(s,/foreach \(\$registryPath in \$registryPaths\)/);
 }
 assert.match(install,/New-ItemProperty -Path \$registryPath -Name 'PlayerDebugMode' -PropertyType String -Value '1'/);
 assert.match(install,/\$invalidDebugPaths = @\(\$registryPaths \| Where-Object/);
 assert.match(install,/\$invalidDebugPaths.Count -gt 0/);
 assert.match(remove,/if \(\$RemoveDebugMode\) \{\s+foreach/);
 assert.match(remove,/Remove-ItemProperty -Path \$registryPath -Name 'PlayerDebugMode'\s/);
 assert.doesNotMatch(remove,/Remove-ItemProperty[^\r\n]*SilentlyContinue/);
});
test('installer stops after failed removal or directory creation before copying',()=>{const s=read('install-photoshop-plugin.bat');assert.match(s,/rmdir \/s \/q "%DST%"\s+if exist "%DST%" \([\s\S]*?exit \/b 1\s+\)\s+mkdir "%DST%"\s+if errorlevel 1 \([\s\S]*?exit \/b 1\s+\)\s+robocopy/);assert.match(s,/if not exist "%EXT%" \([\s\S]*?exit \/b 1/);assert.match(s,/robocopy[^\n]*\nif errorlevel 8 \([\s\S]*?exit \/b 1/);});
test('uninstaller reports directory removal success only after checking failure',()=>{const s=read('uninstall-photoshop-plugin.bat');assert.match(s,/rmdir \/s \/q "%DST%"\s+if exist "%DST%" \([\s\S]*?exit \/b 1\s+\)\s+echo Removed plugin/);
 assert.match(s,/\) else \(\s+echo Plugin directory not found; nothing to remove\.\s*\)/);
 assert.match(s,/:done\s+echo Uninstall processing complete\. Restart Photoshop\.\s+exit \/b 0/);
});

test('BAT registry loops cover CSXS 9 through 19 and keep ASCII CRLF without BOM',()=>{
 for(const name of ['install-photoshop-plugin.bat','uninstall-photoshop-plugin.bat']){
  const bytes=fs.readFileSync(path.join(__dirname,'..',name)),s=bytes.toString('utf8');
  assert.equal(bytes.some(b=>b>127),false,name+' must remain ASCII');
  assert.equal(/(^|[^\r])\n|\r(?!\n)/.test(s),false,name+' must use CRLF');
  assert.match(s,/for \/l %%V in \(9,1,19\) do \(/);
  assert.match(s,/HKCU\\Software\\Adobe\\CSXS\.%%V/);
 }
 assert.match(read('install-photoshop-plugin.bat'),/echo Registry:.*CSXS\.9.*CSXS\.19/);
});

// Default mode executes the registry tail; fullUninstall also covers directory
// checks under isolated APPDATA. Registry commands always use a native-process
// fixture. emptyInput mode keeps real choice.exe and supplies redirected stdin.
const os=require('node:os'),{spawnSync}=require('node:child_process');
function registryRun(kind,{present=[],failAdd='',failDelete='',stickyDelete='',answer='1',repeat=false,emptyInput=false,stdin='',fullUninstall=false}={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ps-cep-bat-'));
 try{
  const cwd=path.join(temp,'fixture with spaces');fs.mkdirSync(cwd);
  const state=path.join(cwd,'state'),log=path.join(cwd,'calls.log');fs.mkdirSync(state);
  for(const v of present)fs.writeFileSync(path.join(state,String(v)),'1');
  const executable=path.join(cwd,'registry-fixture.exe');fs.copyFileSync(process.execPath,executable);
  const mock=`const fs=require('fs'),path=require('path');
const op=path.basename(process.argv[1]);
if(op==='choice')process.exit(Number(process.env.CEP_BAT_ANSWER));
const match=/CSXS\\.(\\d+)$/.exec(process.argv[2]||'');if(!match)process.exit(99);
const v=match[1],file=path.join(process.env.CEP_BAT_STATE,v);
fs.appendFileSync(process.env.CEP_BAT_LOG,op+' '+v+'\\n');
if(op==='add'){if(v===process.env.CEP_BAT_FAIL_ADD)process.exit(1);fs.writeFileSync(file,'1');process.exit(0);}
if(op==='query')process.exit(fs.existsSync(file)?0:1);
if(op==='delete'){if(v===process.env.CEP_BAT_FAIL_DELETE)process.exit(1);if(v!==process.env.CEP_BAT_STICKY_DELETE)fs.unlinkSync(file);process.exit(0);}
process.exit(99);`;
  for(const op of ['add','query','delete','choice'])fs.writeFileSync(path.join(cwd,op),mock);
  const source=read(kind==='install'?'install-photoshop-plugin.bat':'uninstall-photoshop-plugin.bat');
  if(fullUninstall)assert.equal(kind,'uninstall');
  const start=fullUninstall?0:kind==='install'?source.indexOf('for /l %%V in (9,1,19) do ('):source.indexOf('choice /C ');
  assert.ok(start>=0,'actual registry section must exist');
  let body=source.slice(start);
  if(!fullUninstall)assert.doesNotMatch(body,/\b(?:rmdir|robocopy|mkdir)\b/i,'registry fixture must exclude plugin file operations');
  body=body.replace(/^(\s*)reg /gm,(_,indent)=>indent+'"'+executable+'" ');
  if(!emptyInput)body=body.replace(/^choice /m,'"'+executable+'" choice ');
  assert.doesNotMatch(body,/^\s*reg /m,'every registry command must be mocked');
  fs.writeFileSync(path.join(cwd,'run.cmd'),'@echo off\r\nsetlocal EnableExtensions\r\n'+body);
  const appdata=path.join(cwd,'isolated appdata');fs.mkdirSync(appdata);
  const env={...process.env,APPDATA:appdata,CEP_BAT_STATE:state,CEP_BAT_LOG:log,CEP_BAT_FAIL_ADD:String(failAdd),CEP_BAT_FAIL_DELETE:String(failDelete),CEP_BAT_STICKY_DELETE:String(stickyDelete),CEP_BAT_ANSWER:answer};
  function run(){const r=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c','run.cmd'],{cwd,env,encoding:'utf8',timeout:10000,input:emptyInput?stdin:undefined});if(r.error)throw r.error;return{status:r.status,stdout:r.stdout,stderr:r.stderr};}
  const first=run(),second=repeat?run():null;
  return{...first,second,calls:fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split(/\r?\n/):[],remaining:fs.readdirSync(state).map(Number).sort((a,b)=>a-b)};
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
const windows={skip:process.platform!=='win32'};
test('BAT install writes every version including CEP 12',windows,()=>{
 const r=registryRun('install');assert.equal(r.status,0,r.stdout+r.stderr);
 assert.deepEqual(r.calls,Array.from({length:11},(_,i)=>'add '+(i+9)));
 assert.deepEqual(r.remaining,Array.from({length:11},(_,i)=>i+9));assert.match(r.stdout,/installed successfully/);
});
test('BAT install stops at a failed version and never reports success',windows,()=>{
 const r=registryRun('install',{failAdd:12});assert.equal(r.status,1);assert.deepEqual(r.calls,['add 9','add 10','add 11','add 12']);
 assert.match(r.stdout,/\[ERROR\]/);assert.doesNotMatch(r.stdout,/installed successfully/);
});
test('BAT uninstall skips absent values verifies deletion and is repeatable',windows,()=>{
 const r=registryRun('uninstall',{present:[9,12,19],repeat:true});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.second.status,0,r.second.stdout+r.second.stderr);assert.deepEqual(r.remaining,[]);
 assert.deepEqual(r.calls.filter(c=>c.startsWith('delete ')),['delete 9','delete 12','delete 19']);
 for(const v of [9,12,19]){const i=r.calls.indexOf('delete '+v);assert.equal(r.calls[i-1],'query '+v);assert.equal(r.calls[i+1],'query '+v);}
 assert.equal(r.calls.filter(c=>c==='query 12').length,3);
});
test('BAT uninstall fails when an existing value cannot be deleted',windows,()=>{
 const r=registryRun('uninstall',{present:[12,19],failDelete:12});assert.equal(r.status,1);assert.match(r.stdout,/\[ERROR\]/);
 assert.deepEqual(r.remaining,[12,19]);assert.equal(r.calls.includes('query 19'),false);assert.doesNotMatch(r.stdout,/Uninstall processing complete/);
});
test('BAT uninstall detects a success exit code that leaves the value present',windows,()=>{
 const r=registryRun('uninstall',{present:[12],stickyDelete:12});assert.equal(r.status,1);assert.deepEqual(r.remaining,[12]);assert.match(r.stdout,/\[ERROR\]/);assert.doesNotMatch(r.stdout,/Removed registry value|Uninstall processing complete/);
});
test('BAT uninstall answer N leaves all registry values untouched',windows,()=>{
 const r=registryRun('uninstall',{present:[9,12,19],answer:'2'});assert.equal(r.status,0);assert.deepEqual(r.calls,[]);assert.deepEqual(r.remaining,[9,12,19]);
});
test('BAT uninstall with empty stdin fails through real choice without touching any version',windows,()=>{
 const versions=Array.from({length:11},(_,i)=>i+9);
 const r=registryRun('uninstall',{present:versions,emptyInput:true,fullUninstall:true});
 assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/\[ERROR\] Registry cleanup prompt failed/);
 assert.match(r.stdout,/Plugin directory not found; nothing to remove\./);
 assert.deepEqual(r.calls,[]);assert.deepEqual(r.remaining,versions);
 assert.doesNotMatch(r.stdout,/Uninstall processing complete/);
});
test('BAT full uninstall with no plugin and real N input completes without touching registry',windows,()=>{
 const versions=Array.from({length:11},(_,i)=>i+9);
 const r=registryRun('uninstall',{present:versions,emptyInput:true,stdin:'N\r\n',fullUninstall:true});
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/Plugin directory not found; nothing to remove\./);
 assert.match(r.stdout,/Uninstall processing complete/);assert.deepEqual(r.calls,[]);assert.deepEqual(r.remaining,versions);
});
test('BAT uninstall rejects interrupted and unexpected choice return codes',windows,()=>{
 const versions=Array.from({length:11},(_,i)=>i+9);
 for(const code of [0,3,255]){
  const r=registryRun('uninstall',{present:versions,answer:String(code)});
  assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/\[ERROR\] Registry cleanup prompt (?:failed|was interrupted)/);
  assert.deepEqual(r.calls,[]);assert.deepEqual(r.remaining,versions);assert.doesNotMatch(r.stdout,/Uninstall processing complete/);
 }
});
