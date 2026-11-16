#!/usr/bin/env node
// take-once: a work queue for coding agents that lives on one git branch. No server, no database, no lock service.
// Briefs are markdown files in queue/ on the queue branch. Taking one is a commit that moves it to queue/taken/, pushed
// without force: if two machines try at once, git accepts one push and rejects the other, and the loser re-checks from
// scratch. Finishing moves it to queue/done/ with a report whose last line is its status.
//
//   take-once init                             create the queue branch with one example task (never replaces one)
//   take-once pick    [--only <name>] [--json] one line per task: take | wait | skip, and why
//   take-once take    <name> <who>             exit 0 took, 1 refused or lost (someone else has it), 2 error
//   take-once lease   <who> <name>...          refresh Lease: on briefs <who> holds, so they don't go stale
//   take-once done    <name> <who> --status DONE|DONE_WITH_CONCERNS|BLOCKED [--report <file>]
//   take-once reclaim [--apply] [--json]       stale claims back to queue/ (dry run unless --apply)
//
// Shared options: --remote origin  --branch queue  --main <remote>/main  --stale-hours 3  --now <ISO>  --no-fetch
// Requires Node 22 and git. Every git call takes an argument array, never a shell string, because brief names come from
// the branch and the branch is written by agents.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BRIEF = /^(?:\d+-[^/]+|fix-[^/]+)\.md$/;
const DONE_OK = /^Status:\s*(DONE|DONE_WITH_CONCERNS)\s*$/;
const STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'];
const WHO = /^[a-z0-9][a-z0-9-]*$/;
const HEADER = /^([A-Z][A-Za-z ]*?):\s*(.*)$/;

class Fail extends Error {}

function parse(argv) {
  const o = { cmd: argv[0] || '', pos: [], remote: 'origin', branch: 'queue', main: '', staleHours: 3, now: Date.now(), fetch: true, only: '', apply: false, status: '', report: '', json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Fail(a + ' needs a value'); return argv[++i]; };
    if (a === '--remote') o.remote = v(); else if (a === '--branch') o.branch = v(); else if (a === '--main') o.main = v();
    else if (a === '--stale-hours') { o.staleHours = Number(v()); if (!(o.staleHours > 0)) throw new Fail('--stale-hours needs a positive number'); }
    else if (a === '--now') { o.now = Date.parse(v()); if (Number.isNaN(o.now)) throw new Fail('--now needs an ISO date'); }
    else if (a === '--no-fetch') o.fetch = false; else if (a === '--only') o.only = v(); else if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true; else if (a === '--status') o.status = v(); else if (a === '--report') o.report = v();
    else if (a.startsWith('--')) throw new Fail('unknown option ' + a);
    else o.pos.push(a);
  }
  if (!o.main) o.main = o.remote + '/main';
  o.ref = o.remote + '/' + o.branch;
  return o;
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const gitOk = (args, cwd) => spawnSync('git', args, { cwd, stdio: 'ignore', timeout: 120000 }).status === 0;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const idOf = (name) => (name.match(/^(\d+)-/) || [])[1] || name.replace(/\.md$/, '');

/* Two takes on one machine can fetch at the same moment and trip over git's ref lock, so a failed fetch gets two quiet
   retries before it counts. */
function fetchQueue(o) {
  for (let t = 0; t < 3; t++) {
    if (gitOk(['fetch', '-q', o.remote, `+refs/heads/${o.branch}:refs/remotes/${o.ref}`])) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 + Math.floor(Math.random() * 400));
  }
  throw new Fail(`cannot fetch ${o.branch} from ${o.remote}`);
}

