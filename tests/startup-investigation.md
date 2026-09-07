# Startup and share investigation — 2026-09-07

## History reviewed

- `cecaab1` (May 19): service-worker shell changed from network-first to cache-first with background refresh. Showing the app was moved ahead of the access check. The share handler remained after that check.
- `39c7ef1` (May 31): replaced forced single-tab Firestore ownership with the multiple-tab manager because competing tabs could stall writes until refresh. Preserve this manager.
- `f530c24` (June 10): preload SDKs; defer Markdown libraries; use one OR query instead of two listeners so shared notes do not arrive in a second wave; reuse cards/search text; render new cards in 40 ms chunks. Preserve cached cards and their editor/history handlers.
- `5bb0d5d` (June 10): permission-denied on the access check must sign out; permanent listener errors must not retry indefinitely. Rendering a local draft does not alter either check.
- `13f8615` (July 5): introduced localStorage notes because Firestore persistence was still Auth-gated; removed the earlier empty-shell-first boot. Share/query navigations must match the service-worker shell by pathname. Shell revalidation bypasses stale HTTP cache so updates do not take many refreshes. Keep the localStorage mirror, pathname matching, and revalidation behavior.
- Card construction inherited an initial Markdown render from `a9dfbdb`; `8393951` switched it to `renderBlocks`. View mode also calls `renderBlocks` immediately after construction. The first DOM subtree is discarded before insertion. Full-edit mode replaces the content element, so it also does not use that first Markdown rendering.

## Benchmark method

`benchmark-startup.mjs` compares the unmodified `24fac1a` page with isolated proposals, using Chromium, a 390×844 mobile viewport, 6× CPU slowdown, and 200 synthetic Markdown notes (no production data).

The pinned Firebase SDKs, marked, and DOMPurify are evaluated as real code. SDK files are downloaded once to `/tmp/one-list-benchmark-vendor` and served locally for reproducible transport. Firebase data operations are replaced by the existing fake; the live listener is held inactive to isolate localStorage hydration and card rendering. This does **not** measure real Firebase initialization, IndexedDB, security rules, or live synchronization latency.

Two conditions:

- Cached-transport approximation: local files with no imposed network latency, localStorage already populated, Auth callback after 1 second. This is not a full service-worker/offline benchmark.
- Share on a slow connection: the same CPU slowdown, 150 ms network latency and 200,000 bytes/second download/upload limits; Auth callback after 1.5 seconds and access check delayed by 2.5 seconds. These are deliberately imposed waits, not measured production Firebase delays.

Each variant runs six times, rotating order. Repetition zero is warmup and excluded from median results. Timings are navigation-relative; visibility is observed in animation frames. First visible note is measured separately from empty-shell visibility. Full-list completion requires all 200 cards. Render time wraps the real `renderEntries`; blocking time sums the portion of observed long tasks above 50 ms over the observation interval. The observation itself adds small, shared overhead.

The isolated startup regression also holds SDK delivery and the access read indefinitely. It fails against the original page (10 assertions fail) and passes against the provisional fix (19 assertions pass).

## First comparison (five measured runs per variant)

Median milliseconds; full raw samples are in `benchmark-startup-results.json`.

| Variant | First cached note | All 200 cached notes | Share visible, cold slow network |
|---|---:|---:|---:|
| Original | 546 | 4,414 | 10,008 |
| Early share + one hydration, original renderer | 492 | 3,895 | 516 |
| Also skip append-only layout measurements, 40 ms | 476 | 3,672 | 518 |
| Also reduce render budget to 12 ms | 528 | 7,594 | 522 |

The 12 ms budget is rejected: it improves blocking time but makes list completion much slower. The empty shell is not counted as a load improvement, and normal startup should retain the previous notes-first behavior. Layout-only results are mixed: under the cold slow-network condition the median full-list time was 10,801 ms versus 10,565 ms originally. This is not evidence of a network improvement.

## Installed-PWA network check

`benchmark-network.mjs` uses real Service Worker and Cache Storage APIs, prewarms and verifies every required cache entry, closes the initial page, and opens a share URL in a new page. It compares a server that delays every response by 5 seconds with fully offline mode. The worker is the repository worker with CDN URLs localized to the local test server and the synthetic Firebase module added to the same caching path. Authentication and the indefinitely stalled access read remain fake. This isolates whether the actual shell/dependency cache policy needs network progress.

