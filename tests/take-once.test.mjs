// Every test builds real git repos in a temp folder: a bare origin plus clones. No network.
// Run: node tests/take-once.test.mjs   (TAKE_ONCE_BIN=<path> runs the suite against another copy, for mutation checks)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = process.env.TAKE_ONCE_BIN || path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/take-once.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'take-once-test-'));
fs.writeFileSync(path.join(TMP, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: path.join(TMP, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', TMPDIR: TMP };
delete ENV.TAKE_ONCE_BEFORE_PUSH;
const H = 36e5, T0 = Date.parse('2026-01-05T12:00:00Z'), iso = (ms) => new Date(ms).toISOString();
const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const at = (ms) => ({ GIT_AUTHOR_DATE: iso(ms), GIT_COMMITTER_DATE: iso(ms) });
const brief = (title, head = {}) => `# ${title}\n\n` + Object.entries(head).map(([k, v]) => `${k}: ${v}\n`).join('') + '\n## Steps\n1. do the thing\n';
const report = (status) => `\n## Report\nChanged: x\nStatus: ${status}\n`;

let n = 0;
/* A bare origin with main (one commit) and a queue branch built from `commits` [{msg, at, write: {path: text}, move: [[a, b]]}].
   `branches`: {name: 'merged' | 'unmerged' | ms} pushes a branch that is on main, off main, or off main with a commit at ms. */
function repo(commits, branches = {}) {
  const dir = path.join(TMP, 'r' + ++n), origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed');
  fs.mkdirSync(dir); git(dir, ['init', '-q', '--bare', origin]); git(dir, ['clone', '-q', origin, seed]);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'app\n'); git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'main'], at(T0 - 48 * H));
  git(seed, ['push', '-q', 'origin', 'main']);
  for (const [b, kind] of Object.entries(branches)) {
    git(seed, ['checkout', '-q', '-b', b, 'main']);
    fs.writeFileSync(path.join(seed, b + '.txt'), b); git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'work on ' + b], at(typeof kind === 'number' ? kind : T0 - 24 * H));
    git(seed, ['push', '-q', 'origin', b]);
    if (kind === 'merged') { git(seed, ['checkout', '-q', 'main']); git(seed, ['merge', '-q', '--no-ff', '-m', `Merge branch '${b}'`, b]); git(seed, ['push', '-q', 'origin', 'main']); }
  }
  git(seed, ['checkout', '-q', '--orphan', 'queue']); git(seed, ['rm', '-rq', '--cached', '.']);
  for (const f of fs.readdirSync(seed)) if (f !== '.git') fs.rmSync(path.join(seed, f), { recursive: true });
  for (const c of commits) {
    for (const [p, text] of Object.entries(c.write || {})) { fs.mkdirSync(path.dirname(path.join(seed, p)), { recursive: true }); fs.writeFileSync(path.join(seed, p), text); }
    for (const [a, b] of c.move || []) { fs.mkdirSync(path.dirname(path.join(seed, b)), { recursive: true }); git(seed, ['mv', a, b]); }
    git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', c.msg], at(c.at ?? T0));
  }
  git(seed, ['push', '-q', 'origin', 'queue']);
  const clone = (name) => { const d = path.join(dir, name); if (!fs.existsSync(d)) git(dir, ['clone', '-q', origin, d]); return d; };
  const og = (args) => git(dir, ['--git-dir', origin, ...args]);
  return { dir, origin, clone, og, tip: () => og(['rev-parse', 'refs/heads/queue']), blob: (p) => og(['show', 'refs/heads/queue:' + p]), files: () => og(['ls-tree', '-r', '--name-only', 'refs/heads/queue']).split('\n') };
}
const run = (cwd, args, env = {}) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env } }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const pick = (cwd, args = []) => { const r = run(cwd, ['pick', '--json', ...args]); return { ...r, rows: r.out ? r.out.split('\n').map((l) => JSON.parse(l)) : [] }; };
const row = (rows, name) => rows.find((r) => r.name === name) || {};
const runAsync = (cwd, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], { cwd, env: ENV }); let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out: out.trim() }));
});

