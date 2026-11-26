'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const SOURCE=fs.readFileSync(path.join(__dirname,'../com.figmatoolbox.ps.uxp/uxp-bootstrap.js'),'utf8');

class FakeEl{
 constructor(tag){
  this.tagName=String(tag||'div').toUpperCase();
  this.children=[];this.parentNode=null;this.attributes={};this.listeners=[];this.onclick=null;
  this.className='';this.id='';this._text='';this.value='';
  this.classList={contains:c=>String(this.className).split(/\s+/).includes(c)};
 }
 setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=String(v);if(k==='id')this.id=String(v);}
 getAttribute(k){return k in this.attributes?this.attributes[k]:null;}
 get firstChild(){return this.children[0]||null;}
 appendChild(c){
  if(c.parentNode){const i=c.parentNode.children.indexOf(c);if(i>=0)c.parentNode.children.splice(i,1);}
  c.parentNode=this;this.children.push(c);return c;
 }
 addEventListener(t,fn){this.listeners.push([t,fn]);}
 replaceChild(next,old){const i=this.children.indexOf(old);assert.ok(i>=0);this.children[i]=next;next.parentNode=this;old.parentNode=null;return old;}
 removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);c.parentNode=null;return c;}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(v){this._text=String(v);this.children=[];}
}

function nodeList(items){
 const list=Object.create({item(i){return items[i];}});
 items.forEach((v,i)=>{list[i]=v;});
 list.length=items.length;
 return list;
}

function harness(){
 const statics=[];
 const button=new FakeEl('button');
 button.className='btn-ghost';
 button.id='preset-export';
 button.onclick=()=>{button.clicked=true;};
 const label=new FakeEl('span');label.textContent='导出全部';button.appendChild(label);
 const parent=new FakeEl('div');parent.appendChild(button);statics.push(button);
 const storage={map:{},setItem(k,v){this.map[k]=String(v);},getItem(k){return k in this.map?this.map[k]:null;},removeItem(k){delete this.map[k];}};
 const document={
  createEvent(){throw Error('no createEvent');},
  createElement(tag){return new FakeEl(tag);},
  querySelectorAll(sel){return sel==='button'?nodeList(statics):nodeList([]);},
  getElementById(){return null;},
 };
 const hostCalls=[];
 const context=vm.createContext({
  document,console,Promise,Object,Array,String,Number,Boolean,Date,Math,JSON,Set,Map,setTimeout:(fn)=>fn(),
  require(id){assert.equal(id,'./host.js');return{dispatch:async(type,args)=>{hostCalls.push({type,args});return{pong:true,type,args};}};},
 });
 context.globalThis=context;
 context.window=context;
 context.Event=class{constructor(type,opts){this.type=type;Object.assign(this,opts||{});}};
 context.localStorage=storage;
 context.addEventListener=()=>{};
 context.__adobe_cep__={};
 vm.runInContext(SOURCE,context,{filename:'uxp-bootstrap.js'});
 return {context,document,parent,button,label,hostCalls};
}

test('bootstrap loads without Element.append or NodeList.forEach and keeps localStorage usable',()=>{
 const h=harness();
 assert.equal(typeof h.context.__uxpEvent,'function');
 assert.equal(typeof h.context.__uxpOption,'function');
 assert.equal(typeof h.context.__uxpButton,'function');
 h.context.localStorage.setItem('k','v');
 assert.equal(h.context.localStorage.getItem('k'),'v');
});

test('static buttons become div controls without losing id/class/children/click',()=>{
 const h=harness();
 const converted=h.parent.children[0];
 assert.equal(converted.tagName,'DIV');
 assert.equal(converted.id,'preset-export');
 assert.equal(converted.className,'btn-ghost');
 assert.equal(converted.getAttribute('role'),'button');
 assert.equal(converted.textContent,'导出全部');
 converted.onclick();
 assert.equal(h.button.clicked,true);
});

test('parseHostCall decodes CEP hostCallExpr arguments',()=>{
 const h=harness();
 const enc=encodeURIComponent(JSON.stringify({cnFont:{family:'X',style:'Regular'}}));
 const expr='(function(){var f=null;if(!f)return "__NOHOST__";return f("font-mixer","'+enc+'");})()';
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.__uxpParseHostCall(expr))),
   {type:'font-mixer',args:{cnFont:{family:'X',style:'Regular'}}});
});

test('CSInterface.evalScript routes CEP host calls through host.dispatch',async()=>{
 const h=harness();
 const cs=new h.context.CSInterface();
 const enc=encodeURIComponent(JSON.stringify({cnSize:14}));
 let reply=null;
 cs.evalScript('(function(){return f("font-mixer","'+enc+'");})()',r=>{reply=r;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(h.hostCalls,[{type:'font-mixer',args:{cnSize:14}}]);
 assert.deepEqual(JSON.parse(reply),{pong:true,type:'font-mixer',args:{cnSize:14}});
});

test('CSInterface keeps UXP diagnostic probes local and never invokes ExtendScript',async()=>{
 const h=harness();
 const cs=new h.context.CSInterface();
 let reply=null;
 cs.evalScript('typeof cephostDispatch',r=>{reply=r;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reply,'function');
 assert.deepEqual(h.hostCalls,[]);
});
