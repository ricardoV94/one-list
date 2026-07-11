import { chromium } from 'playwright';
import fs from 'fs';
const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.route('**/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
let pass=0, fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n));};
const forked = () => p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked'));

await p.goto('http://localhost:8899/index.html');
await p.waitForFunction(() => document.getElementById('app')?.style.display === 'block');

// A device that NEVER witnessed the fork: the note simply arrives already carrying
// orphanVersions (some other device detected and published it).
console.log('\na device that never witnessed the fork:');
await p.evaluate(() => {
  const { writeDoc, docRef, emit, now } = window.__fs;
  writeDoc(docRef(['entries', 'n1']), {
    content: 'winner text', createdAt: now(), sortTime: now(), owner: 'me@test.dev', shared: false,
    contentVersion: 'Vwin', contentBase: 'Vseed', versionCount: 3,
    orphanVersions: ['Vlost'],            // published by the OTHER device
  });
  emit();
});
await p.waitForTimeout(500);
ok('shows the rose edge straight from the note doc (no witness, no history read)', await forked());
ok('no per-device alert store is used',
  await p.evaluate(() => localStorage.getItem('oneListHistoryAlerts')) === null);

console.log('\nsomeone else resolves it:');
await p.evaluate(() => {
  const { updateDocRaw, docRef, emit } = window.__fs;
  updateDocRaw(docRef(['entries', 'n1']), { resolvedVersions: ['Vlost'] });
  emit();
});
await p.waitForTimeout(500);
ok('rose edge clears everywhere once resolved', !(await forked()));

console.log('\na second, unresolved orphan appears:');
await p.evaluate(() => {
  const { updateDocRaw, docRef, emit } = window.__fs;
  updateDocRaw(docRef(['entries', 'n1']), { orphanVersions: ['Vlost', 'Vlost2'] });
  emit();
});
await p.waitForTimeout(500);
ok('red returns for the NEW orphan only', await forked());

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
