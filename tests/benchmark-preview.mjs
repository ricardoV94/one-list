// Isolate displaying the cached first screen before Firebase script evaluation.
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { cachedPreviewCandidate } from './cached-preview-proposal.mjs';
const baseline = execFileSync('git', ['show', '609ef3d:index.html'], { encoding: 'utf8' });
const variants = { baseline, preview: cachedPreviewCandidate(baseline) };
const fake = fs.readFileSync('tests/fake-firestore.js', 'utf8')
  .replace("setTimeout(() => cb({ email: 'me@test.dev' }), 0)", "setTimeout(() => cb({ email: 'me@test.dev' }), window.__scenario.authDelay)")
  .replace('export async function getDoc(ref) {', "export async function getDoc(ref) { if (ref.path[0] === 'config') await new Promise(r => setTimeout(r, window.__scenario.accessDelay));")
  .replace('export function onSnapshot(', 'export function unusedOnSnapshot(')
  + '\nexport function onSnapshot() { return () => {}; }';
const cacheDir = '/tmp/one-list-benchmark-vendor';
fs.mkdirSync(cacheDir, { recursive: true });
const vendors = new Map();
async function vendor(url) {
  if (vendors.has(url)) return;
  const key = '/vendor/' + new URL(url).pathname.split('/').pop();
  const path = cacheDir + '/' + key.split('/').pop();
  let text;
  if (fs.existsSync(path)) text = fs.readFileSync(path, 'utf8');
  else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    text = await response.text();
    fs.writeFileSync(path, text);
  }
  vendors.set(url, { key, text });
  for (const match of text.matchAll(/https:\/\/www\.gstatic\.com\/firebasejs\/[^"'\s]+\.js/g)) await vendor(match[0]);
}
for (const url of baseline.matchAll(/(?:src|href)="(https:\/\/[^" ]+\.js)"/g)) await vendor(url[1]);
function localize(text) {
  for (const [url, { key }] of vendors) text = text.replaceAll(url, key);
  return text;
}
const pages = new Map();
for (const [name, source] of Object.entries(variants)) {
  let html = source.replace(/from 'https:\/\/www.gstatic.com\/firebasejs\/[^']+'/g, "from '/fake.js'");
  // Preserve real SDK parse/evaluation costs even though data operations are fake.
  html = html.replace('<script type="module">', `<script type="module">\n${[...vendors].filter(([url]) => url.includes('firebasejs')).map(([, { key }]) => `import '${key}';`).join('\n')}`);
  html = html.replace('    function renderEntries() {', `    function renderEntries() {
      const start = performance.now();
      try { return benchRenderEntries(); }
      finally { window.__bench.renders.push(performance.now() - start); }
    }
    function benchRenderEntries() {`);
  pages.set('/' + name, localize(html));
}
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pages.has(path)) { res.setHeader('Content-Type', 'text/html'); res.end(pages.get(path)); }
  else if (path === '/fake.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fake); }
  else if (path.startsWith('/vendor/')) {
    const v = [...vendors.values()].find(v => v.key === path);
    res.setHeader('Content-Type', 'application/javascript');
    res.end(localize(v.text));
  } else { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const notes = Array.from({ length: 200 }, (_, i) => ({
  id: 'bench-' + i, owner: 'me@test.dev', shared: i % 4 === 0,
  content: `## Note ${i}\n\nA realistic paragraph with **bold text**, a [link](https://example.com), and some ordinary words to wrap on a narrow screen.\n\n- [ ] First task\n- [x] Completed task\n- [ ] Another task\n\n` + 'More text for review and editing. '.repeat(12),
  sortTime: 1788732000000 - i * 60000, createdAt: 1788732000000 - i * 60000,
}));
const scenarios = [
  { name: 'cached-cpu6', cpu: 6, latency: 0, throughput: -1, authDelay: 1000, accessDelay: 0, share: false },
  { name: 'share-cpu6-slow-network', cpu: 6, latency: 150, throughput: 200000, authDelay: 1500, accessDelay: 2500, share: true },
];
const results = [];
try {
  for (const scenario of scenarios) {
    // Rotate variant order each repetition to reduce order/thermal bias. The first
    // repetition warms Chromium and is recorded but excluded from medians.
    for (let repeat = 0; repeat < Number(process.env.BENCH_RUNS || 4); repeat++) {
      const names = Object.keys(variants);
      for (const name of names.slice(repeat % names.length).concat(names.slice(0, repeat % names.length))) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpu });
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: scenario.latency, downloadThroughput: scenario.throughput, uploadThroughput: scenario.throughput });
        await page.addInitScript(({ scenario, notes }) => {
          window.__scenario = scenario;
          localStorage.setItem('wasSignedIn', 'me@test.dev');
          localStorage.setItem('notesCache', JSON.stringify(notes));
          const b = window.__bench = { renders: [], longtasks: [], cacheReads: 0 };
          const get = Storage.prototype.getItem;
          Storage.prototype.getItem = function(k) { if (k === 'notesCache') b.cacheReads++; return get.call(this, k); };
          new PerformanceObserver(list => { for (const e of list.getEntries()) b.longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
          const check = () => {
            const now = performance.now();
            const app = document.getElementById('app');
            if (app && getComputedStyle(app).display !== 'none') {
              b.shell ??= now;
              if (document.querySelector('.entry-card')) b.firstNote ??= now;
              if (document.querySelectorAll('#entries-list .entry-card').length === notes.length) b.allNotes ??= now;
              const editor = document.getElementById('new-entry');
              if (editor.value && getComputedStyle(document.getElementById('input-area')).display !== 'none') b.shareEditor ??= now;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }, { scenario, notes });
        await page.goto(origin + '/' + name + (scenario.share ? '?text=Benchmark+shared+message' : ''), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(share => window.__bench.allNotes && (!share || window.__bench.shareEditor), scenario.share, { timeout: 60000 });
        await page.waitForTimeout(scenario.share ? 100 : 1200);
        const b = await page.evaluate(() => window.__bench);
        if (errors.length) throw new Error(errors.join('\n'));
        const result = { scenario: scenario.name, variant: name, repeat, ...b,
          renderTotal: b.renders.reduce((s, n) => s + n, 0), maxRender: Math.max(...b.renders),
          blocking: b.longtasks.reduce((s, e) => s + Math.max(0, e.duration - 50), 0) };
        results.push(result);
        console.log(JSON.stringify({ scenario: result.scenario, variant: name, repeat, firstNote: Math.round(b.firstNote), allNotes: Math.round(b.allNotes), share: Math.round(b.shareEditor || 0), renderTotal: Math.round(result.renderTotal), blocking: Math.round(result.blocking) }));
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
  fs.writeFileSync(process.env.BENCH_OUTPUT || 'tests/benchmark-preview-results.json', JSON.stringify({ date: new Date().toISOString(), baseline: '609ef3d', scenarios, notes: notes.length, notesBytes: JSON.stringify(notes).length, results }, null, 2));
}
