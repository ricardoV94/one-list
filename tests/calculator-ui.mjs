import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const fake = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ok   ' + name); }
async function add(content) {
  if (!await page.locator('#new-entry').isVisible()) await page.click('#toggle-new');
  await page.fill('#new-entry', content);
  await page.click('#append-btn');
}
try {
  await page.goto('http://localhost:8899/index.html');
  await page.waitForFunction(() => document.getElementById('app')?.style.display === 'block');
  await test('Markdown references and multiline code spans remain intact', async () => {
    const result = await page.evaluate(() => {
      const render = window.__noteMarkup.cleanHtml;
      const source = '#{1 + 2}\n\n[Example][ref]\n\n[ref]: https://example.com';
      const code = '`example\n#{hidden = 5}\n`\n#{hidden}';
      return { rendered: render(source), code: render(code) };
    });
    assert.match(result.rendered, /href="https:\/\/example.com"/);
    assert.match(result.rendered, /3.00/);
    assert.match(result.code, /Unknown quantity: hidden/);
    assert.match(result.code, /<code>example #\{hidden = 5\}\s*<\/code>/);
  });
  const source = 'Revenue: #{revenue = 25.00}\nCost: #{cost = 17.50}\n\nProfit: #{revenue - cost}\nReturn: #{(revenue - cost) / revenue * 100}';
  await add(source);
  const card = page.locator('.entry-card').first();
  await test('definitions cross paragraph boundaries', async () => {
    await card.locator('p').nth(1).waitFor();
    const text = await card.locator('.entry-content').textContent();
    for (const expected of ['Revenue: 25.00', 'Cost: 17.50', 'Profit: 7.50', 'Return: 30.00']) assert.ok(text.includes(expected));
  });
  await test('editing retains source and recomputes dependent results', async () => {
    await card.locator('p').first().click();
    const editor = card.locator('textarea');
    await editor.waitFor();
    assert.equal(await editor.inputValue(), 'Revenue: #{revenue = 25.00}\nCost: #{cost = 17.50}');
    await editor.fill('Revenue: #{revenue = 35.00}\nCost: #{cost = 17.50}');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('#entries-list .entry-card')?.textContent.includes('Return: 50.00'));
    assert.ok((await card.locator('.entry-content').textContent()).includes('Profit: 17.50'));
    const saved = await page.evaluate(() => [...window.__fs.store.entries.values()][0].content);
    assert.equal(saved, source.replace('25.00', '35.00'));
  });
  await test('old dollar syntax stays literal; names are local; errors recover', async () => {
    await add('$old = 9\n$= 2 + 2\n\n#{old}\n#{revenue}\n#{x = 2}\n#{x = 1 / 0}\n#{x}\n#{2 + 3}');
    const latest = page.locator('.entry-card').first();
    await latest.locator('.calculator-error').nth(3).waitFor();
    assert.equal(await latest.locator('.calculator-error').count(), 4);
    const text = await latest.locator('.entry-content').textContent();
    for (const expected of ['$old = 9', '$= 2 + 2', 'Unknown quantity: old', '2.00', '5.00']) assert.ok(text.includes(expected));
  });
  await test('inline quantities render inside bold text and editable checkbox rows', async () => {
    const source = '**Income: #{total_income = 9.30}k (EUR)**\n\n- [ ] Amount: #{total_income * 0.75}k (EUR)\n- [ ] Rate: #{8.00}%';
    await add(source);
    const latest = page.locator('.entry-card').first();
    await latest.locator('strong').waitFor();
    assert.equal(await latest.locator('strong').textContent(), 'Income: 9.30k (EUR)');
    assert.ok((await latest.locator('li').first().textContent()).includes('Amount: 6.98k (EUR)'));
    assert.ok((await latest.locator('li').nth(1).textContent()).includes('Rate: 8.00%'));
    assert.equal(await latest.locator('.calculator-error').count(), 0);
    await latest.locator('li .todo-text').first().click();
    const editor = latest.locator('textarea');
    await editor.waitFor();
    assert.equal(await editor.inputValue(), 'Amount: #{total_income * 0.75}k (EUR)');
    await editor.fill('Amount: #{total_income * 0.50}k (EUR)');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.querySelector('#entries-list .entry-card')?.textContent.includes('Amount: 4.65k (EUR)'));
    await latest.locator('input[type="checkbox"]').first().check();
    const saved = await page.evaluate(() => [...window.__fs.store.entries.values()].find(e => e.content.includes('total_income'))?.content);
    assert.equal(saved, source.replace('0.75', '0.50').replace('- [ ] Amount', '- [x] Amount'));
  });
  await test('calculations follow source order; code and URLs remain literal', async () => {
    const source = 'First: #{inline_value = 2}\nMiddle: #{middle = inline_value + 3}\nLast: #{middle * 2}\n\n#{a = 3} + #{b = a + 1} = #{a + b}\n\n`#{hidden = 5}`\n\n```text\n#{fenced = 8}\n```\n\n[Link](https://example.com/\"#{url_value=5}\")\n\n#{hidden} #{fenced} #{url_value} #{total_income}';
    await add(source);
    const latest = page.locator('.entry-card').first();
    await latest.locator('.calculator-error').nth(3).waitFor();
    const text = await latest.locator('.entry-content').textContent();
    assert.ok(text.includes('First: 2.00'));
    assert.ok(text.includes('Middle: 5.00'));
    assert.ok(text.includes('Last: 10.00'));
    assert.ok(text.includes('3.00 + 4.00 = 7.00'));
    assert.equal(await latest.locator('.calculator-error').count(), 4);
    assert.equal(await latest.locator('pre code').textContent(), '#{fenced = 8}\n');
    assert.equal(await latest.locator('a').count(), 1);
  });
  assert.deepEqual(errors, []);
  console.log(`${passed} passed, 0 failed`);
} finally {
  await browser.close();
}
