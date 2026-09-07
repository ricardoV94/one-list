// Requires benchmark-startup.mjs to have downloaded the pinned vendor scripts.
// Real service worker and Cache Storage, synthetic notes and Firebase operations.
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const baseline = execFileSync('git', ['show', '24fac1a:index.html'], { encoding: 'utf8' });
const proposed = (process.env.BENCH_CANDIDATE
  ? fs.readFileSync(process.env.BENCH_CANDIDATE, 'utf8')
  : execFileSync('git', ['show', '609ef3d:index.html'], { encoding: 'utf8' }))
  .replace('chunkStart > 12', 'chunkStart > 40')
  .replace("if (localStorage.getItem('wasSignedIn')) {", "if (parts.length && localStorage.getItem('wasSignedIn')) {")
  .replace("      contentEl.className = 'entry-content';\n      renderBlocks(contentEl, entry);", "      contentEl.className = 'entry-content';");
const variants = { baseline, proposed };
const localize = text => text
  .replaceAll(/https:\/\/www\.gstatic\.com\/firebasejs\/12\.11\.0\//g, '/vendor/')
  .replaceAll('https://cdn.jsdelivr.net/npm/dompurify@3.2.5/dist/', '/vendor/')
  .replaceAll('https://cdn.jsdelivr.net/npm/marked@15.0.7/', '/vendor/');
const fake = fs.readFileSync('tests/fake-firestore.js', 'utf8')
  .replace("setTimeout(() => cb({ email: 'me@test.dev' }), 0)", "setTimeout(() => cb({ email: 'me@test.dev' }), window.__authDelay || 0)")
  .replace('export async function getDoc(ref) {', "export async function getDoc(ref) { if (window.__stallAccess && ref.path[0] === 'config') await new Promise(() => {});")
  .replace('export function onSnapshot(', 'export function unusedOnSnapshot(')
  + '\nexport function onSnapshot() { return () => {}; }';
// Only adapt origins for local transport and add the fake module to the same
// CDN caching path. Shell/query matching and caching behavior remain unchanged.
const worker = localize(fs.readFileSync('sw.js', 'utf8'))
  .replace("const CDN_FILES = [", "const CDN_FILES = ['/fake.js',")
  .replace("e.request.url.includes('gstatic.com/firebasejs')", "(e.request.url.includes('/vendor/') || e.request.url.endsWith('/fake.js'))");
let currentHtml, delay = 0;
let requests = [];
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  requests.push(path);
  const requestDelay = delay;
  if (requestDelay) await new Promise(r => setTimeout(r, requestDelay));
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/' || path === '/index.html') { res.setHeader('Content-Type', 'text/html'); res.end(currentHtml); }
  else if (path === '/sw.js' || path === '/fake.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(path === '/sw.js' ? worker : fake); }
  else if (path.startsWith('/vendor/')) { res.setHeader('Content-Type', 'application/javascript'); res.end(localize(fs.readFileSync('/tmp/one-list-benchmark-vendor/' + path.split('/').pop(), 'utf8'))); }
  else if (['/icon-192.png', '/icon-512.png', '/favicon.png', '/manifest.json'].includes(path)) { res.setHeader('Content-Type', path.endsWith('.png') ? 'image/png' : 'application/manifest+json'); res.end(fs.readFileSync('.' + path)); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const notes = Array.from({ length: 200 }, (_, i) => ({ id: 'cached-' + i, owner: 'me@test.dev', shared: false, content: `## Cached note ${i}\n\nA paragraph with **bold** text and a [link](https://example.com).\n\n- [ ] Task one\n- [x] Task two\n\n` + 'Text to wrap on a narrow phone screen. '.repeat(12), createdAt: 1788732000000 - i * 60000, sortTime: 1788732000000 - i * 60000 }));
const results = [];
try {
  for (let repeat = 0; repeat < 4; repeat++) for (const name of (repeat % 2 ? ['proposed', 'baseline'] : ['baseline', 'proposed'])) {
    currentHtml = localize(variants[name].replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, "from '/fake.js'")
      .replace('<script type="module">', '<script type="module">\nimport "/vendor/firebase-app.js"; import "/vendor/firebase-auth.js"; import "/vendor/firebase-firestore.js";'));
    delay = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(notes => {
      localStorage.setItem('wasSignedIn', 'me@test.dev');
      localStorage.setItem('notesCache', JSON.stringify(notes));
      window.__authDelay = 700;
      window.__stallAccess = true;
      const b = window.__bench = {};
      const check = () => {
        const app = document.getElementById('app');
        if (app && getComputedStyle(app).display !== 'none') {
          if (document.querySelector('.entry-card')) b.firstNote ??= performance.now();
          if (document.querySelectorAll('.entry-card').length === notes.length) b.allNotes ??= performance.now();
          const ta = document.getElementById('new-entry');
          if (ta.value && getComputedStyle(document.getElementById('input-area')).display !== 'none') b.share ??= performance.now();
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }, notes);
    const warmup = await context.newPage();
    await warmup.goto(origin);
    await warmup.evaluate(() => navigator.serviceWorker.ready);
    const keys = await warmup.evaluate(async () => (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname)))).flat());
    if (!['/', '/vendor/firebase-app.js', '/vendor/firebase-auth.js', '/vendor/firebase-firestore.js', '/vendor/marked.min.js', '/vendor/purify.min.js', '/fake.js'].every(k => keys.includes(k))) throw new Error('Incomplete installed cache: ' + keys);
    await warmup.close();
    for (const mode of ['stalled-network', 'offline']) {
      delay = mode === 'stalled-network' ? 5000 : 0;
      await context.setOffline(mode === 'offline');
      requests = [];
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/?text=Shared+while+network+is+unavailable', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__bench.allNotes, null, { timeout: 15000 });
      await page.waitForTimeout(1100);
      const result = { variant: name, mode, repeat, ...await page.evaluate(() => window.__bench), requests: [...requests], errors };
      results.push(result);
      console.log(JSON.stringify(result));
      if (errors.length) throw new Error(errors.join('\n'));
      if (requests.some(path => path.startsWith('/vendor/') || path === '/fake.js')) throw new Error('Warm startup fetched a cached dependency');
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  fs.writeFileSync('tests/benchmark-network-results.json', JSON.stringify({ date: new Date().toISOString(), notes: notes.length, results }, null, 2));
}
