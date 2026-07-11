// In-memory stand-in for the Firebase SDK surface index.html actually uses.
// Notes live in store.entries; version docs in store.history[noteId][versionId].
export const __store = { entries: new Map(), history: new Map(), listeners: [] };
let autoId = 0;
const nextId = (p) => p + (++autoId);

export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function GoogleAuthProvider() {}
GoogleAuthProvider.prototype = {};
export function signInWithPopup() { return Promise.resolve(); }
export function signInWithRedirect() { return Promise.resolve(); }
export function getRedirectResult() { return Promise.resolve(null); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged(auth, cb) { setTimeout(() => cb({ email: 'me@test.dev' }), 0); return () => {}; }

export function initializeFirestore() { return { __db: true }; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }

const collRef = (path) => ({ __coll: true, path });
const docRef = (path) => ({ __doc: true, path, id: path[path.length - 1] });

export function collection(dbOrRef, ...segs) { return collRef(segs); }
export function doc(a, ...rest) {
  if (a && a.__coll) {
    const id = rest.length ? rest[0] : nextId('v');
    return docRef([...a.path, id]);
  }
  return docRef(rest);   // doc(db, 'entries', id)
}
export function query(ref, ...c) { return { __q: true, ref, c }; }
export function orderBy() { return {}; }
export function where() { return {}; }
export function or() { return {}; }
export function serverTimestamp() { return { __ts: true }; }
export function increment(n) { return { __inc: n }; }
export function arrayUnion(...v) { return { __au: v }; }
export function arrayRemove(...v) { return { __ar: v }; }

const now = () => { const d = new Date(); return { toDate: () => d, toMillis: () => d.getTime() }; };
function resolve(val, prev) {
  if (val && val.__ts) return now();
  if (val && val.__inc !== undefined) return (typeof prev === 'number' ? prev : 0) + val.__inc;
  if (val && val.__au) { const a = Array.isArray(prev) ? prev.slice() : []; for (const v of val.__au) if (!a.includes(v)) a.push(v); return a; }
  if (val && val.__ar) { const a = Array.isArray(prev) ? prev.slice() : []; return a.filter(x => !val.__ar.includes(x)); }
  return val;
}
// path → the map holding it. entries/{id} or entries/{id}/history/{vid}
function bucket(path) {
  if (path[0] === 'entries' && path.length === 2) return __store.entries;
  if (path[0] === 'entries' && path[2] === 'history') {
    const nid = path[1];
    if (!__store.history.has(nid)) __store.history.set(nid, new Map());
    return __store.history.get(nid);
  }
  if (path[0] === 'config') return new Map([['allowedUsers', { emails: ['me@test.dev'] }]]);
  return new Map();
}
const keyOf = (path) => path[path.length - 1];

function writeDoc(ref, data, merge) {
  const b = bucket(ref.path), k = keyOf(ref.path);
  const prev = merge ? (b.get(k) || {}) : {};
  const out = { ...prev };
  for (const f in data) out[f] = resolve(data[f], prev[f]);
  b.set(k, out);
}
function updateDocRaw(ref, data) {
  const b = bucket(ref.path), k = keyOf(ref.path);
  const prev = b.get(k) || {};
  const out = { ...prev };
  for (const f in data) out[f] = resolve(data[f], prev[f]);
  b.set(k, out);
}

export async function addDoc(ref, data) { const r = doc(ref); writeDoc(r, data); emit(); return r; }
export async function updateDoc(ref, data) { updateDocRaw(ref, data); emit(); }
export async function deleteDoc(ref) { bucket(ref.path).delete(keyOf(ref.path)); emit(); }
export async function getDoc(ref) {
  const d = bucket(ref.path).get(keyOf(ref.path));
  return { exists: () => !!d, data: () => d, id: keyOf(ref.path) };
}
export async function getDocs(q) {
  const ref = q.ref || q;
  const b = bucket([...ref.path, '_']);
  const rows = [...b.entries()].map(([id, data]) => ({ id, data: () => data }));
  rows.sort((a, b2) => (a.data().createdAt?.toMillis?.() || 0) - (b2.data().createdAt?.toMillis?.() || 0));
  return { forEach: (f) => rows.forEach(f), docs: rows, size: rows.length };
}
export function writeBatch() {
  const ops = [];
  return {
    set: (r, d) => ops.push(['set', r, d]),
    update: (r, d) => ops.push(['upd', r, d]),
    delete: (r) => ops.push(['del', r]),
    commit: async () => {
      for (const [k, r, d] of ops) {
        if (k === 'set') writeDoc(r, d);
        else if (k === 'upd') updateDocRaw(r, d);
        else bucket(r.path).delete(keyOf(r.path));
      }
      emit();
    },
  };
}
export function onSnapshot(q, opts, cb) {
  const fn = typeof opts === 'function' ? opts : cb;
  __store.listeners.push(fn);
  emit();
  return () => {};
}
export function emit() {
  const docs = [...__store.entries.entries()].map(([id, data]) => ({
    id, data: () => data, metadata: { hasPendingWrites: false },
  }));
  const snap = {
    docs, docChanges: () => docs, metadata: { fromCache: false, hasPendingWrites: false },
    forEach: (f) => docs.forEach(f),
  };
  __store.listeners.forEach(l => { try { l(snap); } catch (e) { console.error('listener', e); } });
}
window.__fs = { store: __store, emit, writeDoc, updateDocRaw, docRef, now };
export async function setDoc(ref, data) { writeDoc(ref, data); emit(); }
// Server read: same data here, but reports fromCache:false like a real server read.
export async function getDocsFromServer(q) { return getDocs(q); }
