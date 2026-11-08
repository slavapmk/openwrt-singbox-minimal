/* Execute the LuCI view with small form/RPC doubles; exercise real handlers. */
const assert = require('node:assert/strict');
const fsNative = require('node:fs');
const path = require('node:path');
const source = fsNative.readFileSync(path.join(__dirname, '../singbox-ui/root/www/luci-static/resources/view/singboxui/main.js'), 'utf8');
const maps=[], calls=[], notifications=[];
let active='{"version":"active"}\n', pending=null, log='old entry', commits=0, saves=0;
function E(tag, attrs={}, children=[]) {
 return {tag,attrs,children:Array.isArray(children)?children:[children],textContent:'',value:'',click(){},setValue(v){this.value=v;},getValue(){return this.value;},triggerValidation(){}};
}
class Option {
 constructor(section, tab, type, name, args) {
  Object.assign(this,{section,tab,type,name});this.editor=E('textarea');
  if(type==='SectionValue') this.subsection=new Section(...args);
 }
 getUIElement(){return this.editor;}
}
class Section {
 constructor(type, title){this.type=type;this.title=title;this.tabs=[];this.options=[];}
 tab(id,label){this.tabs.push([id,label]);}
 taboption(tab,type,name,...args){const o=new Option(this,tab,type,name,args);this.options.push(o);return o;}
 option(type,name,...args){return this.taboption(null,type,name,...args);}
}
class Map {
 constructor(){this.sections=[];maps.push(this);}
 section(type,id,name){const s=new Section(id,name);this.sections.push(s);return s;}
 async save(){saves++;}
 async reset(){}
 async render(){
  const renderOptions=(s,id)=>s.options.map(o=>{
   if(o.load) o.editor.value=o.load();
   const child=o.subsection?renderOptions(o.subsection,'geo1'):o.renderWidget?o.renderWidget(id):o.editor;
   return E('option',{tab:o.tab,name:o.name},[child]);
  });
  return E('map',{},this.sections.flatMap(s=>renderOptions(s,'main')));
 }
}
const form={Map,NamedSection:'NamedSection',GridSection:'GridSection',SectionValue:'SectionValue',DynamicList:'DynamicList',Value:'Value',DummyValue:'DummyValue',TextValue:'TextValue',Flag:'Flag'};
const uci={load:async()=>{},get:()=> 'test.srs'};
const fs={
 read:async p=>{
  if(p.endsWith('config.pending.json')) {if(pending===null)throw Error('missing');return pending;}
  return active;
 },
 write:async(p,v)=>{calls.push(['write',p,v]);},
 exec:async(p,args)=>{
  calls.push(args);
  if(args[0]==='rollback') {active='{"version":"previous"}\n';pending=null;}
  if(args[0]==='clear-log') log='';
  return {code:0,stdout:args[0]==='status'?JSON.stringify({running:false,state:'stopped',ram:1000,log,files:[]}):'OK'};
 }
};
const ui={createHandlerFn:(ctx,fn)=>(...args)=>fn.apply(ctx,args),addNotification:(...args)=>notifications.push(args)};
const rpc={declare:()=>async()=>{commits++;}};
const poll={add:()=>{}};
const win={location:{reload(){}},URL:global.URL};
const view={extend:o=>o};
const page=new Function('view','form','uci','rpc','fs','ui','poll','E','window',source)(view,form,uci,rpc,fs,ui,poll,E,win);
function all(node){if(Array.isArray(node))return node.flatMap(all);return !node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(all)];}
function button(root,text){const n=all(root).find(n=>n.tag==='button'&&n.children.includes(text));assert(n,'Missing button '+text);return n;}
(async()=>{
 const data=await page.load();
 const root=await page.render(data);
 const main=maps[0].sections[0];
 assert.deepEqual(main.tabs.map(t=>t[1]),['Bin','Geo Files','Конфигурация JSON','Настройки запуска','Перехват LAN','Логи']);
 assert.equal(maps[0].sections.length,1,'Geo must be nested inside its tab');
 assert.equal(main.options.find(o=>o.name==='geo_files').tab,'geo');
 assert.equal(main.options.find(o=>o.name==='app_logs').tab,'logs');
 assert.deepEqual(root.children[1].children.map(b=>b.children[0]),['Скачать Bin','Запустить','Остановить','Перезапустить']);
 await button(root,'Скачать').attrs.click();
 assert(calls.some(a=>a[0]==='download-asset'&&a[1]==='geo1'));
 await button(root,'Удалить из RAM').attrs.click();
 assert(calls.some(a=>a[0]==='remove-asset'&&a[1]==='geo1'));
 const editor=page.editor.getUIElement('main');
 editor.value='unsaved broken JSON';
 await button(root,'Восстановить предыдущий JSON').attrs.click();
 assert.equal(editor.value,active,'Rollback must refresh editor');
 const before=calls.length;
 await page.handleSave();
 assert.equal(saves,1);assert.equal(commits,1);
 assert(!calls.slice(before).some(a=>a[0]==='apply'),'Save must not start/apply');
 const logBox=all(root).find(n=>n.tag==='textarea'&&n.attrs.readonly==='');
 await button(root,'Очистить журнал').attrs.click();
 assert.equal(logBox.value,'');
 // An older poll must not restore pre-clear log contents.
 let resolveOld;
 const normalExec=fs.exec;
 fs.exec=(p,args)=>args[0]==='status'?new Promise(resolve=>{resolveOld=resolve;}):normalExec(p,args);
 const oldPoll=button(root,'Обновить').attrs.click();
 fs.exec=normalExec;
 await button(root,'Очистить журнал').attrs.click();
 resolveOld({code:0,stdout:JSON.stringify({ram:1000,log:'stale log',files:[]})});
 await oldPoll;
 assert.equal(logBox.value,'');
 console.log('PASS: six tabs, toolbar, per-file actions, save without start, rollback editor, clear/poll race');
})().catch(e=>{console.error(e);process.exitCode=1;});
