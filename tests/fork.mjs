// All fork-detection logic tests, against the REAL functions in index.html.
import { loadFork, runner } from './harness.mjs';
const F = process.env.TARGET;
const { ok, done } = runner();

// ── the stale-clobber race (the scenario the feature exists for) ─────────────
{
  const { state, checkForkAlerts, orphanVersionIds, create, commit } = loadFork(F);
  console.log('\nstale clobber:');
  create('n', 'V0');
  checkForkAlerts([{ id: 'n', contentVersion: 'V0', contentBase: null }]);
  commit('n', 'Vb');                                    // WE commit from V0
  checkForkAlerts([{ id: 'n', contentVersion: 'Vb', contentBase: 'V0' }]);
  // stale device A replays, also from V0 — clobbers content
  checkForkAlerts([{ id: 'n', contentVersion: 'Va', contentBase: 'V0' }]);
  ok('the device that LOST work suspects a fork', state.suspected.includes('n'));
  const lineage = [{id:'V0',base:null},{id:'Vb',base:'V0'},{id:'Va',base:'V0'}];
  ok('and the walk confirms our version is orphaned', orphanVersionIds(lineage, 'Va').orphans.has('Vb'));
  ok('current is not an orphan', !orphanVersionIds(lineage, 'Va').orphans.has('Va'));
}

// ── solo device: no false positives ─────────────────────────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nsolo device, fresh note, block edit (the reported false positive):');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  commit('n', 'MINE');
  checkForkAlerts([{ id: 'n', contentVersion: 'MINE', contentBase: 'SEED' }]);
  // the block editor's content-only write echoes the note back at the SEED
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  ok('held does not regress onto the seed', state.noteVersions.n === 'MINE');
  ok('no suspicion from our own stale echo', !state.suspected.includes('n'));
}

// ── held can HEAL forward if it was left behind ──────────────────────────────
{
  const { state, checkForkAlerts } = loadFork(F);
  console.log('\nheld left behind (stale tab / old build):');
  state.noteVersions.n = 'SEED';
  state.seenVersions.n = ['SEED', 'MINE'];
  checkForkAlerts([{ id: 'n', contentVersion: 'MINE', contentBase: 'SEED' }]);
  ok('heals forward to the real current', state.noteVersions.n === 'MINE');
  ok('without a bogus suspicion', !state.suspected.includes('n'));
}

// ── clean sequential sync between two devices ────────────────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nclean sequential sync (A then B):');
  create('n', 'V0');
  checkForkAlerts([{ id: 'n', contentVersion: 'V0', contentBase: null }]);
  commit('n', 'V1');
  checkForkAlerts([{ id: 'n', contentVersion: 'V1', contentBase: 'V0' }]);
  checkForkAlerts([{ id: 'n', contentVersion: 'V2', contentBase: 'V1' }]);  // B edits on top
  ok('no false positive', !state.suspected.includes('n'));
  ok('we now hold B\'s version', state.noteVersions.n === 'V2');
}

// ── a coalesced remote chain is not a fork ───────────────────────────────────
{
  const { state, checkForkAlerts, orphanVersionIds, create } = loadFork(F);
  console.log('\ncoalesced remote chain (base never seen, but nothing lost):');
  create('n', 'V0');
  checkForkAlerts([{ id: 'n', contentVersion: 'V0', contentBase: null }]);
  checkForkAlerts([{ id: 'n', contentVersion: 'V3', contentBase: 'V2' }]);  // V1,V2 never seen
  const lineage = [{id:'V0',base:null},{id:'V1',base:'V0'},{id:'V2',base:'V1'},{id:'V3',base:'V2'}];
  ok('the walk finds NO orphans (so nothing is shown)', orphanVersionIds(lineage, 'V3').orphans.size === 0);
}

// ── a device already told about an orphan does not re-suspect ────────────────
{
  const { state, checkForkAlerts, create } = loadFork(F);
  console.log('\nnote doc already carries the orphan:');
  create('n', 'V0');
  checkForkAlerts([{ id: 'n', contentVersion: 'V0', contentBase: null }]);
  checkForkAlerts([{ id: 'n', contentVersion: 'Va', contentBase: 'Vx',
                    orphanVersions: ['Vlost'] }]);
  ok('no redundant verification when the note already says it is forked',
     !state.suspected.includes('n'));
}

// ── the orphan walk ─────────────────────────────────────────────────────────
{
  const { orphanVersionIds } = loadFork(F);
  console.log('\norphan walk:');
  const chain = [{id:'V1',base:null},{id:'V2',base:'V1'},{id:'V3',base:'V2'}];
  ok('linear chain: no orphans', orphanVersionIds(chain, 'V3').status === 'clean');
  ok('unknown current => status "unknown", NOT a clean verdict', orphanVersionIds(chain, 'V9').status === 'unknown');
  ok('...and it reports no orphans (so nothing bogus is shown)', orphanVersionIds(chain, 'V9').orphans.size === 0);
  ok('hole in the chain (deleted version) => cannot determine',
     orphanVersionIds([{id:'V1',base:null},{id:'V3',base:'GONE'}], 'V3').status === 'unknown');
  ok('re-parented after a delete => no orphans',
     orphanVersionIds([{id:'V1',base:null},{id:'V3',base:'V1'}], 'V3').status === 'clean');
  ok('a real branch is an orphan',
     orphanVersionIds([...chain, {id:'Vx',base:'V1'}], 'Vx').orphans.has('V3'));
  ok('legacy versions are never orphans',
     !orphanVersionIds([{id:'legacy:0',base:null,legacy:true},{id:'V1',base:null}], 'V1').orphans.has('legacy:0'));
}

