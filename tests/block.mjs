import { chromium } from 'playwright';
import fs from 'fs';
const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: ' + m.text()); });
await p.route('**/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
let pass=0, fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n));};
const dump = () => p.evaluate(() => {
  const [id, e] = [...window.__fs.store.entries.entries()][0];
  const h = [...(window.__fs.store.history.get(id) || new Map()).entries()].map(([vid,v])=>({vid,content:v.content,base:v.base}));
  return { id, content: e.content, contentVersion: e.contentVersion, contentBase: e.contentBase, versionCount: e.versionCount, h };
});

await p.goto('http://localhost:8899/index.html');
await p.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
await p.click('#toggle-new'); await p.fill('#new-entry', 'alpha\n\nbeta'); await p.click('#append-btn');
await p.waitForTimeout(300);
let s = await dump();
const seed = s.contentVersion;
console.log('\nblock editor session:');
ok('seeded', s.versionCount === 1 && s.h.length === 1);

// Click a rendered block to open the inline editor, type, then Escape to tear down.
await p.click('.entry-card .entry-content p');
await p.waitForSelector('.entry-card textarea', { timeout: 3000 });
await p.waitForTimeout(150);
const ta = p.locator('.entry-card textarea').first();
await ta.fill('alpha edited');
await p.waitForTimeout(150);
await p.keyboard.press('Control+Enter');
await p.waitForTimeout(600);

s = await dump();
ok('block edit changed the note content', /alpha edited/.test(s.content));
console.log('   DUMP', JSON.stringify(s, null, 1));
ok('ONE new version doc committed at session teardown', s.h.length === 2);
const v = s.h.find(x => x.vid === s.contentVersion);
ok('version holds the session RESULT', /alpha edited/.test(v?.content || ''));
ok('version base is the seed', v?.base === seed);
ok('versionCount incremented to 2', s.versionCount === 2);

// A second block session should add exactly one more version (coalesced, not per-keystroke).
await p.click('.entry-card .entry-content p');
await p.waitForSelector('.entry-card textarea', { timeout: 3000 });
await p.waitForTimeout(150);
await p.locator('.entry-card textarea').first().fill('alpha twice');
await p.waitForTimeout(150);
await p.keyboard.press('Control+Enter');
await p.waitForTimeout(600);
s = await dump();
ok('second session adds exactly one version (coalesced)', s.h.length === 3);
ok('its base is the previous version', s.h.find(x=>x.vid===s.contentVersion)?.base === v?.vid);

console.log('\n--- page errors ---');
const real = errs.filter(e => !/net::|Failed to load resource|manifest|sw\.js|favicon|ServiceWorker/i.test(e));
console.log(real.length ? real.join('\n') : '(none)');
if (real.length) fail += real.length;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