test('pick: blockers count only once done AND merged; touches overlap waits; non-briefs are ignored', () => {
  const B = (t, h = {}) => brief(t, { 'Blocked by': 'none', ...h });
  const r = repo([{ msg: 'seed', write: {
    'queue/README.md': '# how the queue works\n', 'queue/notes.md': 'not a brief\n',
    'queue/done/010-merged.md': B('010', { Branch: 'b010 (from main)' }) + report('DONE'),
    'queue/done/011-unmerged.md': B('011', { Branch: 'b011 (from main)' }) + report('DONE_WITH_CONCERNS'),
    'queue/done/012-blocked.md': B('012', { Branch: 'b012 (from main)' }) + report('BLOCKED'),
    'queue/done/013-nobranch.md': B('013') + report('DONE'),
    'queue/taken/030-busy.md': B('030', { Touches: 'src/core/, docs/a.md', Claimed: 'alpha ' + iso(Date.now()) }),
    'queue/020-after-merged.md': B('020', { 'Blocked by': '010' }),
    'queue/021-after-unmerged.md': B('021', { 'Blocked by': '010, 011' }),
    'queue/022-after-blocked.md': B('022', { 'Blocked by': '012' }),
    'queue/023-after-missing.md': B('023', { 'Blocked by': '099' }),
    'queue/024-after-nobranch.md': B('024', { 'Blocked by': '013' }),
    'queue/025-same-folder.md': B('025', { Touches: 'src/core/queue.js' }),
    'queue/026-glob.md': B('026', { Touches: 'docs/*.md' }),
    'queue/027-free.md': B('027', { Touches: 'src/ui/' }),
    'queue/fix-thing-1.md': B('fix-thing-1'),
  } }], { b010: 'merged', b011: 'unmerged' });
  const p = pick(r.clone('a'));
  assert.equal(p.code, 0, p.err);
  const got = Object.fromEntries(p.rows.map((x) => [x.name, `${x.decision}:${x.reason}`]));
  assert.deepEqual(got, {
    'fix-thing-1.md': 'take:ok', '020-after-merged.md': 'take:ok', '021-after-unmerged.md': 'wait:blocked:011:not-merged',
    '022-after-blocked.md': 'wait:blocked:012', '023-after-missing.md': 'wait:blocked:099', '024-after-nobranch.md': 'take:ok',
    '025-same-folder.md': 'wait:touches:030', '026-glob.md': 'wait:touches:030', '027-free.md': 'take:ok',
  });
  assert.equal(p.rows[0].name, 'fix-thing-1.md', 'fix briefs sort first');
});

test('pick: an unresolvable main ref is an error, never "nothing is merged"', () => {
  const r = repo([{ msg: 'seed', write: {
    'queue/done/010-a.md': brief('010', { Branch: 'b010' }) + report('DONE'),
    'queue/020-b.md': brief('020', { 'Blocked by': '010' }) } }], { b010: 'merged' });
  const p = pick(r.clone('a'), ['--main', 'origin/nope']);
  assert.equal(p.code, 2);
  assert.match(p.err, /cannot resolve origin\/nope/);
  assert.equal(p.out, '', 'prints no decision lines when it cannot judge');
});

test('take: moves the brief to taken/ with a Claimed line, in one commit', () => {
  const r = repo([{ msg: 'seed', write: { 'queue/040-x.md': brief('040 x', { 'Blocked by': 'none', Touches: 'a.js' }) } }]);
  const t = run(r.clone('a'), ['take', '040-x.md', 'alpha']);
  assert.equal(t.code, 0, t.err); assert.equal(t.out, 'took 040-x.md');
  assert.ok(r.files().includes('queue/taken/040-x.md') && !r.files().includes('queue/040-x.md'));
  assert.match(r.blob('queue/taken/040-x.md'), /^Claimed: alpha \d{4}-\d\d-\d\dT[\d:]+Z$/m);
  assert.equal(r.og(['log', '-1', '--format=%s', 'refs/heads/queue']), 'take 040 (alpha)');
});

test('replay: a take loop fed finished and claimed briefs moves nothing', () => {
  // The incident: a builder script fed every brief name it found under queue/ (done/ and taken/ included) to a hand-written
  // move, and rebuilt work that was already finished.
  const r = repo([{ msg: 'seed', write: {
    'queue/done/034-a.md': brief('034') + report('DONE'),
    'queue/taken/055-b.md': brief('055', { Claimed: 'alpha ' + iso(Date.now()) }),
    'queue/096-c.md': brief('096', { 'Blocked by': 'none' }) } }]);
  const w = r.clone('b'), before = r.tip();
  for (const [name, why] of [['034-a.md', 'already-done'], ['055-b.md', 'already-taken'], ['README.md', 'not-a-brief'], ['../x.md', 'not-a-brief']]) {
    const t = run(w, ['take', name, 'beta']);
    assert.equal(t.code, 1, t.err); assert.equal(t.out, `refuse ${name} ${why}`);
  }
  assert.equal(r.tip(), before, 'the queue branch did not move');
});

