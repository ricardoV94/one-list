# one_list — version history

How a note's past versions are stored, why a sync race can never destroy one, and how the
app tells you when one happened.

## The guarantee

> No committed version of a note is ever *accidentally* unrecoverable due to a sync race —
> until the user chooses to clear history.

Live `content` is last-write-wins: concurrent edits are **not** merged, and the visible text
can lose a race. What's guaranteed is that the losing text survives as a version doc, and that
the user is told.

Note the split, because it governs every trade-off below: **storage carries the guarantee; the
alert is only a nudge.** Every version is durable whether or not any device notices the fork.
The alerting layer is heuristic and has been wrong repeatedly; the stored data has not.

## Data model

**Note doc** `entries/{id}`:

```js
{
  content,           // authoritative CURRENT text (last-write-wins)
  images,            // id → data URI; referenced from text as `img:<id>`
  contentVersion,    // id of the history doc holding this current text
  contentBase,       // the version that text was derived from (its parent)
  versionCount,      // increment() — commutative, survives parallel/offline writes
  editedAt,          // client ISO; the card's "last edited", no history read needed
  orphanVersions,    // CONFIRMED orphans — see Fork detection
  resolvedVersions,  // orphans the user has DEALT WITH (arrayUnion)
  // …createdAt, sortTime, owner, shared, hiddenFor
}
```

`contentVersion`/`contentBase` are duplicated onto the note doc **on purpose**: they keep fork
detection and the history-button state on the hot path, so the main list never reads the
subcollection. `contentBase` is not redundant with the current version doc's `base` — it's the
copy that costs no read.

`orphanVersions` / `resolvedVersions` live on the note doc, not in `localStorage`, because
*"this note has text that was overwritten"* is a fact about the **note**, not about what a
given device happened to witness. Whichever device confirms a fork publishes it; every other
device then shows the cue from the snapshot alone — no witness, no history read.

**History subcollection** `entries/{id}/history/{versionId}` — one doc per version:

```js
{
  content,                      // the committed RESULT of one editing session (immutable)
  createdAt: serverTimestamp(), // authoritative ordering
  editedAt,                     // client ISO; display fallback until the server stamp lands
  device,                       // deviceId, for attribution
  base,                         // parent versionId (null for a root). REPAIRABLE — see below.
}
```

`content` is never rewritten. `base` is structural metadata and *must* be repairable: deleting
a version leaves its children pointing at a doc that no longer exists.

## Commit path

One editing session → one version doc, holding the session's **result**. This is the
load-bearing choice: because a device archives *its own committed result*, a stale device that
replays and clobbers `content` still writes its text as a version doc. Recovery needs no witness
online at the moment of the clobber — which is exactly the case that has none (laptop asleep,
phone closed).

`commitVersion()` writes the version doc and the note's fields in one `writeBatch` — not a
`runTransaction`, because batches queue offline and replay as a unit, so `content` and its
backing version doc can never split. Transactions need a server round-trip and are unusable
offline.

| Path | When |
|---|---|
| Note create | Seeds the original as a version, so "restore what I first wrote" always survives |
| `saveEdit` (full editor) | On save, if the text changed |
| `endBlockSession` (block/line editors) | Once at session teardown, so a burst of block edits coalesces into ONE version |
| Restore / edit-from-history | Just another edit — see below |

Pure moves (reorder, checkbox toggle) change `content` without committing a version.

**Restore does NOT base on the version being restored.** It bases on *current*, because that is
what happened: the user looked at current and chose to replace its text with an older version's.
Basing on the picked version would leave the version it replaced unreachable from current —
rescuing one orphan would mint another, and the alert could never clear. The picked version stays
an orphan in the graph; what changed is that the user *dealt with* it (`resolvedVersions`).

**Local state must advance with the commit.** `commitVersion` updates the in-memory note object
as well as Firestore. A card in an open editing session is shielded from snapshot re-renders, so
nothing else refreshes it — and the *next* session on that card reads `contentVersion` from it to
pick its base. Leave it stale and the second edit commits against the version before last,
genuinely orphaning the first: a note forking against itself, on one device.

### Odd-looking write shapes (all forced by the rules)

Rules evaluate each write against the **already-committed** database — a `get()` cannot see other
writes in the same batch. Three consequences that look like mistakes and are not:

- **Create is two sequential writes, not one batch.** The history rule `get()`s the parent note.
  Inside a batch that also creates the note, that parent doesn't exist yet, the rule denies, and
  the whole batch is rejected — the note silently vanishes.
- **Those two writes are issued without `await` between them.** Offline, a `setDoc` promise does
  not resolve until the write reaches the server, so awaiting the note would leave the seed never
  *enqueued* — a tab closed before reconnect loses it permanently, leaving a hole at the root of
  the lineage. Issuing both queues them locally, in order, immediately.
- **Deleting a note deletes its versions first.** Firestore does not cascade, and once the note is
  gone the parent-note check makes those version docs undeletable forever.