// ── seenVersions is an ORDER, not a buffer ──────────────────────────────────
{
  const { state, markSeen, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nseenVersions ordering:');
  markSeen('n', 'A'); markSeen('n', 'B'); markSeen('n', 'A');   // re-see the OLDER one
  ok('re-seeing an older version does NOT move it to the end',
     state.seenVersions.n.join(',') === 'A,B');

  // No cap: the seed must survive a long history, or the backwards guard goes blind.
  const { state: st2, markSeen: mk2 } = loadFork(F);
  mk2('n', 'SEED');
  for (let i = 0; i < 60; i++) mk2('n', 'V' + i);
  ok('the seed is still present after 60 versions (no eviction)',
     st2.seenVersions.n[0] === 'SEED');
  ok('all 61 versions retained', st2.seenVersions.n.length === 61);
}

// ── and the guard still works on a LONG history ─────────────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nlong history: a stale echo of the seed is still recognised:');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  let prev = 'SEED';
  for (let i = 0; i < 40; i++) {
    commit('n', 'V' + i);
    checkForkAlerts([{ id: 'n', contentVersion: 'V' + i, contentBase: prev }]);
    prev = 'V' + i;
  }
  ok('we hold the newest version', state.noteVersions.n === 'V39');
  state.suspected.length = 0;
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);  // stale echo
  ok('held does NOT regress onto the seed after 40 versions', state.noteVersions.n === 'V39');
  ok('no bogus suspicion', !state.suspected.includes('n'));
}

// ── the walk must DISTINGUISH "clean" from "cannot determine" ────────────────
{
  const { orphanVersionIds } = loadFork(F);
  console.log('\nclean vs unknown are different answers:');
  const chain = [{id:'V1',base:null},{id:'V2',base:'V1'}];
  ok('walkable + nothing orphaned => clean', orphanVersionIds(chain, 'V2').status === 'clean');
  ok('missing current => unknown', orphanVersionIds(chain, 'GONE').status === 'unknown');
  ok('hole in chain => unknown',
     orphanVersionIds([{id:'V1',base:'MISSING'}], 'V1').status === 'unknown');
  ok('a real fork => orphans',
     orphanVersionIds([...chain, {id:'Vx',base:'V1'}], 'Vx').status === 'orphans');
  // The critical property: 'unknown' and 'clean' both carry an EMPTY orphan set, so a caller
  // that only looked at the set would publish "no orphans" and erase a confirmed fork.
  ok('unknown and clean both have empty sets — only `status` tells them apart',
     orphanVersionIds(chain, 'GONE').orphans.size === 0 &&
     orphanVersionIds(chain, 'V2').orphans.size === 0);
}

// ── an empty snapshot must not wipe detection state ─────────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nempty snapshot (boot / still loading):');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  commit('n', 'V1');
  checkForkAlerts([{ id: 'n', contentVersion: 'V1', contentBase: 'SEED' }]);
  checkForkAlerts([]);                       // an empty snapshot arrives
  ok('held survives an empty snapshot', state.noteVersions.n === 'V1');
  ok('seen survives an empty snapshot', (state.seenVersions.n || []).length === 2);
  // ...and the guard still works afterwards
  state.suspected.length = 0;
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  ok('the backwards guard still works after it', state.noteVersions.n === 'V1');
  ok('no bogus suspicion', !state.suspected.includes('n'));
}

// ── pendingCommits must not wedge if our echo is missed ─────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\npendingCommits failsafe (our echo never arrives):');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  commit('n', 'MINE');                                  // pending = MINE
  state.seenVersions.n.push('THEIRS');                   // the note moved PAST our commit
  checkForkAlerts([{ id: 'n', contentVersion: 'THEIRS', contentBase: 'MINE' }]);
  ok('pending is cleared when the note moves past our commit',
     !state.pendingCommits.has('n'));
  ok('and detection resumes (held advanced)', state.noteVersions.n === 'THEIRS');
}

// ── review round 2 ──────────────────────────────────────────────────────────
{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\npendingCommits: a REMOTE commit lands on top of our pending version:');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }]);
  commit('n', 'MINE');                       // our commit is in flight
  // Another device commits on top of MINE. Its version was never seen by us, so an
  // indexOf-based check finds nothing and would leave the note wedged all session.
  checkForkAlerts([{ id: 'n', contentVersion: 'THEIRS', contentBase: 'MINE' }]);
  ok('pending clears when a remote commit builds on ours', !state.pendingCommits.has('n'));
  ok('detection resumes (held advanced)', state.noteVersions.n === 'THEIRS');
}

{
  const { state, checkForkAlerts, create, commit } = loadFork(F);
  console.log('\nprune must not run on a CACHE snapshot:');
  create('n', 'SEED');
  checkForkAlerts([{ id: 'n', contentVersion: 'SEED', contentBase: null }], false);
  commit('n', 'V1');
  checkForkAlerts([{ id: 'n', contentVersion: 'V1', contentBase: 'SEED' }], false);
  // A partially-populated cache snapshot arrives that simply omits the note.
  checkForkAlerts([{ id: 'other', contentVersion: 'X', contentBase: null }], true);
  ok('held survives a partial cache snapshot', state.noteVersions.n === 'V1');
  ok('seen survives a partial cache snapshot', (state.seenVersions.n || []).length === 2);
  // A trusted server snapshot that really omits it DOES prune.
  checkForkAlerts([{ id: 'other', contentVersion: 'X', contentBase: null }], false);
  ok('a server snapshot still prunes a genuinely deleted note', !state.noteVersions.n);
}

done();
