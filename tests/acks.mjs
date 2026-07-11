import { chromium } from 'playwright';
import fs from 'fs';
const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.route('**/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
let pass=0, fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n));};

await p.goto('http://localhost:8899/index.html');
await p.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
await p.click('#toggle-new'); await p.fill('#new-entry', 'v0'); await p.click('#append-btn');
await p.waitForTimeout(400);
await p.click('.entry-card .btn-edit');
await p.waitForSelector('.entry-card .edit-textarea');
await p.fill('.entry-card .edit-textarea', 'mine');
await p.click('.entry-card .btn-save');
await p.waitForTimeout(500);
const st = await p.evaluate(() => { const [id,e]=[...window.__fs.store.entries.entries()][0]; return {id, cv:e.contentVersion, cb:e.contentBase}; });

console.log('\nstale clobber -> red:');
await p.evaluate(({id, cb}) => {
  const { writeDoc, updateDocRaw, docRef, emit, now } = window.__fs;
  writeDoc(docRef(['entries', id, 'history', 'Vstale']), {
    content: 'stale', createdAt: now(), editedAt: new Date().toISOString(), device: 'A', base: cb });
  updateDocRaw(docRef(['entries', id]), { content: 'stale', contentVersion: 'Vstale', contentBase: cb, versionCount: 3 });
  emit();
}, st);
await p.waitForTimeout(700);
ok('red edge shown', await p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked')));

console.log('\nANOTHER device acknowledges the orphan (writes resolvedVersions):');
await p.evaluate(({id, cv}) => {
  const { updateDocRaw, docRef, emit } = window.__fs;
  updateDocRaw(docRef(['entries', id]), { resolvedVersions: [cv] });   // the orphan is OUR old version
  emit();
}, st);
await p.waitForTimeout(900);
ok('red edge clears from a REMOTE acknowledgement',
  !(await p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked'))));
const ls = await p.evaluate(() => localStorage.getItem('oneListForkAcks'));
ok('no per-device ack store left behind', ls === null);

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
