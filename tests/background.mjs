import { chromium } from 'playwright';
import fs from 'node:fs';
const source=fs.readFileSync(process.env.BACKGROUND_HTML || 'index.html','utf8');
const fake=fs.readFileSync(new URL('./fake-firestore.js',import.meta.url),'utf8');
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
let pass=0,fail=0;
const ok=(name,value)=>{ console.log(`  ${value?'ok':'FAIL'} ${name}`);value?pass++:fail++; };
try {
 for(const kind of ['paragraph','item','new-paragraph']) {
  const page=await browser.newPage({serviceWorkers:'block'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8899/**',r=>r.fulfill({contentType:'text/html',body:source}));
  await page.route('**/firebasejs/**',r=>r.fulfill({contentType:'application/javascript',body:fake}));
  await page.goto('http://localhost:8899/index.html');
  await page.waitForFunction(()=>document.getElementById('app').style.display==='block');
  await page.click('#toggle-new');await page.fill('#new-entry',kind==='item'?'- [ ] original item':'original paragraph');await page.click('#append-btn');
  const dump=()=>page.evaluate(()=>{
   const [id,e]=[...window.__fs.store.entries][0];
   return {id,...e,history:[...window.__fs.store.history.get(id)].map(([id,h])=>({id,...h}))};
  });
  const seed=(await dump()).contentVersion;
  const open=async()=>{
   if(kind==='new-paragraph')await page.locator('.entry-card .new-zone.bottom').click();
   else await page.locator(kind==='item'?'.entry-card .todo-text':'.entry-card .entry-content p').first().click();
   await page.waitForSelector('.entry-card textarea');
  };
  const background=async()=>page.evaluate(()=>{
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});
   document.dispatchEvent(new Event('visibilitychange'));
   // Some browsers deliver another lifecycle event before the page returns.
   window.dispatchEvent(new Event('beforeunload'));
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
   document.dispatchEvent(new Event('visibilitychange'));
  });
  await open();
  await page.locator('.entry-card textarea').fill('draft before switching');
  await background();await background();
  ok(kind+': editor and unsaved text survive repeated backgrounding',await page.locator('.entry-card textarea').inputValue()==='draft before switching');
  ok(kind+': backgrounding does not prematurely save the current textarea', (await dump()).history.length===1);
  await page.locator('.entry-card textarea').fill('saved after returning');
  await page.keyboard.press('Control+Enter');await page.waitForTimeout(200);
  let state=await dump();
  ok(kind+': save updates content',state.content.includes('saved after returning'));
  const saved=state.history.find(h=>h.id===state.contentVersion);
  ok(kind+': save archives exactly one result',state.history.length===2 && saved?.content.includes('saved after returning'));
  ok(kind+': version descends from the original',saved?.base===seed);
  // Another device overwrites from the old base. Our saved result must survive.
  await page.evaluate(({id,seed})=>{
   const f=window.__fs;
   f.writeDoc(f.docRef(['entries',id,'history','remote']),{content:'remote overwrite',base:seed,device:'B',createdAt:f.now(),editedAt:new Date().toISOString()});
   f.updateDocRaw(f.docRef(['entries',id]),{content:'remote overwrite',contentVersion:'remote',contentBase:seed,versionCount:3});f.emit();
  },{id:state.id,seed});
  await page.waitForTimeout(200);
  state=await dump();
  ok(kind+': saved text survives a stale remote overwrite in history',state.history.some(h=>h.content.includes('saved after returning')));
  ok(kind+': no script errors',errors.length===0);
  await page.close();
 }
 // Exercise a coalesced session with already-applied edits at the checkpoint.
 // Bind real functions; unresolved commit promises model offline queueing.
 const slice=name=>{const a=source.indexOf('    function '+name+'(');return source.slice(a,source.indexOf('\n    }',a)+6);};
 const sessions=new Map(),commits=[];
 const f=new Function('blockSessions','commitVersion',slice('sessionFor')+slice('endBlockSession')+';return {sessionFor,endBlockSession};')(sessions,(id,content,base,extra,entry)=>{
  const version='v'+(commits.length+1);commits.push({version,content,base});entry.contentVersion=version;return new Promise(()=>{});
 });
 const entry={id:'checkpoint',content:'original',contentVersion:'v0'};
 const session=f.sessionFor(entry);entry.content='already applied by navigation';
 f.endBlockSession(entry,{keepSession:true});f.endBlockSession(entry,{keepSession:true});
 ok('checkpoint archives once without waiting for server',commits.length===1);
 ok('checkpoint retains the exact session captured by the editor',sessions.get(entry.id)===session);
 entry.content='continued after returning';f.endBlockSession(entry);
 ok('continued session archives another result',commits.length===2);
 ok('continued session bases on checkpoint version',commits[1]?.base==='v1');
 ok('final teardown removes session',!sessions.has(entry.id));
}finally{await browser.close();}
console.log(`\n${pass} passed, ${fail} failed`);process.exitCode=fail?1:0;
