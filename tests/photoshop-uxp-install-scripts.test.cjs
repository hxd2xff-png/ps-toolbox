'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const root0=root;
const install='install-photoshop-uxp-plugin.bat',uninstall='uninstall-photoshop-uxp-plugin.bat';
const read=n=>fs.readFileSync(path.join(root,n),'utf8');
const bytesOf=n=>fs.readFileSync(path.join(root,n));

test('UXP install and uninstall scripts stay ASCII CRLF without BOM',()=>{
 for(const name of [install,uninstall,'install-photoshop-uxp-from-ccx.bat']){
  const bytes=bytesOf(name);
  assert.equal(bytes.some(b=>b>127),false,name+' must remain ASCII');
  assert.notEqual(bytes[0],0xef,name+' must not start with a UTF-8 BOM');
  assert.equal(/(^|[^\r])\n|\r(?!\n)/.test(bytes.toString('utf8')),false,name+' must use CRLF');
 }
});

test('UXP install targets the external plugin directory and never touches CEP',()=>{
 const s=read(install);
 assert.match(s,/set "SRC=%ROOT%com\.figmatoolbox\.ps\.uxp"/);
 assert.match(s,/set "PLUGINS=%APPDATA%\\Adobe\\UXP\\Plugins"/);
 assert.match(s,/set "EXT=%PLUGINS%\\External"/);
 assert.match(s,/set "DST=%EXT%\\com\.figmatoolbox\.ps\.uxp"/);
 assert.match(s,/robocopy "%SRC%" "%DST%" \/E /);
 assert.match(s,/if errorlevel 8 \(/);
 assert.match(s,/\[ERROR\] Plugin copy failed\./);
 assert.match(s,/"Enable Developer Mode"/);
 assert.doesNotMatch(s,/CSXS|CEP|reg add|reg delete/i);
});

test('UXP uninstall treats a missing directory as success and never touches the registry',()=>{
 const s=read(uninstall);
 assert.match(s,/set "DST=%EXT%\\com\.figmatoolbox\.ps\.uxp"/);
 assert.match(s,/if not defined ANY \([\s\S]*?exit \/b 0/);
 assert.match(s,/rmdir \/s \/q "%DST%"\s+if exist "%DST%" \([\s\S]*exit \/b 1\s+\)/);
 assert.match(s,/for \/d %%D in \("%EXT%\\com\.figmatoolbox\.ps\.uxp_\*"\)/);
 assert.doesNotMatch(s,/CSXS|reg add|reg delete|choice \/C/i);
});

test('UXP manifest identity matches the directory the scripts install to',()=>{
 const manifest=JSON.parse(read('com.figmatoolbox.ps.uxp/manifest.json'));
 assert.equal(manifest.id,'com.figmatoolbox.ps.uxp');
 assert.equal(manifest.main,'index.html');
 for(const name of [install,uninstall]) assert.match(read(name),new RegExp('\\\\'+manifest.id+'"'));
});

// Execute the real BAT control flow under cmd.exe against a temp APPDATA fixture.
const windows={skip:process.platform!=='win32'};
function fixture(run){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ps-uxp-bat-'));
 try{
  const appdata=path.join(temp,'appdata with spaces');fs.mkdirSync(appdata,{recursive:true});
  return run(appdata);
 } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
function runBat(name,appdata,{dropSource=false,keepRepo=false,env={},args=[]}={}){
 const copy=path.join(appdata,'repo');
 if(!dropSource&&!keepRepo) fs.rmSync(copy,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 fs.mkdirSync(copy,{recursive:true});
 for(const f of [name,'install-photoshop-uxp-plugin.bat','uninstall-photoshop-uxp-plugin.bat','install-photoshop-uxp-from-ccx.bat','uxp-plugin-register.ps1']) fs.copyFileSync(path.join(root,f),path.join(copy,f));
 if(!dropSource&&!keepRepo) fs.cpSync(path.join(root,'com.figmatoolbox.ps.uxp'),path.join(copy,'com.figmatoolbox.ps.uxp'),{recursive:true});
 const cmd=process.env.ComSpec||'cmd.exe',bat=path.join(copy,name);
 const options={cwd:copy,env:{...process.env,...env,APPDATA:appdata},encoding:'utf8',timeout:60000};
 // Paths may contain spaces; with arguments use the documented cmd /s quote form.
 const r=args.length
  ? spawnSync(cmd,['/d','/s','/c','"'+'"'+bat+'" '+args.map(a=>'"'+a+'"').join(' ')+'"'],{...options,windowsVerbatimArguments:true})
  : spawnSync(cmd,['/d','/c',bat],options);
 if(r.error) throw r.error;
 const dst=path.join(appdata,'Adobe','UXP','Plugins','External','com.figmatoolbox.ps.uxp');
 return {status:r.status,stdout:r.stdout,stderr:r.stderr,dst,appdata,src:path.join(copy,'com.figmatoolbox.ps.uxp')};
}
test('UXP install creates nested directories and copies the panel',windows,()=>fixture(appdata=>{
 const r=runBat(install,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/installed successfully/);
 assert.match(r.stdout,/Enable Developer Mode/);
 assert.equal(fs.existsSync(path.join(r.dst,'manifest.json')),true);
 assert.equal(fs.existsSync(path.join(r.dst,'cep-ui.js')),true);
 assert.equal(fs.existsSync(path.join(r.dst,'uxp-bootstrap.js')),true);
 assert.equal(fs.existsSync(path.join(r.dst,'core.js')),true);
}));
test('UXP install replaces a previous copy without leaving stale files',windows,()=>fixture(appdata=>{
 const stale=path.join(appdata,'Adobe','UXP','Plugins','External','com.figmatoolbox.ps.uxp');
 fs.mkdirSync(stale,{recursive:true});fs.writeFileSync(path.join(stale,'stale.txt'),'x');
 const r=runBat(install,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.equal(fs.existsSync(path.join(r.dst,'stale.txt')),false);
 assert.equal(fs.existsSync(path.join(r.dst,'manifest.json')),true);
}));
test('UXP install clears old versioned CCX folders so Photoshop loads the new host',windows,()=>fixture(appdata=>{
 const old=path.join(appdata,'Adobe','UXP','Plugins','External','com.figmatoolbox.ps.uxp_0.2.5');
 fs.mkdirSync(old,{recursive:true});
 fs.writeFileSync(path.join(old,'host.js'),"const HOST_VERSION='0.2.5';");
 const r=runBat(install,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.equal(fs.existsSync(old),false,'old versioned directory must be removed');
 assert.equal(fs.existsSync(path.join(r.dst,'host.js')),true);
}));
test('UXP install fails loudly when the source plugin is missing',windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 for(const entry of fs.readdirSync(copy,{withFileTypes:true})){
  if(entry.isDirectory()) fs.rmSync(path.join(copy,entry.name),{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
 assert.equal(fs.existsSync(path.join(copy,'com.figmatoolbox.ps.uxp')),false,'fixture must have no source plugin');
 const again=runBat(install,appdata,{keepRepo:true});
 assert.equal(again.status,1,'stdout='+again.stdout+' stderr='+again.stderr);
 assert.match(again.stdout,/\[ERROR\] Source plugin not found/);
 assert.doesNotMatch(again.stdout,/installed successfully/);
}));
test('UXP uninstall removes the plugin directory and is repeatable',windows,()=>fixture(appdata=>{
 const first=runBat(install,appdata);
 assert.equal(first.status,0,first.stdout+first.stderr);
 const removed=runBat(uninstall,appdata);
 assert.equal(removed.status,0,removed.stdout+removed.stderr);
 assert.match(removed.stdout,/Uninstall processing complete/);
 assert.equal(fs.existsSync(first.dst),false);
 const again=runBat(uninstall,appdata);
 assert.equal(again.status,0,again.stdout+again.stderr);
 assert.match(again.stdout,/nothing to remove/);
}));
test('UXP uninstall also removes versioned CCX folders',windows,()=>fixture(appdata=>{
 const old=path.join(appdata,'Adobe','UXP','Plugins','External','com.figmatoolbox.ps.uxp_0.2.5');
 fs.mkdirSync(old,{recursive:true});
 fs.writeFileSync(path.join(old,'host.js'),'x');
 const removed=runBat(uninstall,appdata);
 assert.equal(removed.status,0,removed.stdout+removed.stderr);
 assert.equal(fs.existsSync(old),false);
 assert.match(removed.stdout,/Uninstall processing complete/);
}));
test('UXP uninstall succeeds when nothing was ever installed',windows,()=>fixture(appdata=>{
 const r=runBat(uninstall,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/nothing to remove/);
 assert.match(r.stdout,/Uninstall processing complete/);
}));
test('UXP install rejects a source manifest that does not declare the plugin id',windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const manifest=path.join(copy,'com.figmatoolbox.ps.uxp','manifest.json');
 fs.writeFileSync(manifest,JSON.stringify({id:'com.example.other',main:'index.html'},null,2));
 const again=runBat(install,appdata,{keepRepo:true});
 assert.equal(again.status,1,'stdout='+again.stdout+' stderr='+again.stderr);
 assert.match(again.stdout,/does not declare id com\.figmatoolbox\.ps\.uxp/);
 assert.doesNotMatch(again.stdout,/installed successfully/);
}));
test('UXP install rejects a wrong id even when another field carries the target string',windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const manifest=path.join(copy,'com.figmatoolbox.ps.uxp','manifest.json');
 // A substring match would pass this: the target id only appears in name.
 fs.writeFileSync(manifest,JSON.stringify({id:'com.example.other',name:'com.figmatoolbox.ps.uxp',main:'index.html'},null,2));
 const fresh=fs.mkdtempSync(path.join(os.tmpdir(),'ps-uxp-bat-fresh-'));
 try{
  const freshAppdata=path.join(fresh,'isolated appdata');fs.mkdirSync(freshAppdata,{recursive:true});
  fs.mkdirSync(path.join(freshAppdata,'repo'),{recursive:true});
  fs.copyFileSync(path.join(root,install),path.join(freshAppdata,'repo',install));
  fs.copyFileSync(path.join(root,'uxp-plugin-register.ps1'),path.join(freshAppdata,'repo','uxp-plugin-register.ps1'));
  fs.cpSync(path.join(root,'com.figmatoolbox.ps.uxp'),path.join(freshAppdata,'repo','com.figmatoolbox.ps.uxp'),{recursive:true});
  const freshManifest=path.join(freshAppdata,'repo','com.figmatoolbox.ps.uxp','manifest.json');
  fs.writeFileSync(freshManifest,JSON.stringify({id:'com.example.other',name:'com.figmatoolbox.ps.uxp',main:'index.html'},null,2));
  const clean=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',path.join(freshAppdata,'repo',install)],{cwd:path.join(freshAppdata,'repo'),env:{...process.env,APPDATA:freshAppdata},encoding:'utf8',timeout:60000});
  assert.equal(clean.status,1,'stdout='+clean.stdout+' stderr='+clean.stderr);
  assert.match(clean.stdout,/does not declare id com\.figmatoolbox\.ps\.uxp/);
  assert.doesNotMatch(clean.stdout,/installed successfully/);
  const installed=path.join(freshAppdata,'Adobe','UXP','Plugins','External','com.figmatoolbox.ps.uxp');
  assert.equal(fs.existsSync(installed),false,'a rejected manifest must not be installed');
 } finally { fs.rmSync(fresh,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}));
test('UXP install rejects a manifest whose id differs only by case and whitespace handling'
,windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const manifest=path.join(copy,'com.figmatoolbox.ps.uxp','manifest.json');
 fs.writeFileSync(manifest,JSON.stringify({id:'com.figmatoolbox.ps.uxp.extra',main:'index.html'},null,2));
 const again=runBat(install,appdata,{keepRepo:true});
 assert.equal(again.status,1,'stdout='+again.stdout+' stderr='+again.stderr);
 assert.match(again.stdout,/does not declare id com\.figmatoolbox\.ps\.uxp/);
}));
test('UXP install keeps the destination fixed by %APPDATA%',windows,()=>fixture(appdata=>{
 const override=path.join(appdata,'override');
 const r=runBat(install,appdata,{env:{PS_UXP_PLUGIN_DIR:override}});
 assert.equal(r.status,0,r.stdout+r.stderr);
 // The destination comes from %APPDATA% only; an inherited override is ignored.
 assert.equal(fs.existsSync(override),false,'an env override must be ignored');
 assert.equal(fs.existsSync(path.join(r.dst,'manifest.json')),true);
}));
test('UXP install rejects a source manifest that is not valid JSON',windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 const manifest=path.join(copy,'com.figmatoolbox.ps.uxp','manifest.json');
 fs.writeFileSync(manifest,'{ "id": "com.figmatoolbox.ps.uxp", oops }');
 const again=runBat(install,appdata,{keepRepo:true});
 assert.equal(again.status,1,'stdout='+again.stdout+' stderr='+again.stderr);
 assert.match(again.stdout,/does not declare id com\.figmatoolbox\.ps\.uxp|Could not parse manifest\.json|Could not read the plugin id/);
 assert.doesNotMatch(again.stdout,/installed successfully/);
}));
test('UXP install fails loudly when the plugin root cannot be created',windows,()=>fixture(appdata=>{
 // A file where the Plugins directory must be makes mkdir fail inside a normal directory.
 const adobe=path.join(appdata,'Adobe');
 fs.mkdirSync(adobe,{recursive:true});
 fs.writeFileSync(path.join(adobe,'UXP'),'placeholder file, not a directory');
 const r=runBat(install,appdata);
 const stillFile=fs.statSync(path.join(adobe,'UXP')).isFile();
 assert.equal(stillFile,true,'fixture must still block mkdir');
 assert.equal(r.status,1,'stdout='+r.stdout+' stderr='+r.stderr);
 assert.match(r.stdout,/\[ERROR\] Could not create/);
 assert.doesNotMatch(r.stdout,/installed successfully/);
}));
test('UXP install reports an unreadable plugin id separately from a wrong id',windows,()=>fixture(appdata=>{
 const copy=path.join(appdata,'repo');
 const seed=runBat(install,appdata);
 assert.equal(seed.status,0,seed.stdout+seed.stderr);
 // An empty manifest leaves MANIFEST_ID empty after a successful parse, which is a
 // read failure rather than a wrong plugin id.
 const manifest=path.join(copy,'com.figmatoolbox.ps.uxp','manifest.json');
 fs.writeFileSync(manifest,'');
 const again=runBat(install,appdata,{keepRepo:true});
 assert.equal(again.status,1,'stdout='+again.stdout+' stderr='+again.stderr);
 assert.match(again.stdout,/\[ERROR\] Could not (read the plugin id from manifest|parse manifest)/);
 assert.doesNotMatch(again.stdout,/does not declare id/);
 assert.doesNotMatch(again.stdout,/installed successfully/);
}));
test('UXP install treats a manifest without an id as a read failure',windows,()=>fixture(appdata=>{
 // Reported by fixtures built directly, without a first successful install, so the
 // branch is reached by the bat alone.
 const root=path.join(appdata,'noid');
 fs.mkdirSync(root,{recursive:true});
 fs.copyFileSync(path.join(root0,install),path.join(root,install));
 fs.mkdirSync(path.join(root,'com.figmatoolbox.ps.uxp'),{recursive:true});
 fs.writeFileSync(path.join(root,'com.figmatoolbox.ps.uxp','manifest.json'),JSON.stringify({version:'0.1.0',main:'index.html'},null,2));
 const r=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',path.join(root,install)],{cwd:root,env:{...process.env,APPDATA:root},encoding:'utf8',timeout:60000});
 assert.equal(r.status,1,'stdout='+r.stdout+' stderr='+r.stderr);
 assert.match(r.stdout,/\[ERROR\] Could not read the plugin id from manifest\.json\./);
 assert.doesNotMatch(r.stdout,/does not declare id/);
}));
test('UXP install temp id files stay unique across concurrent installs',windows,()=>fixture(appdata=>{
 // Concurrent runs used to collide on a single %RANDOM% segment and read a half-written
 // id file; six parallel installs into six separate APPDATA roots must all succeed.
 const roots=[];
 for(let i=0;i<6;i++){
  const root=path.join(appdata,'parallel '+i);
  fs.mkdirSync(root,{recursive:true});
  fs.cpSync(path.join(root0,'com.figmatoolbox.ps.uxp'),path.join(root,'com.figmatoolbox.ps.uxp'),{recursive:true});
  fs.copyFileSync(path.join(root0,install),path.join(root,install));
  fs.copyFileSync(path.join(root0,'uxp-plugin-register.ps1'),path.join(root,'uxp-plugin-register.ps1'));
  roots.push(root);
 }
 const results=roots.map(root=>spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',path.join(root,install)],{cwd:root,env:{...process.env,APPDATA:root},encoding:'utf8',timeout:60000}));
 results.forEach((r,i)=>{
  assert.equal(r.status,0,'run '+i+' stdout='+r.stdout+' stderr='+r.stderr);
  assert.match(r.stdout,/installed successfully/);
 });
}));

const infoPath=appdata=>path.join(appdata,'Adobe','UXP','PluginsInfo','v1','PS.json');
const readInfo=appdata=>JSON.parse(fs.readFileSync(infoPath(appdata),'utf8'));
const manifestOf=()=>JSON.parse(read('com.figmatoolbox.ps.uxp/manifest.json'));

test('UXP install registers the plugin the way a package install does',windows,()=>fixture(appdata=>{
 const r=runBat(install,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/Registered plugin: com\.figmatoolbox\.ps\.uxp/);
 const plugins=readInfo(appdata).plugins;
 const entry=plugins.find(p=>p.pluginId==='com.figmatoolbox.ps.uxp');
 assert.ok(entry,'plugin entry must be present in PS.json');
 const m=manifestOf();
 assert.equal(entry.name,m.name);
 assert.equal(entry.versionString,m.version);
 assert.equal(entry.hostMinVersion,m.host.minVersion);
 assert.equal(entry.status,'enabled');
 assert.equal(entry.type,'uxp');
 assert.equal(entry.path,'$localPlugins\\External\\com.figmatoolbox.ps.uxp');
}));

test('UXP install replaces a stale registration and keeps other plugins',windows,()=>fixture(appdata=>{
 const dir=path.dirname(infoPath(appdata));
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(infoPath(appdata),JSON.stringify({plugins:[
  {hostMinVersion:'24.0',name:'Other',path:'$localPlugins\\External\\other_1.0.0',pluginId:'com.example.other',status:'enabled',type:'uxp',versionString:'1.0.0'},
  {hostMinVersion:'25.0',name:'Old',path:'$localPlugins\\External\\com.figmatoolbox.ps.uxp_0.2.5',pluginId:'com.figmatoolbox.ps.uxp',status:'enabled',type:'uxp',versionString:'0.2.5'}
]},null,2));
 const r=runBat(install,appdata);
 assert.equal(r.status,0,r.stdout+r.stderr);
 const plugins=readInfo(appdata).plugins;
 assert.equal(plugins.filter(p=>p.pluginId==='com.figmatoolbox.ps.uxp').length,1,'stale entry must be replaced, not duplicated');
 assert.equal(plugins.find(p=>p.pluginId==='com.figmatoolbox.ps.uxp').versionString,manifestOf().version);
 assert.equal(plugins.some(p=>p.pluginId==='com.example.other'),true,'unrelated plugins must be preserved');
}));

test('UXP uninstall removes its registration but keeps other plugins',windows,()=>fixture(appdata=>{
 const dir=path.dirname(infoPath(appdata));
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(infoPath(appdata),JSON.stringify({plugins:[
  {hostMinVersion:'24.0',name:'Other',path:'$localPlugins\\External\\other_1.0.0',pluginId:'com.example.other',status:'enabled',type:'uxp',versionString:'1.0.0'}
]},null,2));
 const seeded=runBat(install,appdata);
 assert.equal(seeded.status,0,seeded.stdout+seeded.stderr);
 const removed=runBat(uninstall,appdata);
 assert.equal(removed.status,0,removed.stdout+removed.stderr);
 const plugins=readInfo(appdata).plugins;
 assert.equal(plugins.some(p=>p.pluginId==='com.figmatoolbox.ps.uxp'),false);
 assert.equal(plugins.some(p=>p.pluginId==='com.example.other'),true);
}));

test('UXP install refuses to overwrite a corrupt PS.json',windows,()=>fixture(appdata=>{
 const dir=path.dirname(infoPath(appdata));
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(infoPath(appdata),'{ "plugins": [ oops }');
 const r=runBat(install,appdata);
 assert.equal(r.status,1,'stdout='+r.stdout+' stderr='+r.stderr);
 assert.match(r.stdout,/plugin list could not be updated/);
 assert.equal(fs.readFileSync(infoPath(appdata),'utf8'),'{ "plugins": [ oops }','a corrupt file must be left untouched');
}));

test('UXP package installer extracts a .ccx and installs it without a store client',windows,()=>fixture(appdata=>{
 const dist=path.join(appdata,'dist');
 fs.mkdirSync(dist,{recursive:true});
 const ccx=path.join(dist,'font-mixer-uxp-test.ccx');
 const built=spawnSync(process.execPath,[path.join(root,'artifacts','uxp-ccx','build-ccx.mjs'),path.join(root,'com.figmatoolbox.ps.uxp'),ccx],{encoding:'utf8',timeout:60000});
 assert.equal(built.status,0,built.stdout+built.stderr);
 const r=runBat('install-photoshop-uxp-from-ccx.bat',appdata,{args:[ccx]});
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.equal(fs.existsSync(path.join(r.dst,'manifest.json')),true);
 assert.equal(fs.existsSync(path.join(r.dst,'uxp-compat.css')),true);
 const entry=readInfo(appdata).plugins.find(p=>p.pluginId==='com.figmatoolbox.ps.uxp');
 assert.ok(entry);
 assert.equal(entry.versionString,manifestOf().version);
}));