test('race: when two machines push at once, the second one re-checks and reports lost', () => {
  const r = repo([{ msg: 'seed', write: { 'queue/060-race.md': brief('060', { 'Blocked by': 'none' }) } }]);
  const a = r.clone('a'), b = r.clone('b'), before = r.tip(), outA = path.join(r.dir, 'a.out');
  // b's hook runs a's whole take in the gap between b's commit and b's push.
  const hook = `cd '${a}' && TAKE_ONCE_BEFORE_PUSH= '${process.execPath}' '${BIN}' take 060-race.md alpha > '${outA}'`;
  const tb = run(b, ['take', '060-race.md', 'beta'], { TAKE_ONCE_BEFORE_PUSH: hook });
  assert.equal(fs.readFileSync(outA, 'utf8').trim(), 'took 060-race.md');
  assert.equal(tb.code, 1, tb.err); assert.equal(tb.out, 'lost 060-race.md');
  assert.equal(r.og(['rev-list', '--count', before + '..refs/heads/queue']), '1');
  assert.equal(r.og(['rev-parse', 'refs/heads/queue^']), before, 'history was not rewritten');
});

test('break-the-claim: eight machines take at once, and every brief is taken exactly once', async () => {
  const r = repo([{ msg: 'seed', write: Object.fromEntries(['070-a', '071-b', '072-c'].map((x) => [`queue/${x}.md`, brief(x, { 'Blocked by': 'none' })])) }]);
  const who = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], dirs = who.map((w) => r.clone(w)), before = r.tip();
  // Every machine tries every brief, all at the same moment.
  const results = (await Promise.all(dirs.map((d, i) => Promise.all(['070-a.md', '071-b.md', '072-c.md'].map((b) => runAsync(d, ['take', b, who[i]])))))).flat();
  const took = results.filter((x) => x.code === 0 && x.out.startsWith('took '));
  assert.equal(took.length, 3, 'exactly three takes succeeded: ' + took.map((x) => x.out).join(', '));
  assert.deepEqual(took.map((x) => x.out).sort(), ['took 070-a.md', 'took 071-b.md', 'took 072-c.md']);
  assert.ok(results.every((x) => x.code === 0 || (x.code === 1 && /^(lost|refuse) /.test(x.out))), 'every other attempt was refused or lost, none errored: ' + results.filter((x) => x.code === 2).map((x) => x.out).join(' | '));
  assert.deepEqual(r.files().filter((f) => f.endsWith('.md')).sort(), ['queue/taken/070-a.md', 'queue/taken/071-b.md', 'queue/taken/072-c.md']);
  assert.equal(r.og(['rev-list', '--count', before + '..refs/heads/queue']), '3', 'one take commit per brief, no duplicates');
  const claims = ['070-a', '071-b', '072-c'].map((x) => r.blob(`queue/taken/${x}.md`).match(/^Claimed: (\S+)/m)[1]);
  const committers = r.og(['log', '--format=%s', before + '..refs/heads/queue']).split('\n').map((s) => s.match(/\((\S+)\)$/)[1]);
  assert.deepEqual(claims.sort(), committers.sort(), 'the Claimed line names the machine whose push landed');
});

