import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// Keep the seeded cached notes visible while observing that layout changes make
// no database writes (the fake server otherwise immediately emits an empty list).
const fake = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8')
  .replace('export function onSnapshot(', 'export function unusedOnSnapshot(')
  + '\nexport function onSnapshot() { return () => {}; }';
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
await page.addInitScript(() => {
  localStorage.setItem('wasSignedIn', 'me@test.dev');
  localStorage.setItem('notesCache', JSON.stringify([
    { id: 'a', content: 'First note', owner: 'me@test.dev' },
    { id: 'b', content: 'Second note', owner: 'me@test.dev' },
  ]));
});
let passed = 0;
const width = () => page.evaluate(() => document.body.getBoundingClientRect().width);
const handle = page.locator('#entries-list .notes-width-handle').first();
const test = async (name, fn) => { await fn(); console.log('  ok   ' + name); passed++; };
async function drag(dx, pressEscape = false) {
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  if (pressEscape) {
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('body').evaluate(b => b.classList.contains('resizing-notes')), true);
  }
  await page.mouse.up();
}
try {
  await page.goto('http://localhost:8899/index.html');
  await handle.waitFor();
  await test('left edge resizes every note together', async () => {
    assert.equal(await width(), 760);
    await drag(-80);
    assert.equal(await width(), 920);
    const widths = await page.locator('#entries-list .entry-card').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().width));
    assert.equal(widths.length, 2);
    assert.equal(widths[0], widths[1]);
    assert.equal(widths[0], 876);
  });
  await test('keyboard shortcuts do not resize, reset, or cancel dragging', async () => {
    await drag(80, true);
    assert.equal(await width(), 760);
    assert.equal(await page.locator('body').evaluate(b => b.classList.contains('resizing-notes')), false);
    assert.equal(await handle.evaluate(el => el.tabIndex), -1);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Home');
    assert.equal(await width(), 760);
  });
  await test('width is bounded; double-click leaves it unchanged', async () => {
    await drag(700);
    assert.equal(await width(), 420);
    await drag(-1000);
    assert.equal(await width(), 1280);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await handle.dblclick();
    assert.equal(await width(), 1280);
    await page.reload();
    await handle.waitFor();
    assert.equal(await width(), 760);
  });
  await test('resizing does not write notes and reload restores the default', async () => {
    await drag(-60);
    assert.equal(await width(), 880);
    assert.equal(await page.evaluate(() => window.__fs.store.entries.size), 0);
    await page.reload();
    await handle.waitFor();
    assert.equal(await width(), 760);
  });
  await test('narrow screens hide the handle and use the normal layout', async () => {
    await drag(-60);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await handle.isVisible(), false);
    assert.equal(await width(), 390);
  });
  await test('resizing keeps an open note editor intact', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#entries-list .entry-content p').first().click();
    const editor = page.locator('#entries-list textarea');
    await editor.waitFor();
    const source = await editor.inputValue();
    await drag(-40);
    assert.equal(await editor.isVisible(), true);
    assert.equal(await editor.inputValue(), source);
  });
  await test('wide touch-only screens also hide the handle', async () => {
    const touch = await browser.newPage({ viewport: { width: 1024, height: 900 }, isMobile: true, hasTouch: true });
    await touch.route('**/firebasejs/**', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
    await touch.addInitScript(() => {
      localStorage.setItem('wasSignedIn', 'me@test.dev');
      localStorage.setItem('notesCache', JSON.stringify([{ id: 'touch', content: 'Touch note', owner: 'me@test.dev' }]));
    });
    await touch.goto('http://localhost:8899/index.html');
    const edge = touch.locator('#entries-list .notes-width-handle');
    await edge.waitFor({ state: 'attached' });
    assert.equal(await edge.isVisible(), false);
    await touch.close();
  });
  assert.deepEqual(errors, []);
  console.log(`${passed} passed, 0 failed`);
} finally { await browser.close(); }
