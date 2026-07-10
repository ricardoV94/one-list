# one_list — history robustness spec (distinct-docs design)

## Problem

Notes sync via Firestore with offline persistence. A note's `content` is written
whole-string via unconditional `updateDoc` (last-write-wins, no version guard). A
stale/offline device that reconnects replays its queued write and can **overwrite a
newer edit from another device**. The `editHistory` safety net does *not* catch the
clobbered version, so content is lost irrecoverably.

Reproduced with the real `applyEntryContent` (node harness): device B adds a line,
device A (stale, shielded from B's snapshot) overwrites `content`; B's version ends up
**neither current nor in history**. Root causes:

1. **Wrong thing archived.** History archives the *pre-edit* baseline
   (`applyEntryContent` `index.html:1135`; `saveEdit` `4233`), never the committed
   *result*, so the clobbered device's actual content is never durably stored.
2. **`arrayUnion` dedup erasure.** Inline entries `{content, editedAt}` collapse when two
   devices archive the same baseline → the "part but not the whole" symptom.
3. Plus secondary bugs: mid-edit snapshot blackout (`activeEdits`, `4326`) keeps the
   editing device stale; history-management writes (bump `3889-3900`, delete `3934`,
   clear `3943`) rewrite the whole array from a stale snapshot; reorder/checkbox paths
   write content with no history at all.

## The guarantee we want

> No committed version of a note is ever *accidentally* unrecoverable due to a sync race
> — until the user chooses to clear history.

Live `content` stays last-write-wins (we do **not** merge concurrent edits). The visible
current text may lose a race; the losing version is always recoverable from history, and
the user is nudged that it happened (red dot).

## Why this design (and not the alternatives)

- **Reactive rescue** (archive a clobbered version when a client witnesses the overwrite)
  was rejected: it needs a *witness* online at the moment the stale write lands. In the
  target scenario (laptop offline, phone closed) there is none. Only the **authoring
  device archiving its own committed result** guarantees recovery witness-free.
- **Inline array of results** works but: bloats the note doc toward the 1 MiB limit,
  orders only by skew-prone client `editedAt` (Firestore forbids `serverTimestamp()`
  inside an array element), and keeps the delete/clear read-modify-write races.
- **Distinct linked docs** (this design): each version is its own immutable doc with a
  real `serverTimestamp`. Authoritative ordering, no doc bloat, deletes/clear become
  single-doc ops (management races vanish), no dedup fragility, history moves *off* the
  hot path (lazy-loaded). This is money_app's proven model applied to history — but it is
  **not** the forever-ledger: deletes are allowed and "current" is still the plain
  `content` field, not a read-time projection.

## Non-goals

No append-only-forever, no create-only rules, no read-time head resolution for "current",
no concurrent-edit merging. History stays **bounded and user-clearable**.

---

## Data model

**Note doc** `entries/{id}` — unchanged except three small fields:
```js
{
  content,                 // authoritative CURRENT text (LWW), unchanged role
  images,                  // id → data map, unchanged
  contentVersion,          // id of the history doc representing current content
  contentBase,             // the contentVersion this current text was derived from (parent) — for fork detection
  // …existing: createdAt, sortTime, owner, shared, hiddenFor…
}
```
`editHistory` (the inline array) is **retired for new writes** but still *read* for
legacy notes during migration.

**History subcollection** `entries/{id}/history/{versionId}` — one immutable doc/version:
```js
{
  content,                 // the committed RESULT content of one editing session
  createdAt: serverTimestamp(),   // authoritative order (the referee the array lacked)
  editedAt,                // client ISO, display fallback until serverTimestamp resolves
  device,                  // deviceId, for attribution/debug
  base,                    // parent versionId this edit derived from (null for the seed)
}
```
Versions are never updated, only created and (on clear/delete/prune) deleted.

## Commit path

One editing session → one version doc. On **session teardown** (block/line editor) or
**`saveEdit`** (full editor), if `entry.content` changed:

```js
const versionId = <client-generated id>;            // doc(historyRef).id
const batch = writeBatch(db);                        // batch: queues offline, replays atomically
batch.set(doc(historyRef, versionId), {
  content: entry.content, createdAt: serverTimestamp(),
  editedAt: new Date().toISOString(), device: deviceId,
  base: session.baseVersionId ?? null,
});
batch.update(doc(db,'entries',entry.id), {
  content: entry.content,
  contentVersion: versionId,
  contentBase: session.baseVersionId ?? null,
});
await batch.commit();
```

- `writeBatch` (not `runTransaction`) — batches work offline and replay as a unit, so the
  note field and its version doc never split. (Transactions need a server round-trip and
  are unusable for the offline case; batches are fine.)
- **Block sessions**: archive once, at teardown, centralized in a new
  `endBlockSession(entry)` replacing the 7 `blockSessions.delete` sites (1549, 1559, 1654,
  1772, 1782, 1816, 2030). Fire on `beforeunload`/`visibilitychange:hidden` too so a
  killed tab still archives.
- `sessionFor` records `baseVersionId = note.contentVersion at session start` (and
  `startContent` to detect no-op sessions).
- **Result, not pre-edit**: the version doc holds the committed content. A stale replay's
  own result is thus always a version doc → clobber-proof, no witness needed.
- **Seed the original**: on note **create** (`addDoc`, `~4457`), also create a version doc
  for the initial content so "restore to original" survives. Legacy notes: their first
  new commit uses `base:null` and the migration read (below) surfaces their inline
  originals.
- Reorder/checkbox paths that change text also archive; pure moves still don't.

## Image garbage collection — lazy recompute (no per-commit cross-doc reads)

Images live once in the note doc's `images` map; versions reference them by `img:id`.
With history in a subcollection the commit writer can't cheaply see every version's refs,
so **do not GC on commit** — only add newly-pasted images; never drop on a normal save.

Reclaim lazily, at the two moments history is already loaded in the viewer:
- **Delete-version / clear**: after removing version docs, recompute the union of `img:`
  refs across `entry.content` + the *remaining* version docs **+ any remaining legacy
  inline `editHistory` entries**, and drop any `images[id]` not in that set (owner only).
  (Legacy entries must be included or clearing could drop an image an old inline version
  still needs.)
- **Restore/bump** does no GC — all images stay, so a restored legacy version's images
  resolve.
- Optional: same recompute opportunistically when the owner opens a note's history.

Tradeoff: an image removed from current text but referenced by no version lingers until
the next clear/delete recompute (mild note-doc bloat) — but a version's image is **never**
wrongly deleted. Safe-over-tight, which matches "less critical".

## Clearable (no automatic cap)

- **No soft cap / auto-prune.** History is out of the note doc, so there is no 1 MiB
  pressure that would justify silently deleting the user's old versions. Automatic
  deletion is itself a form of the data loss we're preventing — so we don't do it.
- **Clear history** (user-initiated, the only deletion): delete all versions in the
  subcollection (queued `deleteDoc`s / a batch), then image recompute and clear
  `contentVersion`/`contentBase` lineage as needed.
- If a note ever accumulates a very large number of versions, limit at **display time**
  (page / load most-recent-N in the viewer) — never by deleting docs.

## Fork detection → red dot

- On each content-changing snapshot, compare incoming `contentBase` against the
  `contentVersion` this client last held for that note. If a new current arrived whose
  `base` is **not** the version we considered current → a stale-based (out-of-order)
  write landed → mark the note.
- No history load needed — both fields are on the note doc (hot path).
- Store the alert in `localStorage` (`oneListHistoryAlerts`: set of note ids), per device;
  seed silently on a fresh device so pre-existing forks don't all light at once (mirrors
  money_app `checkForkAlerts`, `money_app/index.html:1609-1649`).