Both original and proposed versions render notes without any SDK network fetch on a warm launch. With the server delayed, requests are only the background shell/icon refresh plus the uncached favicon; fully offline there are no server requests. The original never opens the share field during the observation while its access read is stalled. The proposal opens it in 26–40 ms in the measured runs (unthrottled desktop Chromium; **not phone timings**). First-note timings are similar and do not establish an improvement.

With the server delayed, median full-list completion is 441 ms originally and 327 ms for the proposal. Fully offline samples are noisy and do not show a consistent full-list improvement. Raw samples are in `benchmark-network-results.json`.

This supports fixing the share dependency on Auth/access checks. It does not show that the current installed service-worker policy downloads the app on every share, or that it is the cause of the user's regular startup delay. Actual phone cache eviction, cache version, and real Firebase initialization have not been measured.

## Final confirmation and selected changes

Four repetitions per variant, first repetition excluded (three measured runs); rotated
order, same 200-note fixture and throttling. The normal empty shell is suppressed in
both candidates. The last candidate additionally removes the first, discarded Markdown
render. These proposals were generated in the benchmark before applying the final edit.
Raw samples: `benchmark-selected-results.json`.

| Condition | Variant | First note | All notes | Render time | Blocking | Share editor |
|---|---|---:|---:|---:|---:|---:|
| cached-cpu6 | baseline | 537 | 5161 | 3800 | 1782 | — |
| cached-cpu6 | share-only-shell-40ms | 548 | 4693 | 3486 | 1535 | — |
| cached-cpu6 | single-render-40ms | 523 | 3446 | 2391 | 1249 | — |
| share-cpu6-slow-network | baseline | 5940 | 10462 | 3628 | 1747 | 9966 |
| share-cpu6-slow-network | share-only-shell-40ms | 5934 | 10480 | 3632 | 1698 | 516 |
| share-cpu6-slow-network | single-render-40ms | 5929 | 8534 | 2162 | 1073 | 520 |

Selected implementation:

- Read shared text in a small inline script before CDN dependencies. Returning users can
  see/edit the share immediately. Save becomes available when its handler is initialized.
- Consume the draft once when the full composer takes over, preserving any typing during
  SDK loading. Do not wait for Auth or the server access read to expose the composer.
- Read the localStorage mirror only once per page instead of again at the Auth callback.
- Build Markdown once per new card, and omit whole-list geometry reads when only adding
  cards at the end. Preserve reordering animations, card reuse, and the 40 ms chunk budget.
- Preserve notes-first normal startup, the multiple-tab Firestore manager, access checks,
  and the current service-worker cache/update strategy.

Full-list completion improves by about 33% in the cached-transport CPU-throttled test,
while first-note time is effectively unchanged (537 → 523 ms). This is **not** evidence
that the first-note startup delay on the actual phone is solved. The warm installed-PWA
check establishes that a populated cache can display notes without network progress;
it cannot establish the cache state on that phone.

To repeat the confirmation:

```bash
BENCH_VARIANTS=baseline,share-only-shell-40ms,single-render-40ms BENCH_RUNS=4 BENCH_OUTPUT=tests/benchmark-selected-results.json CHROME=/path/to/chrome node tests/benchmark-startup.mjs
```

## Validation

After applying the selected implementation, `./tests/run.sh` passes all 123 assertions
across eight suites: startup, fork, sync, solo, block, acks, propagate, and e2e.
The new startup regression was also run against the original page and fails as expected.
`git diff --check` passes. No deployment or security-rule changes were made.

## Cross-device risk review

The version-history/fork-protection region, live listener/snapshot merge region, and
create/rescue/delete write region are byte-for-byte unchanged from HEAD. The multi-tab
Firestore configuration and security rules are unchanged. `renderBlocks` wires DOM and
user-event handlers; its removed initial call does not enqueue writes. The sole
`buildCard` caller always enters view/edit mode, which respectively renders or replaces
the content element. Existing in-progress-edit preservation in `renderEntries` is intact.

The localStorage mirror remains a display bootstrap, not a source of automatic writes.
The share change populates only the local composer; Save uses the existing write path.
This review found no new cross-device data-loss path, but it is not a proof of zero risk:
the existing fake-SDK suites do not validate real offline write replay, security rules,
or all Firestore snapshot orderings. No real two-device offline/reconnect exercise was
performed. Unsaved composer text is still not a durably saved note.