/* "Key: value" lines before the first "## " heading; the first occurrence of a key wins. */
function headers(text) {
  const h = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) break;
    const m = line.match(HEADER);
    if (m && !(m[1] in h)) h[m[1]] = m[2].trim();
  }
  return h;
}
/* Rewrite the header block: drop lines matching `drop`, then add `add` after the last remaining header line. */
function setHeaders(text, drop, add) {
  const lines = text.split('\n'), end = lines.findIndex((l) => l.startsWith('## ')), stop = end < 0 ? lines.length : end, out = [];
  let last = 0;
  lines.forEach((l, i) => { if (i < stop && drop.test(l)) return; out.push(l); if (i < stop && HEADER.test(l)) last = out.length - 1; });
  out.splice(last + 1, 0, ...add);
  return out.join('\n');
}
const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
const blockersOf = (h) => (h['Blocked by'] || '').match(/\bfix-[a-z0-9-]+|\b\d+\b/g) || [];
const branchOf = (h) => ((h.Branch || '').match(/^([^\s(]+)/) || [])[1] || null;
const touchesOf = (h) => (h.Touches ? h.Touches.split(',').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean) : null);

/* Touches entries overlap when one equals or contains the other. A trailing / is a folder; * matches inside one folder. */
const globRe = (g) => new RegExp('^' + g.split('**').map((p) => p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*')).join('.*') + '(?:/.*)?$');
function overlap(a, b) {
  const A = a.replace(/\/$/, ''), B = b.replace(/\/$/, '');
  if (A.includes('*') || B.includes('*')) {
    const lit = (s) => s.split('*')[0];
    if (A.includes('*') && B.includes('*')) return lit(A).startsWith(lit(B)) || lit(B).startsWith(lit(A));
    const [g, p] = A.includes('*') ? [A, B] : [B, A];
    return globRe(g).test(p) || lit(g).startsWith(p + '/');
  }
  return A === B || B.startsWith(A + '/') || A.startsWith(B + '/');
}
const touchOverlap = (ta, tb) => !!(ta && tb) && ta.some((a) => tb.some((b) => overlap(a, b)));

/* Everything pick needs from the queue branch, read with plain git against the ref: never a checkout. */
function snapshot(o) {
  // Pin one commit: another take on this machine can move the ref between two reads.
  o = { ...o, ref: git(['rev-parse', '--verify', '-q', o.ref + '^{commit}']).trim() };
  const all = git(['ls-tree', '-r', '--name-only', o.ref, '--', 'queue/']).split('\n').filter((p) => /^queue\/(?:[^/]+\/)?[^/]+\.md$/.test(p));
  const text = new Map();
  if (all.length) {
    const out = execFileSync('git', ['cat-file', '--batch'], { input: all.map((p) => `${o.ref}:${p}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
    let at = 0;
    for (const p of all) {
      const nl = out.indexOf(10, at), head = out.toString('utf8', at, nl).split(' ');
      if (head[1] !== 'blob') throw new Fail('cannot read ' + p);
      const size = Number(head[2]); text.set(p, out.toString('utf8', nl + 1, nl + 1 + size)); at = nl + 1 + size + 1;
    }
  }
  const inDir = (dir) => all.filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/')).map((p) => p.slice(dir.length)).filter((n) => BRIEF.test(n));
  const open = inDir('queue/'), taken = inDir('queue/taken/'), done = inDir('queue/done/');
  const elsewhere = new Map(); // name -> folders other than queue/ that hold it
  for (const p of all) { const m = p.match(/^queue\/([^/]+)\/([^/]+)$/); if (m && BRIEF.test(m[2])) elsewhere.set(m[2], [...(elsewhere.get(m[2]) || []), m[1]]); }
  return { ref: o.ref, all, text, open, taken, done, elsewhere, read: (p) => text.get(p) };
}

function decider(o, s) {
  let heads = null;
  const remoteHead = (branch) => {
    if (!heads) {
      const r = spawnSync('git', ['ls-remote', '--heads', o.remote], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
      if (r.status !== 0) throw new Fail('ls-remote failed');
      heads = new Map(r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ref] = l.split('\t'); return [ref, sha]; }));
    }
    return heads.get('refs/heads/' + branch) || null;
  };
  let mainChecked = false;
  const merged = new Map();
  /* A branch counts as merged when its head is in main's history, or, once deleted, main has a "Merge branch '<b>'" commit.
     A main ref that won't resolve is an error, never "nothing is merged". */
  const isMerged = (branch) => {
    if (!mainChecked) {
      if (!gitOk(['rev-parse', '--verify', '-q', o.main + '^{commit}'])) throw new Fail('cannot resolve ' + o.main);
      mainChecked = true;
    }
    if (!merged.has(branch)) {
      const sha = remoteHead(branch);
      merged.set(branch, sha ? gitOk(['merge-base', '--is-ancestor', sha, o.main])
        : git(['log', '-1', '--format=%H', '--fixed-strings', '--grep', `Merge branch '${branch}'`, o.main, '--']).trim() !== '');
    }
    return merged.get(branch);
  };
  /* A blocker is met once a done report for it ends in DONE or DONE_WITH_CONCERNS and the branch it names is on main. */
  const blockerState = (b) => {
    const files = s.done.filter((f) => (b.startsWith('fix-') ? f === b + '.md' || f === b : idOf(f) === b))
      .filter((f) => DONE_OK.test(lastLine(s.read('queue/done/' + f))));
    if (!files.length) return 'open';
    for (const f of files) { const br = branchOf(headers(s.read('queue/done/' + f))); if (!br || isMerged(br)) return null; }
    return 'not-merged';
  };
  const takenTouches = s.taken.map((n) => ({ id: idOf(n), touches: touchesOf(headers(s.read('queue/taken/' + n))) }));

  function decide(name) {
    const row = { name, in: 'queue' }, res = (decision, reason) => Object.assign(row, { decision, reason });
    const also = s.elsewhere.get(name) || [];
    if (also.length) { row.error = 'two-places'; return res('skip', also.includes('done') ? 'already-done' : also.includes('taken') ? 'already-taken' : 'also-in:' + also[0]); }
    const h = headers(s.read('queue/' + name));
    row.touches = touchesOf(h) || 'none';
    for (const b of blockersOf(h)) {
      const st = blockerState(b);
      if (st) return res('wait', `blocked:${b}` + (st === 'not-merged' ? ':not-merged' : ''));
    }
    const hit = takenTouches.find((t) => touchOverlap(touchesOf(h), t.touches));
    if (hit) return res('wait', 'touches:' + hit.id);
    return res('take', 'ok');
  }

  /* A claim goes stale when its Lease (else Claimed, else the commit that took it) is older than the window and the branch
     it names has had no commit inside the window. Live work keeps pushing, so it never looks dead. */
  const limit = o.staleHours * 36e5;
  let tookAt = null;
  const takeCommit = (name) => {
    if (!tookAt) {
      tookAt = new Map(); let c = null;
      for (const l of git(['log', '--format=@%ct %s', '--name-only', o.ref, '--', 'queue/taken/']).split('\n')) {
        const m = l.match(/^@(\d+) (.*)$/);
        if (m) c = { t: Number(m[1]) * 1000, s: m[2] }; else if (l && c && !tookAt.has(l)) tookAt.set(l, c);
      }
    }
    return tookAt.get('queue/taken/' + name) || { t: 0, s: '' };
  };
  const branchTime = (branch, sha) => {
    const have = () => gitOk(['cat-file', '-e', sha + '^{commit}']);
    if (!have() && (!gitOk(['fetch', '-q', '--no-write-fetch-head', '--refmap=', o.remote, 'refs/heads/' + branch]) || !have())) throw new Fail('cannot fetch branch ' + branch);
    return Number(git(['log', '-1', '--format=%ct', sha]).trim()) * 1000;
  };
  function stale(name) {
    const h = headers(s.read('queue/taken/' + name)), when = (x) => { const t = Date.parse(x || ''); return Number.isNaN(t) ? 0 : t; };
    const [who, claimed] = (h.Claimed || '').split(/\s+/), took = takeCommit(name);
    const holder = (WHO.test(who || '') && who) || (took.s.match(/^take \S+ \(([a-z0-9-]+)\)$/) || [])[1] || 'unknown';
    const [kind, since] = when(h.Lease) ? ['leased', when(h.Lease)] : when(claimed) ? ['claimed', when(claimed)] : ['taken', took.t];
    if (o.now - since <= limit) return null;
    const branch = branchOf(h), row = { name, in: 'taken', decision: 'skip', since: iso(since), branch: branch || 'none' };
    try {
      const sha = branch && remoteHead(branch), pushed = sha ? branchTime(branch, sha) : 0;
      if (pushed) row.pushed = iso(pushed);
      if (pushed > o.now - limit) return null;
    } catch (e) { return Object.assign(row, { reason: 'stale-check-failed', error: e.message }); }
    row.why = `stale:${holder}: ${kind} ${row.since}, over ${o.staleHours} hours ago; ` + (branch ? `no push to ${branch} since` : 'no branch named');
    return Object.assign(row, { reason: 'stale:' + holder });
  }
  return { decide, stale };
}

const order = (a, b) => {
  const k = (n) => [n.startsWith('fix-') ? 0 : 1, /^\d+-/.test(n) ? Number(idOf(n)) : Infinity, n];
  const x = k(a), y = k(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

function pickRows(o) {
  const s = snapshot(o), d = decider({ ...o, ref: s.ref }, s);
  if (o.only) {
    if (!BRIEF.test(o.only)) return [{ name: o.only, in: 'none', decision: 'skip', reason: 'not-a-brief' }];
    if (s.open.includes(o.only)) return [d.decide(o.only)];
    const f = s.elsewhere.get(o.only) || [], at = f.includes('done') ? 'done' : f.includes('taken') ? 'taken' : f[0] || 'none';
    return [{ name: o.only, in: at, decision: 'skip', reason: at === 'done' ? 'already-done' : at === 'taken' ? 'already-taken' : 'not-in-queue' }];
  }
  return [...s.open.sort(order).map(d.decide), ...s.taken.sort(order).map(d.stale).filter(Boolean)];
}

/* Run `edit(worktree)` on a fresh copy of the queue branch, commit, and push without force. A rejected push throws the
   whole attempt away and starts again from a new fetch; nothing is ever rebased onto someone else's move. */
function commitToQueue(o, edit, tries = 5) {
  for (let t = 1; t <= tries; t++) {
    fetchQueue(o);
    const W = fs.mkdtempSync(path.join(os.tmpdir(), 'take-once-'));
    try {
      if (!gitOk(['worktree', 'add', '-q', '--detach', W, o.ref])) throw new Fail('worktree add failed');
      const msg = edit(W, t);
      if (msg === null) return null;
      git(['-C', W, 'add', '-A', '--', 'queue/']);
      git(['-C', W, 'commit', '-q', '-m', msg]);
      if (process.env.TAKE_ONCE_BEFORE_PUSH) spawnSync('/bin/sh', ['-c', process.env.TAKE_ONCE_BEFORE_PUSH], { stdio: 'ignore' });
      if (gitOk(['-C', W, 'push', '-q', o.remote, `HEAD:refs/heads/${o.branch}`])) return msg;
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', W], { stdio: 'ignore' });
      fs.rmSync(W, { recursive: true, force: true });
    }
  }
  throw new Fail('push kept being rejected');
}

class Stop extends Error { constructor(line, code) { super(line); this.line = line; this.code = code; } }

function take(o) {
  const [name, who] = o.pos;
  if (!name || !who) throw new Fail('usage: take-once take <name.md> <who>');
  if (!WHO.test(who)) throw new Fail('who must be lowercase letters, digits and hyphens');
  if (!BRIEF.test(name)) throw new Stop(`refuse ${name} not-a-brief`, 1);
  commitToQueue(o, (W, attempt) => {
    const row = pickRows({ ...o, ref: git(['-C', W, 'rev-parse', 'HEAD']).trim(), only: name })[0];
    if (row.decision !== 'take') {
      if (attempt > 1 && row.in !== 'queue') throw new Stop(`lost ${name}`, 1);
      throw new Stop(`refuse ${name} ${row.reason}`, 1);
    }
    const to = path.join(W, 'queue/taken', name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    git(['-C', W, 'mv', 'queue/' + name, 'queue/taken/' + name]);
    fs.writeFileSync(to, setHeaders(fs.readFileSync(to, 'utf8'), /^(Claimed|Lease):/, [`Claimed: ${who} ${iso(Date.now())}`]));
    return `take ${idOf(name)} (${who})`;
  });
  return { line: `took ${name}`, code: 0 };
}

function lease(o) {
  const [who, ...names] = o.pos;
  if (!who || !WHO.test(who) || !names.length) throw new Fail('usage: take-once lease <who> <name.md>...');
  let ids = [];
  const msg = commitToQueue(o, (W) => {
    ids = [];
    for (const n of names) {
      const f = path.join(W, 'queue/taken', n);
      if (!BRIEF.test(n) || !fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8'), holder = (headers(text).Claimed || '').split(/\s+/)[0];
      if (holder && holder !== who) continue;
      fs.writeFileSync(f, setHeaders(text, /^Lease:/, [`Lease: ${iso(Date.now())}`]));
      ids.push(n);
    }
    return ids.length ? `lease ${ids.map(idOf).join(' ')} (${who})` : null;
  });
  return { line: msg ? `leased ${ids.join(' ')}` : 'lease none', code: 0 };
}

function done(o) {
  const [name, who] = o.pos;
  if (!name || !who || !WHO.test(who) || !STATUSES.includes(o.status)) throw new Fail(`usage: take-once done <name.md> <who> --status ${STATUSES.join('|')} [--report <file>]`);
  const report = o.report ? fs.readFileSync(o.report, 'utf8').replace(/^Status:.*$/gm, '').trim() : '';
  commitToQueue(o, (W) => {
    const from = path.join(W, 'queue/taken', name);
    if (!fs.existsSync(from)) throw new Stop(`refuse ${name} not-taken`, 1);
    const holder = (headers(fs.readFileSync(from, 'utf8')).Claimed || '').split(/\s+/)[0];
    if (holder && holder !== who) throw new Stop(`refuse ${name} held-by:${holder}`, 1);
    if (fs.existsSync(path.join(W, 'queue/done', name))) throw new Stop(`refuse ${name} already-done`, 1);
    fs.mkdirSync(path.join(W, 'queue/done'), { recursive: true });
    git(['-C', W, 'mv', 'queue/taken/' + name, 'queue/done/' + name]);
    const to = path.join(W, 'queue/done', name);
    fs.writeFileSync(to, fs.readFileSync(to, 'utf8').trimEnd() + `\n\n## Report\n${report ? report + '\n' : ''}Status: ${o.status}\n`);
    return `done ${idOf(name)} (${who})`;
  });
  return { line: `done ${name} ${o.status}`, code: 0 };
}

function reclaim(o) {
  const due = pickRows(o).filter((r) => r.in === 'taken' && /^stale:/.test(r.reason));
  if (!o.apply || !due.length) return { rows: due.map((r) => ({ ...r, reclaim: o.apply ? 'none' : 'dry-run' })), code: 0 };
  commitToQueue(o, (W) => {
    for (const r of due) {
      const from = path.join(W, 'queue/taken', r.name), to = path.join(W, 'queue', r.name);
      if (!fs.existsSync(from)) throw new Fail(r.name + ' moved while reclaiming; run again');
      if (fs.existsSync(to)) throw new Fail(r.name + ' is also in queue/');
      const text = fs.readFileSync(from, 'utf8'), n = Number(headers(text).Attempt) || 1;
      git(['-C', W, 'mv', 'queue/taken/' + r.name, 'queue/' + r.name]);
      fs.writeFileSync(to, setHeaders(text, /^(Claimed|Lease|Attempt|Reclaimed):/, [`Attempt: ${n + 1}`, `Reclaimed: ${iso(o.now)} ${r.why}`]));
    }
    return `reclaim ${due.map((r) => idOf(r.name)).join(' ')} (stale)`;
  }, 1);
  return { rows: due.map((r) => ({ ...r, reclaim: 'done' })), code: 0 };
}

const EXAMPLE = `# 001 example
Blocked by: none
Touches: docs/
Branch: example (from main)

## Steps
1. Replace this file with a real task. Each task is one file in queue/, named like 002-short-name.md.
`;

/* Builds the first commit of the queue branch with plumbing, so the working tree and current branch are never touched,
   then pushes it without force. If the branch already exists, the push is not a fast-forward and git refuses it. */
function init(o) {
  const heads = spawnSync('git', ['ls-remote', '--heads', o.remote, o.branch], { encoding: 'utf8', timeout: 60000 });
  if (heads.status !== 0) throw new Fail(`cannot reach remote ${o.remote}`);
  if (heads.stdout.trim()) throw new Stop('refuse init queue-exists', 1);
  const mk = (args, input) => execFileSync('git', args, { input, encoding: 'utf8' }).trim();
  const blob = mk(['hash-object', '-w', '--stdin'], EXAMPLE);
  const inner = mk(['mktree'], `100644 blob ${blob}\t001-example.md\n`);
  const tree = mk(['mktree'], `040000 tree ${inner}\tqueue\n`);
  const commit = mk(['commit-tree', tree, '-m', 'init queue'], '');
  if (!gitOk(['push', '-q', o.remote, `${commit}:refs/heads/${o.branch}`])) throw new Stop('refuse init queue-exists', 1);
  return { line: `created branch ${o.branch} on ${o.remote} with queue/001-example.md`, code: 0 };
}

/* Readable by default: decision, name, reason in aligned columns. --json keeps one object per line for scripts. */
function printRows(o, rows, empty, line) {
  if (o.json) { for (const r of rows) process.stdout.write(JSON.stringify(r) + '\n'); return; }
  if (!rows.length) { process.stdout.write(empty + '\n'); return; }
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) process.stdout.write(line(r, w) + '\n');
}

function main(argv) {
  const o = parse(argv);
  if (o.cmd === 'pick') {
    if (o.fetch) { fetchQueue(o); gitOk(['fetch', '-q', o.remote, `+refs/heads/${o.main.slice(o.remote.length + 1)}:refs/remotes/${o.main}`]); }
    printRows(o, pickRows(o), 'nothing in the queue', (r, w) => `${r.decision.padEnd(4)}  ${r.name.padEnd(w)}  ${r.reason}`);
    return 0;
  }
  if (o.cmd === 'reclaim') {
    if (o.fetch) fetchQueue(o);
    const r = reclaim(o);
    const lead = o.apply ? 'reclaimed' : 'dry run: would reclaim';
    printRows(o, r.rows, 'nothing to reclaim', (x, w) => `${lead} ${x.name.padEnd(w)}  ${x.reason}`);
    return r.code;
  }
  const run = { init, take, lease, done }[o.cmd];
  if (!run) throw new Fail('usage: take-once init|pick|take|lease|done|reclaim (see the top of this file)');
  if (o.cmd === 'take' || o.cmd === 'done') gitOk(['fetch', '-q', o.remote, `+refs/heads/${o.main.slice(o.remote.length + 1)}:refs/remotes/${o.main}`]);
  const r = run(o);
  process.stdout.write(r.line + '\n');
  return r.code;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Stop) { process.stdout.write(e.line + '\n'); process.exitCode = e.code; }
  else { process.stderr.write('take-once: ' + (e instanceof Fail ? e.message : e.stack || e.message) + '\n'); process.exitCode = 2; }
}