Block sessions flush on `beforeunload` / `visibilitychange:hidden`. **Best-effort**: a hard-killed
tab can outrun the batch reaching Firestore's offline queue, losing that session's version. Nothing
already committed is at risk — only the in-flight session.

## Fork detection

An **orphan** is a version that is not an ancestor of `contentVersion` — text some edit discarded
from current. That is the whole definition; everything below is machinery for finding orphans
cheaply and *honestly*.

### The walk is three-valued

`orphanVersionIds` returns `{ status, orphans }`:

| status | meaning |
|---|---|
| `clean` | lineage fully walkable, nothing orphaned |
| `orphans` | lineage fully walkable, and these versions are orphaned |
| `unknown` | the lineage could **not** be established |

`unknown` arises when the current version isn't among the loaded docs (our own commit can outrun
its own doc into the cache), or when a `base` points at a version that isn't there (a hole).

**`unknown` and `clean` both carry an empty orphan set.** A caller that looks only at the set will
read "cannot determine" as "verified clean" — and since the orphan set is now note-global truth,
publishing that would **erase a confirmed orphan for every device**. Losing the alert is worse than
showing a spurious one: the alert is the only thing telling the user their text was overwritten.
So no caller may publish on `unknown`.

### Chain repair

A hole makes everything upstream unreachable from current, so the walk returns `unknown` and
detection for that note stops working *forever*. On `unknown`, the owner re-parents each dangling
node onto the newest surviving version older than it (by `createdAt`), or to `null`, then re-verifies
once the repair lands. This is why the rules permit a `base`-only update: repairing structure loses no
text.

Repair needs real `createdAt` values and **refuses to run without them** — guessing an order would
invent a lineage rather than restore one. (Every code path that feeds the walk must therefore carry
`ms`, not rely on the array happening to arrive in query order.)

Only the owner may repair. A collaborator on a note with a hole simply reports `unknown` and waits;
it does not re-read the server on every snapshot, because verification only re-runs when the note's
signature (`contentVersion`/`contentBase`/`versionCount`/orphan+resolved lists) actually changes. If
nothing moved, there is nothing new to learn.

Deleting a version re-parents its children up-front, so the ordinary path never creates a hole.
Repair exists for the paths that can still produce one — a lost seed, a partially-synced history.

### Suspect, then verify — never alert on an unverified suspicion

**Hot path** (every snapshot, no history read): an incoming `contentBase` that isn't the version we
held **suspects** a fork. It does not show one.

That distinction reverses an earlier design which biased toward over-alerting on the theory that
"a false positive costs a click". It doesn't. A red edge you open and find nothing behind teaches
you to ignore red edges, which costs exactly the thing the feature exists to buy. **A suspicion is
not evidence.**

**Verification**: one `getDocsFromServer` read + the walk. Deliberately a *server* read — the cache
can be missing the very version doc that proves or disproves the fork. If it fails (offline), we do
not guess in either direction: the suspicion is parked in `pendingForkChecks` (**persisted** — `held`
advances the moment a snapshot lands, so a crash between suspecting and verifying would otherwise
forget the fork on that device forever) and retried later. One verification in flight per note, or a
slow older read can overwrite a newer published set.

### `held` is monotonic — the invariant everything rests on

Each device records the version it holds (`oneListNoteVersions`) and, **in order**, every version it
has ever held (`oneListSeenVersions`). *A version already superseded can never become current again.*

Firestore does not promise snapshot states arrive in write order: a cached or delayed snapshot can
surface the note as it was *before* our latest commit. (The block editor makes such a state exist at
all — it writes `content` alone, then commits the version at teardown.) If `held` follows that
backwards, the walk starts from a superseded version and reports *our own newest version* as
orphaned — a red edge on a note nothing forked. Every false-positive bug in this feature's history
was a violation of this invariant.

`seenVersions` is therefore **an ordering, not a buffer**:

- **Never capped.** A cap evicts the oldest entries — the seed first. Once the seed is gone, a stale
  echo of it is unrecognisable as our own past, `held` regresses onto it, and the false positive
  returns. ~20 bytes per version; not a cost worth trading the invariant for.
- **Never re-appended.** Re-appending a known version moves the oldest to the end and inverts the
  order the guard reads.
- **Only *strictly backward* moves are blocked.** Blocking every move onto a seen version is a trap:
  if `held` ends up behind (a stale tab wrote it), the forward move that would heal it is exactly the
  one we'd refuse — `held` sticks in the past forever.
- **Anything that sets `held` must mark it seen in the same breath.** Note creation set `held` to the
  seed without recording it; the first snapshot then had `held === contentVersion` so the recording
  branch never ran, and the seed stayed invisible to the guard.

Related: while one of our own commits is still settling (`pendingCommits`), that note's snapshots are
our own in-flight state and are skipped. The authoritative clear is the **commit promise resolving** —
i.e. the write actually landing. Snapshot-derived clears are fast paths only: inferring "settled" from
snapshots covers our own succession but not a *remote* commit landing on top of our pending version
(its version id is one we have never seen), which would wedge the note for the rest of the session.

