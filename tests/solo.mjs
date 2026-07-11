import { chromium } from 'playwright';
import fs from 'fs';
const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.route('**/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
let pass=0, fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n));};
const state = () => p.evaluate(() => {
  const [id, e] = [...window.__fs.store.entries.entries()][0];
  const h = [...(window.__fs.store.history.get(id)||new Map()).entries()].map(([vid,v])=>({vid, base:v.base, content:v.content}));
  return { id, content:e.content, cv:e.contentVersion, cb:e.contentBase, h,
           alerts: JSON.parse(localStorage.getItem('oneListHistoryAlerts')||'{}'),
           forked: !!document.querySelector('.entry-card.forked') };
});

await p.goto('http://localhost:8899/index.html');
await p.waitForFunction(() => document.getElementById('app')?.style.display === 'block');

// ── EXACTLY the user's sequence: ONE device, ONE note, no remote writes at all ──
console.log("\nsolo device, two consecutive edits (the user's repro):");
await p.click('#toggle-new'); await p.fill('#new-entry', 'test me'); await p.click('#append-btn');
await p.waitForTimeout(400);

// block-edit the line: add blank lines + more text, commit
await p.click('.entry-card .entry-content p');
await p.waitForSelector('.entry-card textarea');
await p.waitForTimeout(150);
await p.locator('.entry-card textarea').first().fill('test me\n\nand me');
await p.waitForTimeout(200);
await p.keyboard.press('Control+Enter');
await p.waitForTimeout(700);

let s = await state();
console.log('   lineage:', JSON.stringify(s.h.map(v => v.vid + '<-' + v.base)), 'current=', s.cv);
ok('no fork alert on a solo device', !s.alerts[s.id]);
ok('NO red edge', !s.forked);
// every version must chain to the seed — no branch
const byId = new Map(s.h.map(v => [v.vid, v]));
let cur = s.cv, chain = 0;
while (cur && byId.has(cur)) { chain++; cur = byId.get(cur).base; }
ok('lineage is one unbroken chain (no self-orphan)', chain === s.h.length);

// ── a THIRD edit on the same card, still no re-render in between ──
console.log('\nthird consecutive edit on the same card:');
await p.click('.entry-card .entry-content p');
await p.waitForSelector('.entry-card textarea');
await p.waitForTimeout(150);
await p.locator('.entry-card textarea').first().fill('test me again');
await p.waitForTimeout(200);
await p.keyboard.press('Control+Enter');
await p.waitForTimeout(700);
s = await state();
console.log('   lineage:', JSON.stringify(s.h.map(v => v.vid + '<-' + v.base)), 'current=', s.cv);
ok('still no fork alert', !s.alerts[s.id]);
ok('still no red edge', !s.forked);
cur = s.cv; chain = 0;
const byId2 = new Map(s.h.map(v => [v.vid, v]));
while (cur && byId2.has(cur)) { chain++; cur = byId2.get(cur).base; }
ok('lineage still one unbroken chain', chain === s.h.length);

// ── full editor twice in a row, same card ──
console.log('\nfull editor, twice in a row:');
for (const txt of ['full one', 'full two']) {
  await p.click('.entry-card .btn-edit');
  await p.waitForSelector('.entry-card .edit-textarea');
  await p.fill('.entry-card .edit-textarea', txt);
  await p.click('.entry-card .btn-save');
  await p.waitForTimeout(600);
}
s = await state();
console.log('   lineage:', JSON.stringify(s.h.map(v => v.vid + '<-' + v.base)), 'current=', s.cv);
ok('no fork alert after back-to-back full edits', !s.alerts[s.id]);
ok('no red edge', !s.forked);
cur = s.cv; chain = 0;
const byId3 = new Map(s.h.map(v => [v.vid, v]));
while (cur && byId3.has(cur)) { chain++; cur = byId3.get(cur).base; }
ok('lineage one unbroken chain', chain === s.h.length);

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
