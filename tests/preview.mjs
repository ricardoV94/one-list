import { chromium } from 'playwright';
import fs from 'node:fs';
const source=fs.readFileSync(process.env.PREVIEW_HTML || 'index.html','utf8');
const fake=fs.readFileSync(new URL('./fake-firestore.js',import.meta.url),'utf8')
 .replace('export function onSnapshot(', 'export function unusedOnSnapshot(')+'\nexport function onSnapshot() { return () => {}; }';
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
let pass=0,fail=0;
const ok=(name,value)=>{console.log(`  ${value?'ok':'FAIL'} ${name}`);value?pass++:fail++;};
try {
 const page=await browser.newPage({serviceWorkers:'block',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  localStorage.setItem('wasSignedIn','me@test.dev');
  localStorage.setItem('notesCache',JSON.stringify([
   {id:'hidden',content:'Do not preview this set-aside note',owner:'other@test.dev',shared:true,hiddenFor:['me@test.dev']},
   {id:'cached',content:'## Cached heading\n\nVisible **bold** text\n\n- (x) Finished task\n\n<img src="x" onerror="window.__unsafe=1"><script>window.__unsafe=1<\/script>',owner:'me@test.dev',createdAt:1788732000000,sortTime:1788732000000},
   {id:'forked',content:'Saved with an unresolved edit',owner:'me@test.dev',shared:true,orphanVersions:['v1']},
  ]));
  const get=Storage.prototype.getItem;window.__cacheReads=0;
  Storage.prototype.getItem=function(key){if(key==='notesCache')window.__cacheReads++;return get.call(this,key);};
 });
 await page.route('http://localhost:8899/**',r=>r.fulfill({contentType:'text/html',body:source}));
 let release;const gate=new Promise(r=>release=r);
 await page.route('**/firebasejs/**',async r=>{await gate;await r.fulfill({contentType:'application/javascript',body:fake});});
 await page.goto('http://localhost:8899/?text=Shared+draft',{waitUntil:'commit'});
 // Marked and DOMPurify must be ready; Firebase remains held indefinitely.
 await page.waitForFunction(()=>typeof marked!=='undefined'&&typeof DOMPurify!=='undefined');
 await page.waitForTimeout(150);
 ok('cached notes visible while Firebase imports are blocked',await page.locator('#boot-notes .entry-content').first().isVisible());
 ok('preview uses formatted Markdown',await page.locator('#boot-notes h2').evaluateAll(nodes=>nodes[0]?.textContent)==='Cached heading');
 ok('legacy checkbox formatting preserved',await page.locator('#boot-notes .todo-item.checked').count()===1);
 ok('set-aside note excluded',!(await page.locator('#boot-notes').evaluateAll(nodes=>nodes[0]?.textContent || '')).includes('Do not preview'));
 ok('cached HTML sanitized',await page.evaluate(()=>!window.__unsafe && !document.querySelector('#boot-notes [onerror], #boot-notes script')));
 ok('preview has no write controls',await page.locator('#boot-notes button, #boot-notes input:not([disabled])').count()===0);
 ok('save remains disabled before Firebase',await page.locator('#append-btn').isDisabled());
 await page.locator('#new-entry').fill('Edited share while reading cached notes');
 const toast=()=>page.locator('.sync-toast').evaluateAll(nodes=>nodes.at(-1)?.textContent || '');
 const clearToast=()=>page.locator('.sync-toast').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));
 const tap=async selector=>{
  const target=page.locator(selector).first();await target.scrollIntoViewIfNeeded();
  const box=await target.boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
 };
 await tap('#boot-notes h2');
 ok('tapping a cached note explains that editing must wait',/still connecting.*try again/i.test(await toast()));
 ok('early edit attempt leaves preview intact',await page.locator('#boot-notes textarea').count()===0);
 await clearToast();await tap('#boot-notes input[type="checkbox"]');
 ok('early checkbox action explains the wait without changing it',/still connecting.*try again/i.test(await toast()) && await page.locator('#boot-notes input').first().isChecked());
 await clearToast();await tap('#append-btn');
 ok('early Save tap explains that it has not saved',/still connecting.*try again/i.test(await toast()));
 ok('early Save keeps the draft',await page.locator('#new-entry').inputValue()==='Edited share while reading cached notes');
 await clearToast();await page.locator('#append-btn').focus();await page.keyboard.press('Enter');
 ok('early Save feedback is keyboard accessible',/still connecting.*try again/i.test(await toast()));
 await clearToast();await page.locator('#new-entry').focus();await page.keyboard.press('Control+Enter');
 ok('early keyboard save explains the wait',/still connecting.*try again/i.test(await toast()));
 await clearToast();
 if(process.env.PREVIEW_SCREENSHOT){
  // Playwright's screenshot waits for fonts.ready, which is held by our deliberately
  // blocked module. Capture the current pixels without waiting for document load.
  const cdp=await page.context().newCDPSession(page);
  const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(process.env.PREVIEW_SCREENSHOT,Buffer.from(data,'base64'));await cdp.detach();
 }
 release();
 await page.waitForFunction(()=>!!window.__fs);
 await page.waitForTimeout(300);
 ok('preview replaced by interactive cards',await page.locator('#boot-notes').count()===0 && await page.locator('#entries-list .entry-card').count()===2);
 ok('fork marker present after takeover',await page.locator('#entries-list .entry-card.forked').count()===1);
 ok('notes cache read once across both stages',await page.evaluate(()=>window.__cacheReads===1));
 ok('share draft survives takeover',await page.locator('#new-entry').inputValue()==='Edited share while reading cached notes');
 ok('save enabled after handlers initialize',!await page.locator('#append-btn').isDisabled());
 ok('no early write was replayed during handover',await page.evaluate(()=>window.__fs.store.entries.size===0));
 await page.locator('#entries-list .entry-content p').first().click();
 ok('cached note becomes editable after startup',await page.locator('#entries-list textarea').count()===1);
 await page.locator('#entries-list textarea').fill('Edited before the database listener starts');
 await page.keyboard.press('Control+Enter');
 ok('editing and saving before the listener starts queues the change',await page.evaluate(()=>window.__fs.store.entries.get('cached')?.content.includes('Edited before the database listener starts')));
 ok('queued edit save shows connecting feedback',/still connecting.*will sync/i.test(await toast()));
 await clearToast();await page.locator('#append-btn').click();
 ok('shared draft saves when retried after startup',await page.evaluate(()=>[...window.__fs.store.entries.values()].some(n=>n.content==='Edited share while reading cached notes')));
 ok('queued shared save shows connecting feedback',/still connecting.*will sync/i.test(await toast()));
 ok('no script errors',errors.length===0);
 await page.close();
}finally{await browser.close();}
console.log(`\n${pass} passed, ${fail} failed`);process.exitCode=fail?1:0;
