import { chromium } from 'playwright';
import fs from 'node:fs';

const source = fs.readFileSync(process.env.STARTUP_HTML || 'index.html', 'utf8');
const fake = fs.readFileSync(new URL('./fake-firestore.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let pass = 0, fail = 0;
const ok = (name, value) => {
  console.log(`  ${value ? 'ok' : 'FAIL'} ${name}`);
  value ? pass++ : fail++;
};
try {
  for (const remembered of [true, false]) {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(remembered => {
      if (remembered) localStorage.setItem('wasSignedIn', 'me@test.dev');
      const get = Storage.prototype.getItem;
      window.__cacheReads = 0;
      Storage.prototype.getItem = function(key) {
        if (key === 'notesCache') window.__cacheReads++;
        return get.call(this, key);
      };
    }, remembered);
    await page.route('http://localhost:8899/**', route => route.fulfill({ contentType: 'text/html', body: source }));
    let release;
    const sdkGate = new Promise(resolve => { release = resolve; });
    await page.route('**/firebasejs/**', async route => {
      await sdkGate;
      await route.fulfill({ contentType: 'application/javascript', body: fake
        .replace("setTimeout(() => cb({ email: 'me@test.dev' }), 0)", "setTimeout(() => cb({ email: 'me@test.dev' }), 250)")
        .replace('export async function getDoc(ref) {', "export async function getDoc(ref) { if (ref.path[0] === 'config') await new Promise(() => {});") });
    });
    const shared = 'Shared title\n\nHello from sharing\n\nhttps://example.com/';
    await page.goto('http://localhost:8899/index.html?title=Shared+title&text=Share+via+Hello+from+sharing&url=https%3A%2F%2Fexample.com%2F&keep=1#top', { waitUntil: 'commit' });
    await page.waitForSelector('#new-entry', { state: 'attached' });
    if (remembered) {
      // Check while the Firebase imports are deliberately held, rather than use
      // a timing threshold that varies with test-machine speed.
      await page.waitForTimeout(100);
      ok('share editor visible before SDK loads', await page.locator('#new-entry').isVisible());
      ok('shared payload populated before SDK loads', await page.locator('#new-entry').inputValue() === shared);
      ok('save disabled until its handler is ready', await page.locator('#append-btn').isDisabled());
      if (await page.locator('#new-entry').isVisible()) await page.fill('#new-entry', shared + '\nTyped while loading');
    }
    release();
    await page.waitForFunction(() => !!window.__fs, null, { timeout: 15000 });
    await page.waitForTimeout(700);
    ok('share editor visible with allowlist read still pending', await page.locator('#new-entry').isVisible());
    ok('draft survives initialization', await page.locator('#new-entry').inputValue() === shared + (remembered ? '\nTyped while loading' : ''));
    ok('only share parameters consumed', page.url() === 'http://localhost:8899/index.html?keep=1#top');
    ok('boot cache read only once', await page.evaluate(() => window.__cacheReads === 1));
    // Once dismissed, later auth/startup work must not reopen a consumed share.
    if (await page.locator('#new-entry').isVisible()) {
      await page.click('#append-btn');
      ok('shared draft can be saved', await page.evaluate(() => [...window.__fs.store.entries.values()].some(n => n.content.startsWith('Shared title'))));
      ok('save closes composer', !await page.locator('#new-entry').isVisible());
      await page.click('#toggle-new');
      ok('new-entry toggle opens exactly once', await page.locator('#new-entry').isVisible());
    }
    ok('no JavaScript errors', errors.length === 0);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
