import { chromium } from 'playwright';
import fs from 'fs';
const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.route('**/firebasejs/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));
let pass=0, fail=0;
const ok=(n,c)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n));};
const alerts = async () => { const e = await p.evaluate(() => [...window.__fs.store.entries.entries()][0]);
  const d = e[1]; const orph = d.orphanVersions||[]; const res = d.resolvedVersions||[];
  return orph.some(v => !res.includes(v)) ? { [e[0]]: true } : {}; };
const held = () => p.evaluate(() => JSON.parse(localStorage.getItem('oneListNoteVersions')||'{}'));

await p.goto('http://localhost:8899/index.html');
await p.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
await p.click('#toggle-new'); await p.fill('#new-entry', 'v0'); await p.click('#append-btn');
await p.waitForTimeout(400);
let s = await p.evaluate(() => { const [id,e]=[...window.__fs.store.entries.entries()][0]; return {id, cv:e.contentVersion}; });
const noteId = s.id;

console.log('\nTHIS device edits, then the OTHER device edits on top (clean sequential sync):');
// 1. This device edits → V1
await p.click('.entry-card .btn-edit');
await p.waitForSelector('.entry-card .edit-textarea');
await p.fill('.entry-card .edit-textarea', 'v1 from A');
await p.click('.entry-card .btn-save');
await p.waitForTimeout(500);
const v1 = (await p.evaluate(() => [...window.__fs.store.entries.values()][0].contentVersion));
ok('we hold our own version after saving', (await held())[noteId] === v1);
ok('no alert from our own edit', !(await alerts())[noteId]);

// 2. Remote device B edits ON TOP of v1 — base === what we hold. Must NOT alert.
await p.evaluate(({ noteId, v1 }) => {
  const { writeDoc, updateDocRaw, docRef, emit, now } = window.__fs;
  writeDoc(docRef(['entries', noteId, 'history', 'Vb']), {
    content: 'v2 from B', createdAt: now(), editedAt: new Date().toISOString(), device: 'B', base: v1 });
  updateDocRaw(docRef(['entries', noteId]), {
    content: 'v2 from B', contentVersion: 'Vb', contentBase: v1, versionCount: 3 });
  emit();
}, { noteId, v1 });
await p.waitForTimeout(500);
ok('NO false positive on a clean sequential remote edit', !(await alerts())[noteId]);
ok('no rose edge', !(await p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked'))));
ok('we now hold B\'s version', (await held())[noteId] === 'Vb');

// 3. Now WE edit on top of B's. Our base must be Vb, not something stale.
await p.click('.entry-card .btn-edit');
await p.waitForSelector('.entry-card .edit-textarea');
await p.fill('.entry-card .edit-textarea', 'v3 from A again');
await p.click('.entry-card .btn-save');
await p.waitForTimeout(500);
const st = await p.evaluate(() => [...window.__fs.store.entries.values()][0]);
ok('our new version bases on B\'s version (not a stale one)', st.contentBase === 'Vb');
ok('still no alert', !(await alerts())[noteId]);

// ── The case that actually bit the user ──────────────────────────────────────
// A remote device commits a CHAIN (Vc1 <- Vc2) while we aren't looking, and the snapshot
// coalesces so we only ever see the final one. Its base (Vc1) is a version we never held,
// so the hot-path check SUSPECTS a fork — but Vc1 descends from what we held, nothing was
// orphaned, and the edge must stay dark.
console.log('\ncoalesced remote chain (base we never saw, but NOT a fork):');
const cur = await p.evaluate(() => [...window.__fs.store.entries.values()][0].contentVersion);
await p.evaluate(({ noteId, cur }) => {
  const { writeDoc, updateDocRaw, docRef, emit, now } = window.__fs;
  // Both docs land, but only ONE snapshot fires — the intermediate is never observed.
  writeDoc(docRef(['entries', noteId, 'history', 'Vc1']), {
    content: 'c1', createdAt: now(), editedAt: new Date().toISOString(), device: 'C', base: cur });
  writeDoc(docRef(['entries', noteId, 'history', 'Vc2']), {
    content: 'c2', createdAt: now(), editedAt: new Date().toISOString(), device: 'C', base: 'Vc1' });
  updateDocRaw(docRef(['entries', noteId]), {
    content: 'c2', contentVersion: 'Vc2', contentBase: 'Vc1', versionCount: 5 });
  emit();
}, { noteId, cur });
await p.waitForTimeout(700);
ok('NO alert: base was unseen, but nothing is orphaned', !(await alerts())[noteId]);
ok('no rose edge on a clean fast-forward',
  !(await p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked'))));

// And the real thing still alerts: a version based on an ANCESTOR of what we hold.
console.log('\ngenuine fork still alerts:');
await p.evaluate(({ noteId, cur }) => {
  const { writeDoc, updateDocRaw, docRef, emit, now } = window.__fs;
  writeDoc(docRef(['entries', noteId, 'history', 'Vstale']), {
    content: 'stale', createdAt: now(), editedAt: new Date().toISOString(), device: 'D', base: cur });
  updateDocRaw(docRef(['entries', noteId]), {
    content: 'stale', contentVersion: 'Vstale', contentBase: cur, versionCount: 6 });
  emit();
}, { noteId, cur });
await p.waitForTimeout(700);
ok('alert fires when a version really IS orphaned', (await alerts())[noteId] === true);
ok('rose edge shown',
  await p.locator('.entry-card').first().evaluate(el => el.classList.contains('forked')));

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