test('done: reports land in done/ with the status last, and only the holder can finish', () => {
  const r = repo([{ msg: 'seed', write: {
    'queue/taken/080-x.md': brief('080', { Branch: 'b080', Claimed: 'alpha ' + iso(Date.now()) }),
    'queue/081-y.md': brief('081', { 'Blocked by': '080' }) } }], { b080: 'merged' });
  const a = r.clone('a'), rep = path.join(r.dir, 'report.txt');
  fs.writeFileSync(rep, 'Changed: src/x.js\nStatus: something the agent wrote\nTests: 4 pass\n');
  assert.equal(run(a, ['done', '080-x.md', 'beta', '--status', 'DONE']).out, 'refuse 080-x.md held-by:alpha');
  assert.equal(row(pick(a).rows, '081-y.md').reason, 'blocked:080');
  const d = run(a, ['done', '080-x.md', 'alpha', '--status', 'DONE', '--report', rep]);
  assert.equal(d.code, 0, d.err);
  const text = r.blob('queue/done/080-x.md');
  assert.match(text, /## Report\nChanged: src\/x\.js\n\nTests: 4 pass\nStatus: DONE$/);
  assert.equal(text.match(/^Status:/gm).length, 1, 'a Status line inside the report cannot fake the verdict');
  assert.equal(row(pick(a).rows, '081-y.md').decision, 'take', 'the dependent brief opens once its blocker is done and merged');
  assert.equal(run(a, ['done', '080-x.md', 'alpha', '--status', 'DONE']).out, 'refuse 080-x.md not-taken');
});

test('stale claims: only old claims with no recent push go stale, and reclaim puts them back', () => {
  const now = T0 + 4 * H;
  const r = repo([{ msg: 'take 100 (alpha)', at: T0, write: {
    'queue/taken/100-fresh.md': brief('100', { Claimed: 'alpha ' + iso(T0 + 3.5 * H) }),
    'queue/taken/101-old.md': brief('101', { Claimed: 'alpha ' + iso(T0) }),
    'queue/taken/102-old-pushed.md': brief('102', { Branch: 'b102', Claimed: 'beta ' + iso(T0) }),
    'queue/taken/103-old-leased.md': brief('103', { Claimed: 'beta ' + iso(T0), Lease: iso(T0 + 2.5 * H) }),
    'queue/taken/104-no-claim.md': brief('104'),
    'queue/taken/105-old-branch.md': brief('105', { Branch: 'b105', Claimed: 'beta ' + iso(T0) }),
  } }], { b102: T0 + 3.5 * H, b105: T0 - 20 * H });
  const a = r.clone('a');
  const stale = (rows) => rows.filter((x) => x.in === 'taken').map((x) => `${x.name}=${x.reason}`).sort();
  assert.deepEqual(stale(pick(a, ['--now', iso(now)]).rows), ['101-old.md=stale:alpha', '104-no-claim.md=stale:alpha', '105-old-branch.md=stale:beta']);
  assert.deepEqual(stale(pick(a, ['--now', iso(T0 + 2 * H)]).rows), [], 'nothing is stale inside the window');
  const before = r.tip(), dry = run(a, ['reclaim', '--now', iso(now)]);
  assert.equal(dry.code, 0, dry.err); assert.equal(r.tip(), before, 'reclaim without --apply writes nothing');
  assert.equal(run(a, ['reclaim', '--apply', '--now', iso(now)]).code, 0);
  const f = r.files();
  for (const x of ['101-old', '104-no-claim', '105-old-branch']) assert.ok(f.includes(`queue/${x}.md`) && !f.includes(`queue/taken/${x}.md`), x);
  for (const x of ['100-fresh', '102-old-pushed', '103-old-leased']) assert.ok(f.includes(`queue/taken/${x}.md`), x);
  const back = r.blob('queue/101-old.md');
  assert.match(back, /^Attempt: 2$/m); assert.match(back, /^Reclaimed: \S+ stale:alpha: claimed .+, over 3 hours ago; no branch named$/m);
  assert.doesNotMatch(back, /^(Claimed|Lease):/m);
  assert.equal(r.og(['log', '-1', '--format=%s', 'refs/heads/queue']), 'reclaim 101 104 105 (stale)');
  assert.equal(row(pick(a, ['--now', iso(now)]).rows, '101-old.md').decision, 'take', 'a reclaimed brief can be taken again');
});

test('lease: refreshes only the briefs this machine holds, in one commit', () => {
  const r = repo([{ msg: 'seed', write: {
    'queue/taken/110-a.md': brief('110', { Claimed: 'alpha ' + iso(T0) }),
    'queue/taken/111-b.md': brief('111', { Claimed: 'beta ' + iso(T0) }) } }]);
  const a = r.clone('a'), l = run(a, ['lease', 'alpha', '110-a.md', '111-b.md', '112-gone.md']);
  assert.equal(l.out, 'leased 110-a.md');
  assert.match(r.blob('queue/taken/110-a.md'), /^Lease: \S+Z$/m);
  assert.doesNotMatch(r.blob('queue/taken/111-b.md'), /^Lease:/m);
  const tip = r.tip();
  assert.equal(run(a, ['lease', 'alpha', '111-b.md']).out, 'lease none'); assert.equal(r.tip(), tip, 'nothing to refresh pushes nothing');
});

test('merge detection: a deleted branch counts through its merge commit; a squash merge does not (a stated limit)', () => {
  const r = repo([{ msg: 'seed', write: {
    'queue/done/120-gone.md': brief('120', { Branch: 'b120' }) + report('DONE'),
    'queue/done/121-squashed.md': brief('121', { Branch: 'b121' }) + report('DONE'),
    'queue/130-after-gone.md': brief('130', { 'Blocked by': '120' }),
    'queue/131-after-squash.md': brief('131', { 'Blocked by': '121' }) } }], { b120: 'merged', b121: 'unmerged' });
  const s = r.clone('s');
  git(s, ['push', '-q', 'origin', '--delete', 'b120']);
  git(s, ['checkout', '-q', 'main']); git(s, ['merge', '-q', '--squash', 'origin/b121']); git(s, ['commit', '-q', '-m', 'add b121 (squashed)']); git(s, ['push', '-q', 'origin', 'main']);
  const p = pick(r.clone('a'));
  assert.equal(row(p.rows, '130-after-gone.md').decision, 'take');
  assert.equal(row(p.rows, '131-after-squash.md').reason, 'blocked:121:not-merged');
});

test('pick and reclaim print aligned, readable lines by default; --json keeps one JSON object per line', () => {
  const r = repo([{ msg: 'take 101 (alpha)', at: T0, write: {
    'queue/040-retry-config.md': brief('040', { 'Blocked by': 'none', Touches: 'src/net/config.js' }),
    'queue/041-add-retry.md': brief('041', { 'Blocked by': '040', Touches: 'src/net/' }),
    'queue/taken/101-old.md': brief('101', { Claimed: 'alpha ' + iso(T0) }) } }]);
  const a = r.clone('a'), now = iso(T0 + 4 * H);
  const human = run(a, ['pick', '--now', now]);
  assert.equal(human.code, 0, human.err);
  assert.deepEqual(human.out.split('\n'), [
    'take  040-retry-config.md  ok',
    'wait  041-add-retry.md     blocked:040',
    'skip  101-old.md           stale:alpha',
  ]);
  const json = run(a, ['pick', '--json', '--now', now]).out.split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(json.map((x) => x.decision), ['take', 'wait', 'skip']);
  assert.equal(run(a, ['reclaim', '--now', now]).out, 'dry run: would reclaim 101-old.md  stale:alpha');
  const empty = repo([{ msg: 'seed', write: { 'queue/README.md': '# notes\n' } }]);
  assert.equal(run(empty.clone('e'), ['pick']).out, 'nothing in the queue');
  assert.equal(run(empty.clone('f'), ['pick', '--json']).out, '', 'JSON mode prints nothing for an empty queue');
});

test('init creates the queue branch with an example task, and refuses when one already exists', () => {
  const dir = path.join(TMP, 'init' + ++n), origin = path.join(dir, 'origin.git'), work = path.join(dir, 'work');
  fs.mkdirSync(dir); git(dir, ['init', '-q', '--bare', origin]); git(dir, ['clone', '-q', origin, work]);
  fs.writeFileSync(path.join(work, 'app.txt'), 'app\n'); git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'main']); git(work, ['push', '-q', 'origin', 'main']);
  const before = git(work, ['status', '--porcelain']) + git(work, ['rev-parse', 'HEAD']);
  const i = run(work, ['init']);
  assert.equal(i.code, 0, i.err);
  assert.equal(i.out, 'created branch queue on origin with queue/001-example.md');
  assert.equal(git(dir, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'refs/heads/queue']), 'queue/001-example.md');
  assert.equal(git(work, ['status', '--porcelain']) + git(work, ['rev-parse', 'HEAD']), before, 'the working tree and current branch are untouched');
  assert.deepEqual(pick(work).rows.map((x) => `${x.name}=${x.decision}`), ['001-example.md=take'], 'the example task is ready to take');
  const tip = git(dir, ['--git-dir', origin, 'rev-parse', 'refs/heads/queue']);
  const again = run(work, ['init']);
  assert.equal(again.code, 1); assert.equal(again.out, 'refuse init queue-exists');
  assert.equal(git(dir, ['--git-dir', origin, 'rev-parse', 'refs/heads/queue']), tip, 'an existing queue is never replaced');
  assert.equal(run(work, ['init', '--remote', 'nowhere']).code, 2, 'a missing remote is an error, not a success');
});