### Resolution

The alert persists until the orphan is **dealt with**: rescued, edited-and-saved from, or deleted.
Opening history is *looking*, not resolving.

An orphan stays an orphan in the graph forever (it can never become an ancestor of current), so
"have you handled it" cannot be read off the lineage — it is recorded in `resolvedVersions`.
`orphanVersions` (what *is* orphaned) and `resolvedVersions` (what's been *handled*) are kept
orthogonal on purpose: if a rescue erased the orphan record, the next verification would recompute
the lineage, find it orphaned again, and re-raise it — red flapping back on for something already
fixed.

### UI

The card's *left* edge carries sharing/link status; the *right* edge carries edit/history status —
so a fork cue composes with shared/unlinked rather than competing. A note with unresolved orphans
gets a rose right edge (`#d4728c`, the same rose as `.unlinked`), declared before `.editing-full` so
the blue edit cue wins while editing.

**Inside the history viewer the card edge tracks the version on screen**, not the note: rose only on
an orphan that is still **unresolved**. The note-level cue would otherwise paint every version rose,
and a resolved orphan would keep wearing a marker that means "go look at this" — the same
alert-that-means-nothing failure, one level down.

## Images

Images live once in the note doc's `images` map. Commits are **add-only** — a commit writer can't
cheaply see which images the other version docs reference, so it never drops one. Reclaiming happens
in the viewer, where history is already loaded:

- **Delete-version / clear**: recompute the union of `img:` refs across `content` + the *remaining*
  versions (**including** any legacy inline ones, or clearing could drop an image an old inline
  version still needs) and drop the rest. Owner only.
- **Restore**: no GC — every image stays, so a restored version's images resolve.

An unreferenced image lingers until the next delete/clear (mild note-doc bloat); a version's image is
never wrongly deleted. Safe over tight.

## Deletion

**No automatic cap, no auto-prune.** History is out of the note doc, so there's no 1 MiB pressure that
would justify silently deleting old versions — and automatic deletion is itself the data loss this
design prevents. A note with very many versions is limited at *display* time, never by deleting docs.

**Clear history is the one place the guarantee is legitimately given up**: orphaned versions live
*only* in history. It is user-initiated, keeps the version doc backing current text (nulling its `base`
so it becomes the new root rather than dangling), and when orphans exist the button says so —
`Delete all history — including N overwritten versions not in the current note` — rather than
discarding them as a silent side effect.

## Rules

`entries/{id}/history/{versionId}`:

- **read, create** — anyone who can reach the parent note. A collaborator editing a shared note *must*
  be able to archive their result; without it their overwritten text is unrecoverable, which is the
  whole guarantee.
- **delete** — owner only, matching the note's own delete rule and the UI. Not a trust boundary (this
  app is two people who trust each other); it just stops the rules permitting a destructive thing the
  app never offers.
- **update** — `base` only, owner only, with `content` unchanged. Needed for chain repair.

There is deliberately **no schema validation** on create. A `hasOnly([...])` field lock would start
*denying* archive writes the day a field is added to a version doc, and a denied write is a silently
lost version — a far worse failure than a stray field.

Because delete is permitted at all, immutability rests on *who* can delete: whoever may delete may
delete-then-recreate an id. The rules alone do not make a version tamper-proof, and this spec does not
claim they do.

## Legacy notes

Notes predating this design have an inline `editHistory` array of *pre-edit* snapshots. It is still
read and merged into the viewer, time-ordered with the version docs, and still restorable; nothing new
is written to it. Legacy entries get a synthesized id and `base: null`, so they are never treated as
orphans.

## Known limits

- **Detection is heuristic; storage is not.** A missed alert costs a nudge, never data. Bias every
  future change accordingly.
- **A hard-killed tab loses its in-flight session's version** (not anything already committed).
- **Verification costs a server read per suspicion**, and needs the network. Rare by construction.
- **Rules have no automated coverage.** Every rules bug so far (batch-create denial, delete-before-
  parent) was found in production. Closing this needs `@firebase/rules-unit-testing` + the emulator.
- **`versionCount` can drift** from the true doc count if a version write fails after the note update
  lands. It only drives the history button's label, never correctness.

## Verification

Suites live in `tests/` (committed, never deployed) — `./tests/run.sh`. See `tests/README.md`.

They drive the real functions and the real page, and several replay the exact console logs from real
false-positive reports. But they are structurally blind to the three things that caused **every** bug
in this feature: security rules, snapshot ordering, and the offline write queue. **A green suite is
necessary, not sufficient.**

Only a real two-device pass covers the target scenario: one device offline, both editing the same note.
Current goes last-write-wins; the overwritten version appears in history; the rose edge lights on every
device and stays until that orphan is rescued or deleted.
