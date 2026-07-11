# One List

A minimal append-and-review note-taking app. Write things down, bump important ones to the top, and optionally share entries with collaborators.

Built as a single-page PWA with Firebase — no build step, no dependencies beyond a CDN-loaded Markdown renderer.

## Features

- **Append-only flow** — new entries go to the top, older ones sink naturally
- **Bump** — resurface any entry to the top without duplicating it
- **Inline editing** — edit in place with version history; browse, restore, or delete past versions
- **Loss-proof history** — every editing session archives its result as an immutable version, so a note overwritten by an out-of-sync device is always recoverable; the note is flagged with a rose edge on every device until the overwritten text is rescued or deleted. See [history-robustness-spec.md](history-robustness-spec.md)
- **Sharing** — toggle entries as shared; collaborators can view and edit shared entries
- **Search & filter** — full-text search and view mode cycling (all / shared / unshared)
- **Markdown** — entries render as Markdown with links, code blocks, lists, etc.; toolbar buttons for bullet lists and checkboxes
- **Offline-first** — Firestore persistent cache + service worker; works without connectivity. Uses the multi-tab cache manager (`persistentMultipleTabManager`) so concurrent tabs share one cache/connection and a crashed PWA instance can't hold the persistence lease — the standard choice across the one_list / recipes / money apps
- **Dark mode** — follows system preference
- **PWA** — installable on mobile and desktop

## Stack

- **Frontend:** Single `index.html` (HTML + CSS + JS, no framework)
- **Backend:** Firebase (Auth, Firestore, Hosting)
- **Auth:** Google sign-in, restricted to an allowlist in Firestore (`config/allowedUsers`); fails closed — non-allowlisted accounts are signed out with "Access denied" (the allowlist read itself is rules-denied for them, which is treated as not-authorized). Offline, the check is skipped and Firestore rules still protect the data. Listeners self-heal on transient stream errors and stop with a `Sync error: <code>` status on permanent ones (missing index, rules rejection)
- **Markdown:** [marked](https://github.com/markedjs/marked) via CDN with SRI, sanitized with [DOMPurify](https://github.com/cure53/DOMPurify)

## Setup

1. Create a Firebase project with Firestore and Google Auth enabled
2. Update `firebaseConfig` in `index.html` with your project's credentials
3. Create a Firestore document at `config/allowedUsers` with a field `emails` (array of authorized email addresses)
4. Deploy:

```bash
firebase deploy
```

## Project structure

```
index.html                    # The entire app (markup, styles, logic)
sw.js                         # Service worker for offline caching
manifest.json                 # PWA manifest
firestore.rules               # Firestore security rules
firebase.json                 # Firebase hosting and deploy config
stamp-deploy.sh               # Predeploy script that stamps build timestamp
history-robustness-spec.md    # How version history survives sync races
tests/                        # Test suites (committed, never deployed) — ./tests/run.sh
```

## Data model

A note is one document in `entries/{id}`: `content` (the current text, last-write-wins),
an `images` map (pasted images stored once, referenced from the text as `img:<id>`), and
sharing fields. Its past versions are immutable documents in the `entries/{id}/history`
subcollection — see the spec for the lineage fields and why they're shaped that way.

Changing history behaviour means touching `firestore.rules` too, so deploy both:

```bash
firebase deploy --only hosting,firestore:rules
```
