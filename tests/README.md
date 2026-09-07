# tests

Not deployed (`tests/**` is in `firebase.json`'s hosting `ignore`), but **committed** — these
suites encode real bugs that reached production, several of them replaying the exact console
logs from the reports.

```bash
./tests/run.sh              # everything
./tests/run.sh fork e2e     # named suites
```

Needs `node`, `python3` (serves the repo on :8899), and Playwright with a Chromium:

```bash
npm install --prefix tests playwright     # deps are gitignored
CHROME=$(which chromium) ./tests/run.sh   # or point at any Chromium binary
```

## What's here

| Suite | Drives | Covers |
|---|---|---|
| `fork` | the real `checkForkAlerts` / `orphanVersionIds` / `markSeen`, sliced out of `index.html` | the stale-clobber race, every false-positive bug we shipped, the monotonic-`held` invariant, the three-valued walk |
| `preview` | real page with Firebase imports held | sanitized formatted cache preview, hidden-note filtering, single cache read, safe handover, touch/keyboard feedback for blocked actions, queued edit/save feedback |
| `background` | real page plus real session functions | repeated background/resume, paragraph/item/new-paragraph saves, history survives stale overwrite, offline checkpoint lineage |
| `startup` | real page, delayed SDK and stalled access check | share editor opens before network waits, preserves typing, consumes share once, reads boot cache once |
| `sync` | real page | clean sequential A→B sync raises no alert; coalesced remote chains aren't forks; genuine forks still fire |
| `solo` | real page | one device, consecutive edits — the lineage must stay one unbroken chain |
| `block` | real page | block-editor sessions commit exactly one version at teardown (coalesced, not per keystroke) |
| `acks` | real page | resolving an orphan on one device clears the edge on another |
| `propagate` | real page | a device that never *witnessed* a fork still shows it, straight from the note doc |
| `e2e` | real page | create → edit → stale clobber → history viewer → rescue, end to end |

`harness.mjs` slices the real functions out of `index.html` and binds their dependencies —
one place to update when the app's internals move. `fake-firestore.js` is an in-memory stand-in
for the Firebase SDK, route-stubbed into the page (`page.route('**/firebasejs/**')`), so the
browser suites drive the *actual* `index.html`.

## What these tests do NOT cover

Read this before trusting a green run. **Every bug in the history feature came from one of
these three gaps**, and the suite is structurally blind to all of them:

- **Security rules.** The fake has no rules engine. Two rules bugs reached production this way:
  a batched create denied because the history rule `get()`s a parent note that didn't exist yet
  (notes silently vanished), and version docs stranded forever because they were deleted after
  their parent. Closing this needs `@firebase/rules-unit-testing` against the emulator.
- **Snapshot ordering.** The fake emits one snapshot per write, in order. Firestore does not
  promise that. Stale and coalesced snapshots caused most of the false-positive red edges.
- **The offline write queue.** The fake resolves writes synchronously, which hid a version being
  silently dropped at block-session teardown until unrelated timing shifted.

A green suite is necessary, not sufficient. The target scenario — one device offline, both
editing the same note — can only be verified by hand.

## Working on this

When you fix a bug here, **check the test against the pre-fix code** and confirm it fails.
Several bugs in this feature were masked by tests that passed for the wrong reason, and one
"fix" was silently never applied because a patch aborted and nobody looked.

## Startup benchmarks

See [startup-investigation.md](startup-investigation.md) for prior fixes, measurements,
and limitations. These use synthetic notes and never access production data.

```bash
CHROME=/path/to/chrome node tests/benchmark-startup.mjs
CHROME=/path/to/chrome node tests/benchmark-network.mjs
CHROME=/path/to/chrome node tests/benchmark-preview.mjs
```

The first benchmark downloads the app's pinned public SDK/Markdown scripts to `/tmp`
once; the network benchmark uses those files. The first compares original and selected
UI code under CPU/network throttling. The second verifies the actual service-worker
cache path with a stalled server and fully offline. Both write JSON measurements under
`tests/`. They are separate from `run.sh`, since benchmarks take longer and have no
machine-independent speed threshold. The preview benchmark compares the deployed
`609ef3d` page with the isolated pre-Firebase cache-preview proposal, generated before
application changes; its raw measurements exclude the later loading-feedback UI.
None substitutes for a trace from the Android
phone or real Firebase/IndexedDB testing.