- **UI**: small dot badge on the note's history button when flagged; reuse an existing
  accent/alert color + badge style — no new red. Clear on opening that note's history.

## History viewer

- **Lazy-load**: query `entries/{id}/history` ordered by `createdAt` only when the user
  opens the viewer (or attach an `onSnapshot` scoped to the open card). Main list never
  loads history → hot path unchanged.
- **Versions list** = the ordered version docs; current = the doc whose id ===
  `contentVersion` (default selection). No separate append of `entry.content` (it already
  equals its version doc). Bump = write a new version whose content is the chosen old one
  (becomes current); delete-version = `deleteDoc`; clear = delete all. All lose the stale
  whole-array rewrite → the three management races are gone by construction.
- **Legacy/migration read**: also read the note's inline `editHistory` (pre-edit
  snapshots) and merge into the displayed list, time-ordered with the new docs. A small
  normalizer maps both to one display shape; legacy entries get a synthesized id and
  `base:null` (never a false fork alert). Both are "past versions" for display/restore.

## Rules (`firestore.rules`)

Add the history subcollection: `read`, `create`, `delete` for whoever can access the
parent note (owner/shared/allowlist); **no `update`** (versions immutable). Deletes are
allowed on purpose (clear/prune) — this is not the create-only ledger.

## Mid-edit blackout (secondary, optional)

When a remote snapshot changes a note with an active session: if the user hasn't modified
the session yet, adopt the remote content and rebase (`startContent`/`baseVersionId`); if
they have, keep their copy but set the fork flag. Reduces how often a clobber happens
online. Best-effort; the version docs already guarantee recoverability.

## Rollout / verification (needs a manual pass — not headless-verifiable)

1. Node harness: extend the existing race test to the batch commit + version docs; assert
   B's result survives A's stale clobber as a version doc. (Logic only.)
2. **Two-device manual**: edit same note on two tabs, one offline; confirm current is LWW,
   the overwritten version appears in history, red dot lights, clears on open.
3. **Image manual**: paste image, edit, restore an older image-bearing version → image
   still resolves; clear history → unreferenced images reclaimed, referenced kept.
4. Confirm delete-version removes one, clear empties, legacy notes still show old inline
   versions.
5. Deploy: `firebase deploy --only hosting`.

## File touch-points

| Area | Location | Change |
|---|---|---|
| deviceId + version id/entry helpers | new, near `index.html:1067` | stable deviceId; `makeVersion`/batch commit helper |
| sessionFor | `1176-1180` | store `startContent`, `baseVersionId = note.contentVersion` |
| applyEntryContent | `1133-1158` | content(+images) write only; drop inline archive |
| endBlockSession | new; replace 7 `blockSessions.delete` sites | batch: note content/version + version doc |
| saveEdit | `4221-4253` | batch commit result as a version doc |
| create | `~4457` | seed initial version doc |
| viewer | `3790-3948` | lazy-load subcollection; versions from docs; bump/delete/clear via docs; merge legacy inline |
| image GC | commit + viewer delete/clear | remove per-commit GC; lazy recompute on delete/clear/prune |
| fork/red dot | snapshot listener + history-button render | `contentBase` check + localStorage flag + badge |
| rules | `firestore.rules` | history subcollection: read/create/delete, no update |
| migration | viewer read | tolerate + merge legacy inline `editHistory` |
