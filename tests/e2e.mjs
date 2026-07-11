import { chromium } from 'playwright';
import fs from 'fs';

const FAKE = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

// Serve one fake module for all three firebase entrypoints.
await page.route('**/firebasejs/**', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE }));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n)); };

await page.goto('http://localhost:8899/index.html');
await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block', null, { timeout: 5000 });
await page.waitForTimeout(400);

const dump = () => page.evaluate(() => ({
  entries: [...window.__fs.store.entries.entries()].map(([id, d]) => ({
    id, content: d.content, contentVersion: d.contentVersion, contentBase: d.contentBase,
    versionCount: d.versionCount, orphanVersions: d.orphanVersions, resolvedVersions: d.resolvedVersions,
  })),
  history: Object.fromEntries([...window.__fs.store.history.entries()].map(([nid, m]) =>
    [nid, [...m.entries()].map(([vid, v]) => ({ vid, content: v.content, base: v.base }))])),
}));

// ── 1. Create a note: seed version doc must exist ─────────────────────────────
console.log('\ncreate seeds a version doc:');
await page.click('#toggle-new');
await page.fill('#new-entry', 'first text');
await page.click('#append-btn');
await page.waitForTimeout(300);
let s = await dump();
const noteId = s.entries[0]?.id;
ok('note created', !!noteId);
ok('note has contentVersion', !!s.entries[0].contentVersion);
ok('seed version doc exists with the original text',
  (s.history[noteId] || []).some(v => v.content === 'first text' && v.vid === s.entries[0].contentVersion));
ok('seed base is null', (s.history[noteId] || [])[0]?.base === null);

// ── 2. Full-editor save commits the RESULT as a new version ───────────────────
console.log('\nedit commits the result as a new version:');
const seedVid = s.entries[0].contentVersion;
await page.click('.entry-card .btn-edit');
await page.waitForSelector('.entry-card .edit-textarea');
await page.fill('.entry-card .edit-textarea', 'first text\nsecond line');
await page.click('.entry-card .btn-save');
await page.waitForTimeout(400);
s = await dump();
const vs = s.history[noteId] || [];
ok('two version docs now', vs.length === 2);
const v2 = vs.find(v => v.vid === s.entries[0].contentVersion);
ok('current version doc holds the NEW text (the result, not the baseline)', v2?.content === 'first text\nsecond line');
ok('its base is the seed version', v2?.base === seedVid);
ok('note contentBase points at the seed', s.entries[0].contentBase === seedVid);
ok('versionCount is 2', s.entries[0].versionCount === 2);

// ── 3. The stale clobber, exactly as the spec describes it ────────────────────
// Device A was offline holding the SEED. It replays: writes its own result as a version
// doc based on the seed, and overwrites `content`. The current text (V2) must survive as
// a version doc, get flagged an orphan, and light the rose edge.
console.log('\nstale offline device clobbers current:');
const curVid = s.entries[0].contentVersion;
await page.evaluate(({ noteId, seedVid }) => {
  const { writeDoc, updateDocRaw, docRef, emit, now } = window.__fs;
  writeDoc(docRef(['entries', noteId, 'history', 'Vstale']), {
    content: 'STALE overwrite from device A', createdAt: now(),
    editedAt: new Date().toISOString(), device: 'deviceA', base: seedVid,
  });
  updateDocRaw(docRef(['entries', noteId]), {
    content: 'STALE overwrite from device A',
    contentVersion: 'Vstale', contentBase: seedVid, versionCount: 3,
  });
  emit();
}, { noteId, seedVid });
await page.waitForTimeout(500);

s = await dump();
ok('current text is the stale write (last-write-wins, as designed)',
  s.entries[0].content === 'STALE overwrite from device A');
ok('the CLOBBERED version still exists as a doc',
  (s.history[noteId] || []).some(v => v.vid === curVid && v.content === 'first text\nsecond line'));

const card = page.locator('.entry-card').first();
ok('card is flagged forked', await card.evaluate(el => el.classList.contains('forked')));
const edge = await card.evaluate(el => getComputedStyle(el).borderRightColor);
ok('rose right edge (#d4728c = rgb(212,114,140))', edge === 'rgb(212, 114, 140)');

const sNow = await dump();
ok('the orphan is published on the NOTE DOC (so every device sees it)',
  (sNow.entries[0].orphanVersions || []).length > 0);

