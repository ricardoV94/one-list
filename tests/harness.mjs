// Slices the REAL fork functions out of index.html and binds their dependencies.
// One place to update when the app's internals change, instead of five test files.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadFork(file = ROOT + '/index.html') {
  const src = fs.readFileSync(file, 'utf8');
  const slice = (start, end) => {
    const a = src.indexOf(start);
    if (a < 0) throw new Error('slice failed: ' + start);
    const b = src.indexOf(end, a);
    return src.slice(a, b + end.length);
  };
  const forkSrc   = slice('function checkForkAlerts(', '\n    }');
  const orphanSrc = slice('function orphanVersionIds(versions, currentId)', '\n    }');
  const markSrc   = slice('function markSeen(noteId, versionId)', '\n    }');

  const state = {
    noteVersions: {},
    seenVersions: {},
    pendingCommits: new Map(),
    pendingForkChecks: new Set(),
    suspected: [],          // ids recheckOrphans was called for
    published: {},          // id -> orphan ids published to the note doc
  };

  const orphanVersionIds = new Function(orphanSrc + '; return orphanVersionIds;')();
  const markSeen = new Function('seenVersions', 'saveSeenVersions', markSrc + '; return markSeen;')(
    state.seenVersions, () => {});

  // The note doc is the source of truth for the alert now.
  const hasUnresolvedOrphans = (e) => {
    const orphans = e.orphanVersions || [];
    if (!orphans.length) return false;
    const resolved = e.resolvedVersions || [];
    return orphans.some(v => !resolved.includes(v));
  };

  const checkForkAlerts = new Function(
    'noteVersions', 'seenVersions', 'pendingCommits', 'pendingForkChecks',
    'markSeen', 'saveNoteVersions', 'saveSeenVersions', 'savePendingChecks',
    'recheckOrphans', 'hasUnresolvedOrphans',
    forkSrc + '; return checkForkAlerts;')(
    state.noteVersions, state.seenVersions, state.pendingCommits, state.pendingForkChecks,
    markSeen, () => {}, () => {}, () => {},
    (id) => state.suspected.push(id), hasUnresolvedOrphans);

  // Mirrors commitVersion's local bookkeeping.
  const commit = (noteId, versionId) => {
    state.noteVersions[noteId] = versionId;
    markSeen(noteId, versionId);
    state.pendingCommits.set(noteId, versionId);
  };
  // Mirrors appendEntry's local bookkeeping (held + seen, together).
  const create = (noteId, seedId) => {
    state.noteVersions[noteId] = seedId;
    markSeen(noteId, seedId);
  };

  return { state, checkForkAlerts, orphanVersionIds, markSeen, hasUnresolvedOrphans, commit, create };
}

export function runner() {
  let pass = 0, fail = 0;
  const ok = (n, c) => { c ? (pass++, console.log('  ok   ' + n)) : (fail++, console.log('  FAIL ' + n)); };
  const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
  return { ok, done };
}
