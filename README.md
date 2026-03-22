# One List

A minimal append-and-review note-taking app. Write things down, bump important ones to the top, and optionally share entries with collaborators.

Built as a single-page PWA with Firebase — no build step, no dependencies beyond a CDN-loaded Markdown renderer.

## Features

- **Append-only flow** — new entries go to the top, older ones sink naturally
- **Bump** — resurface any entry to the top without duplicating it
- **Inline editing** — edit in place with version history; browse, restore, or delete past versions
- **Sharing** — toggle entries as shared; collaborators can view and edit shared entries
- **Search & filter** — full-text search and view mode cycling (all / shared / unshared)
- **Markdown** — entries render as Markdown with links, code blocks, lists, etc.
- **Offline-first** — Firestore persistent cache + service worker; works without connectivity
- **Dark mode** — follows system preference
- **PWA** — installable on mobile and desktop

## Stack

- **Frontend:** Single `index.html` (HTML + CSS + JS, no framework)
- **Backend:** Firebase (Auth, Firestore, Hosting)
- **Auth:** Google sign-in, restricted to an allowlist in Firestore (`config/allowedUsers`)
- **Markdown:** [marked](https://github.com/markedjs/marked) via CDN with SRI

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
index.html        # The entire app (markup, styles, logic)
sw.js             # Service worker for offline caching
manifest.json     # PWA manifest
firestore.rules   # Firestore security rules
firebase.json     # Firebase hosting and deploy config
stamp-deploy.sh   # Predeploy script that stamps build timestamp
```
