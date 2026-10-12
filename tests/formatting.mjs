import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const fake = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let passed = 0;
async function test(name, fn, mobile = false) {
  const page = await browser.newPage({ serviceWorkers: 'block',
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
  try {
    await page.goto('http://localhost:8899/index.html');
    await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
    await page.click('#toggle-new');
    await fn(page);
    assert.deepEqual(errors, []);
    console.log('  ok   ' + name); passed++;
  } finally { await page.close(); }
}

const selection = editor => editor.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd]);

try {
  for (const mobile of [false, true]) {
    await test(`heading toggle then Enter preserves the title (${mobile ? 'touch' : 'mouse'})`, async page => {
      const editor = page.locator('#new-entry');
      await editor.fill('My title');
      await editor.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
      const button = page.locator('#new-actions > .cycle-wrapper > button').first();
      if (mobile) await button.tap(); else await button.click();
      assert.equal(await editor.inputValue(), '# My title');
      assert.deepEqual(await selection(editor), [true, 10, 10]);
      await page.keyboard.press('Enter');
      await page.keyboard.type('Body');
      assert.equal(await editor.inputValue(), '# My title\nBody');
    }, mobile);
  }

  await test('adding and removing a heading keeps the caret within the same word', async page => {
    const editor = page.locator('#new-entry');
    await editor.fill('My title\nBody');
    await editor.evaluate(el => el.setSelectionRange(5, 5));
    const button = page.locator('#new-actions > .cycle-wrapper > button').first();
    await button.click();
    assert.deepEqual(await selection(editor), [true, 7, 7]);
    await button.click();
    assert.equal(await editor.inputValue(), 'My title\nBody');
    assert.deepEqual(await selection(editor), [true, 5, 5]);
    await page.keyboard.type('!');
    assert.equal(await editor.inputValue(), 'My ti!tle\nBody');
  });

  await test('an empty heading places the caret after its marker', async page => {
    const editor = page.locator('#new-entry');
    await page.locator('#new-actions > .cycle-wrapper > button').first().click();
    assert.equal(await editor.inputValue(), '# ');
    assert.deepEqual(await selection(editor), [true, 2, 2]);
    await page.keyboard.type('Title');
    assert.equal(await editor.inputValue(), '# Title');
  });

  await test('heading changes preserve deliberate partial multiline selections', async page => {
    const editor = page.locator('#new-entry');
    await editor.fill('Alpha\n\nBeta\nUntouched');
    await editor.evaluate(el => el.setSelectionRange(2, 9, 'backward'));
    await page.locator('#new-actions > .cycle-wrapper > button').first().hover();
    await page.locator('#new-actions .cycle-popover.show button[title="Heading 1"]').click();
    assert.equal(await editor.inputValue(), '# Alpha\n\n# Beta\nUntouched');
    assert.deepEqual(await selection(editor), [true, 4, 13]);
    assert.equal(await editor.evaluate(el => el.selectionDirection), 'backward');
  });

  for (const fullNote of [false, true]) {
    await test(`${fullNote ? 'whole-note' : 'block'} editor heading toggle then Enter preserves saved title and body`, async page => {
      await page.fill('#new-entry', 'My title\n\nExisting body');
      await page.click('#append-btn');
      if (fullNote) await page.locator('.entry-card button[title="Edit"]').click();
      else await page.locator('.entry-content p').first().click();
      const editor = page.locator(fullNote ? '.edit-textarea' : '.block-edit');
      await editor.evaluate(el => el.setSelectionRange(8, 8));
      await page.locator('.entry-card .entry-actions > .cycle-wrapper > button').first().click();
      assert.deepEqual(await selection(editor), [true, 10, 10]);
      await page.keyboard.press('Enter');
      await page.keyboard.type('New body');
      await page.keyboard.press('Control+Enter');
      const saved = await page.evaluate(() => [...window.__fs.store.entries.values()][0].content);
      assert.equal(saved, '# My title\nNew body\n\nExisting body');
    });
  }

  console.log(`${passed} passed, 0 failed`);
} finally { await browser.close(); }
