import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(process.env.FOCUS_HTML || 'index.html', 'utf8');
const fake = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let passed = 0;
async function test(name, fn, mobile = false) {
  const page = await browser.newPage({ serviceWorkers: 'block',
    ...(mobile ? { viewport: { width: typeof mobile === 'number' ? mobile : 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://localhost:8899/index.html', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
  try {
    await page.goto('http://localhost:8899/index.html');
    await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
    for (const source of ['Other private note', 'Meeting title\n\n- Item']) {
      if (!await page.locator('#new-entry').isVisible()) await page.click('#toggle-new');
      await page.fill('#new-entry', source);
      await page.click('#append-btn');
    }
    await fn(page);
    assert.deepEqual(errors, []);
    console.log('  ok   ' + name); passed++;
  } finally { await page.close(); }
}
const meeting = page => page.locator('.entry-card').filter({ hasText: 'Meeting title' });
const visibleNotes = page => page.locator('.entry-card:visible').count();
const snapshot = page => page.evaluate(() => JSON.stringify([...window.__fs.store.entries]));

try {
  for (const mobile of [false, true]) {
    await test(`single-note toggle hides others without writes (${mobile ? 'touch' : 'mouse'})`, async page => {
      const card = meeting(page);
      const before = await snapshot(page);
      const focus = card.getByRole('button', { name: 'Show only this note', exact: true });
      await focus.waitFor({ timeout: 3000 });
      if (mobile) await focus.tap(); else await focus.click();
      assert.equal(await visibleNotes(page), 1);
      assert.equal(await page.getByText('Other private note', { exact: true }).isVisible().catch(() => false), false);
      assert.equal(await snapshot(page), before);
      assert.equal(await card.getByRole('button', { name: 'Show all notes', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor),
        await card.locator('button[title="Copy"]').evaluate(el => getComputedStyle(el).backgroundColor));
      await page.evaluate(() => {
        const store = window.__fs.store;
        store.entries.set('remote-note', { content: 'Incoming private note', owner: 'me@test.dev', shared: false,
          createdAt: window.__fs.now(), sortTime: window.__fs.now() });
        window.__fs.emit();
      });
      assert.equal(await visibleNotes(page), 1);
      await page.keyboard.press('Escape');
      assert.equal(await visibleNotes(page), 1);
      await card.getByRole('button', { name: 'Show all notes', exact: true }).click();
      assert.equal(await visibleNotes(page), 3);
    }, mobile);
  }

  for (const width of [320, 390]) {
    for (const kind of ['new', 'whole', 'block', 'item']) {
      await test(`${kind} mobile editor keeps focus beside Cancel at ${width}px`, async page => {
        const card = page.locator('.entry-card').first();
        if (kind === 'new') await page.click('#toggle-new');
        else if (kind === 'whole') await card.locator('button[title="Edit"]').tap();
        else if (kind === 'block') await card.locator('.entry-content p').first().tap();
        else await card.locator('li').tap({ position: { x: 30, y: 8 } });
        const area = kind === 'new' ? page.locator('#input-area') : card;
        await area.locator('textarea').waitFor({ state: 'visible' });
        const focus = area.getByRole('button', { name: 'Show only this note', exact: true });
        await focus.scrollIntoViewIfNeeded();
        const geometry = await focus.evaluate(el => {
          const r = el.getBoundingClientRect(), next = el.nextElementSibling.getBoundingClientRect();
          const save = el.nextElementSibling.nextElementSibling.getBoundingClientRect();
          const bar = el.closest('.entry-actions'), style = getComputedStyle(bar);
          return { left: r.left, right: r.right, top: r.top, nextTop: next.top, saveTop: save.top,
            saveRight: save.right, barRight: bar.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth), viewport: innerWidth,
            tappable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
        });
        assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport && geometry.tappable, JSON.stringify(geometry));
        assert.equal(geometry.top, geometry.nextTop, 'Focus and Cancel should stay together');
        assert.equal(geometry.top, geometry.saveTop, 'Save should stay beside Cancel');
        assert.equal(geometry.saveRight, geometry.barRight, 'The controls should stay on the right');
        await focus.tap();
        assert.equal(await visibleNotes(page), kind === 'new' ? 0 : 1);
        await area.getByRole('button', { name: 'Show all notes', exact: true }).tap();
        assert.equal(await visibleNotes(page), 2);
      }, width);
    }
  }

  await test('new-note focus retains the draft and selection, and Save stays on the new note', async page => {
    await page.click('#toggle-new');
    const editor = page.locator('#new-entry');
    await editor.fill('New meeting note');
    await editor.evaluate(el => el.setSelectionRange(4, 11));
    await page.locator('#new-actions').getByRole('button', { name: 'Show only this note', exact: true }).click();
    assert.equal(await visibleNotes(page), 0);
    assert.deepEqual(await editor.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd]), [true, 4, 11]);
    assert.equal(await editor.inputValue(), 'New meeting note');
    await page.click('#append-btn');
    await page.getByText('New meeting note', { exact: true }).waitFor();
    assert.equal(await visibleNotes(page), 1);
    await page.click('#toggle-new');
    assert.equal(await editor.isVisible(), true);
    assert.equal(await visibleNotes(page), 0);
    await page.fill('#new-entry', 'Discard this');
    await page.click('#cancel-new');
    assert.equal(await visibleNotes(page), 0);
    await page.keyboard.press('Escape');
    assert.equal(await visibleNotes(page), 0);
    await page.click('#toggle-view');
    assert.equal(await visibleNotes(page), 3);
  });

  for (const kind of ['whole', 'block', 'item']) {
    await test(`${kind} editor keeps its caret and draft when focused, then saves once`, async page => {
      const card = page.locator('.entry-card').first();
      if (kind === 'whole') await card.locator('button[title="Edit"]').click();
      else if (kind === 'block') await card.locator('.entry-content p').first().click();
      else await card.locator('li').click({ position: { x: 30, y: 8 } });
      const editor = card.locator('textarea');
      await editor.fill(kind === 'whole' ? 'Changed title\n\n- Item' : kind === 'block' ? 'Changed title' : 'Changed item');
      await editor.evaluate(el => el.setSelectionRange(3, 3));
      const before = await snapshot(page);
      await card.getByRole('button', { name: 'Show only this note', exact: true }).click();
      assert.equal(await visibleNotes(page), 1);
      assert.deepEqual(await editor.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd]), [true, 3, 3]);
      assert.equal(await snapshot(page), before);
      await page.keyboard.type('!');
      await page.keyboard.press('Control+Enter');
      assert.equal(await visibleNotes(page), 1);
      const saved = await page.evaluate(() => [...window.__fs.store.entries].find(([, e]) => e.content.includes('Cha!nged')));
      assert.ok(saved);
      assert.equal(await page.evaluate(id => window.__fs.store.history.get(id).size, saved[0]), 2);
      await page.locator('.entry-card:visible').getByRole('button', { name: 'Show all notes', exact: true }).click();
      assert.equal(await visibleNotes(page), 2);
    });
  }

  await test('focus preserves search and view filters while a new note stays visible', async page => {
    await page.evaluate(() => {
      const note = [...window.__fs.store.entries.values()].find(e => e.content.includes('Meeting title'));
      note.shared = true; window.__fs.emit();
    });
    await page.click('#toggle-view'); // Shared
    await page.click('#toggle-search');
    await page.fill('#search-input', 'Meeting');
    await page.waitForTimeout(200);
    await meeting(page).getByRole('button', { name: 'Show only this note', exact: true }).click();
    assert.equal(await page.locator('#search-input').isVisible(), false);
    await page.click('#toggle-new');
    await page.fill('#new-entry', 'Different title');
    await page.click('#append-btn');
    await page.getByText('Different title', { exact: true }).waitFor();
    assert.equal(await visibleNotes(page), 1);
    await page.locator('.entry-card:visible').getByRole('button', { name: 'Show all notes', exact: true }).click();
    assert.equal(await page.locator('#toggle-view').textContent(), 'Shared');
    assert.equal(await page.locator('#search-input').inputValue(), 'Meeting');
    assert.equal(await visibleNotes(page), 1);
    assert.equal(await meeting(page).isVisible(), true);
  });
  console.log(`${passed} passed, 0 failed`);
} finally { await browser.close(); }