// ── 4. Viewer surfaces the orphan and clears the alert ────────────────────────
console.log('\nhistory viewer:');
await card.locator('.entry-actions button[title$="versions"]').click();
await page.waitForTimeout(500);
const label = await page.locator('.history-nav span').filter({ hasText: /\d\/\d/ }).first().textContent().catch(() => '');
ok('viewer lists all 3 versions (loaded from the subcollection)', /\/3/.test(label || ''));
// Looking is NOT resolving: the rose edge must survive opening history.
const sOpen = await dump();
const orphNow = sOpen.entries[0].orphanVersions || [];
const resNow = sOpen.entries[0].resolvedVersions || [];
ok('alert PERSISTS while the orphan is unresolved',
  orphNow.some(v => !resNow.includes(v)));
ok('rose edge still on the card after merely viewing history',
  await card.evaluate(el => el.classList.contains('forked')));

// Navigate to the orphaned version → it should carry the rose marker.
await page.locator('.history-nav button').filter({ hasText: '←' }).first().click();
await page.waitForTimeout(250);
const orphanMarked = await card.evaluate(el => el.classList.contains('version-orphan'));
const orphanText = await page.locator('.entry-content').first().textContent();
ok('an orphaned version is reachable and rose-marked', orphanMarked);
const edgeOnOrphan = await card.evaluate(el => getComputedStyle(el).borderRightColor);
ok('orphan version shows the rose edge', edgeOnOrphan === 'rgb(212, 114, 140)');

// Step forward to a NON-orphan version: the edge must NOT be rose, or every version in the
// viewer looks flagged and the viewer stops helping you find the orphans.
await page.locator('.history-nav button').filter({ hasText: '\u2192' }).first().click();
await page.waitForTimeout(250);
const edgeOnClean = await card.evaluate(el => getComputedStyle(el).borderRightColor);
ok('a NON-orphan version does NOT show rose', edgeOnClean !== 'rgb(212, 114, 140)');
ok('...and is not marked version-orphan',
  !(await card.evaluate(el => el.classList.contains('version-orphan'))));
// back to the orphan for the resolve step below
await page.locator('.history-nav button').filter({ hasText: '\u2190' }).first().click();
await page.waitForTimeout(250);

// Resolving it: bump the orphaned version. Its base becomes an ancestor of current.
console.log('\nresolving the orphan clears the alert:');
// (the previous assertion already stepped back onto the orphaned version)
const onOrphan = await card.evaluate(el => el.classList.contains('version-orphan'));
ok('parked on the orphaned version', onOrphan);
await page.locator('.history-nav .btn-rescue').first().click();
await page.waitForTimeout(800);
const afterBump = await page.evaluate(() => JSON.parse(localStorage.getItem('oneListHistoryAlerts') || '{}'));
ok('alert cleared once the orphan is rescued', !afterBump[noteId]);
ok('rose edge gone', !(await page.locator('.entry-card').first().evaluate(el => el.classList.contains('forked'))));
const finalState = await dump();
ok('rescued text is now current', /second line/.test(finalState.entries[0].content));

// ── after rescuing, the orphan is HANDLED: still in history, no longer rose ──────
console.log('\nthe rescued orphan is no longer marked outstanding:');
await page.waitForTimeout(400);
await card.locator('.entry-actions button[title$="versions"]').click();
await page.waitForTimeout(600);
const lbl = await page.locator('.history-nav span').filter({ hasText: /\d\/\d/ }).first().textContent();
ok('the rescued version is still IN history (nothing deleted)', /\/4/.test(lbl || ''));

// walk every version; none may be rose now that the orphan is resolved
let anyRose = false;
const total = parseInt((lbl || '1/1').split('/')[1], 10);
for (let i = 0; i < total; i++) {
  if (await card.evaluate(el => el.classList.contains('version-orphan'))) anyRose = true;
  const prev = page.locator('.history-nav button').filter({ hasText: '\u2190' }).first();
  if (await prev.isEnabled()) { await prev.click(); await page.waitForTimeout(150); }
}
ok('NO version is marked rose once the orphan has been dealt with', !anyRose);
const st2 = await dump();
ok('the note still RECORDS the orphan (lineage fact, not lost)',
  (st2.entries[0].orphanVersions || []).length > 0);
ok('...and records it as resolved',
  (st2.entries[0].resolvedVersions || []).length > 0);

console.log('\n--- page errors ---');
const real = errs.filter(e => !/net::|Failed to load resource|manifest|sw\.js|favicon/i.test(e));
console.log(real.length ? real.join('\n') : '(none)');
if (real.length) fail += real.length;

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
