import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, run, COMPANION, FAKE_AGY } from './helpers.mjs';

// F4 of the pool redesign: the host writes plan.json and `run-spec` runs it as
// a DAG — one worktree and branch per task, prerequisites first, steps in one
// conversation, waiting for quota instead of failing — then reports, and
// finished jobs reach the session through the inbox hook.

const posixOnly = { skip: process.platform === 'win32' };
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'agy-hook.mjs');

function workers(sb, numbers) {
  return numbers.map((n) => {
    const bin = path.join(sb.root, `agy${n}`);
    fs.writeFileSync(bin, `#!/bin/sh\nFAKE_AGY_ID=agy${n} exec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  });
}

const nowS = () => Date.now() / 1000;
function quota(dir, readings) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, { gemini = 10, thirdParty = 10 }] of Object.entries(readings)) {
    fs.writeFileSync(path.join(dir, `agy-quota-profile${n}.json`), JSON.stringify({
      captured_at: nowS(),
      buckets: {
        'gemini 5h': { used_percent: gemini, resets_at: nowS() + 3600 },
        'gemini 7d': { used_percent: gemini, resets_at: nowS() + 86400 },
        '3p 5h': { used_percent: thirdParty, resets_at: nowS() + 3600 },
        '3p 7d': { used_percent: thirdParty, resets_at: nowS() + 7200 },
      },
    }));
  }
}

/** Worktrees branch from a commit; a fresh sandbox has none. */
function commitOnce(sb) {
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: sb.repo }).status === 0) return;
  fs.writeFileSync(path.join(sb.repo, 'README.md'), 'seed\n');
  execFileSync('git', ['add', 'README.md'], { cwd: sb.repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], { cwd: sb.repo });
}

function plan(sb, value) {
  commitOnce(sb);
  const file = path.join(sb.root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...value }));
  return file;
}

function envFor(sb, bins, extra = {}) {
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    AGY_BIN: '', AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: path.join(sb.root, 'quota-cache'),
    FAKE_AGY_RUNS_FILE: path.join(sb.root, 'runs.jsonl'), FAKE_AGY_TOUCH_FILE: 'out.txt', FAKE_AGY_TOUCH_UNIQUE: '1', FAKE_AGY_SLEEP_MS: '50',
    ...extra,
  };
}

const runId = (stdout) => /Started run (\S+):/.exec(stdout)?.[1];

function prompts(sb) {
  const file = path.join(sb.root, 'runs.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function runInternal(sb, id, env = {}) {
  return spawnSync(process.execPath, [COMPANION, '_run', id], {
    cwd: sb.repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, XDG_CONFIG_HOME: '', ...env },
  });
}

function savedTask({ id = 'a', worktreePath = null } = {}) {
  return {
    id, title: null, mode: 'implement', model: 'gemini-3.8-flash-high', class: null,
    depends_on: [], steps: [{ prompt: 'A', gates: [] }], timeout: null, worker: null,
    status: 'pending', step: 0, job: null, branch: null, worktree: null, worktree_path: worktreePath,
    status_line: null, note: null,
  };
}

function writeRunState(sb, id, task, { worktreeSetup = null } = {}) {
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sb.repo, encoding: 'utf8' }).trim();
  const dir = path.join(sb.repo, '.agy-staff', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    id, name: id, plan_file: null, root: sb.repo, base, status: 'running', max_parallel: 1,
    worktree_setup: worktreeSetup, started_at: new Date().toISOString(), pid: null,
    tasks: { [task.id]: task },
  }, null, 2));
}

describe('F4: run-spec', () => {
  test('--dry-run prints the waves; an invalid plan lists every problem at once', () => {
    const sb = sandbox('f4-dry');
    const good = plan(sb, { name: 'demo', tasks: [
      { id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high' },
      { id: 'b', prompt: 'B', depends_on: ['a'], model: 'gemini-3.8-flash-high' },
      { id: 'c', prompt: 'C', model: 'gemini-3.8-flash-high' },
    ] });
    const r = run(sb, ['run-spec', good, '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wave 1: a, c\n {2}wave 2: b/);
    const bad = plan(sb, { tasks: [
      { id: 'x', depends_on: ['y'], prompt: 'X' },
      { id: 'y', depends_on: ['x'] },
      { id: 'z', depends_on: ['nope'], prompt: 'Z', model: 'm', class: 'feature', worktree: '' },
    ] });
    const e = run(sb, ['run-spec', bad, '--dry-run']);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /tasks\[1\] \(y\) step 1: needs "prompt" or "prompt_file"/);
    assert.match(e.stderr, /depends on unknown task "nope"/);
    assert.match(e.stderr, /give "model" or "class", not both/);
    assert.match(e.stderr, /"worktree" must be a non-empty string/);
    assert.match(e.stderr, /dependency cycle: x → y → x|dependency cycle: y → x → y/);
  });

  test('a run builds each task in its own branch, prerequisites first, steps in one conversation', posixOnly, async () => {
    const sb = sandbox('f4-run');
    const bins = workers(sb, [2, 3]);
    quota(path.join(sb.root, 'quota-cache'), { 2: {}, 3: {} });
    const file = plan(sb, { name: 'demo', tasks: [
      { id: 'a', title: 'first', prompt: 'build A', model: 'gemini-3.8-flash-high', worker: 'agy2' },
      { id: 'b', prompt: 'build B', depends_on: ['a'], model: 'gemini-3.8-flash-high', worker: 'agy2' },
      { id: 'c', model: 'gemini-3.8-flash-high', worker: 'agy3', steps: [{ prompt: 'C part 1' }, { prompt: 'C part 2' }] },
    ] });
    const env = envFor(sb, bins, { FAKE_AGY_REVIEW_RESPONSE: '{}' });
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off' }));
    const r = run(sb, ['run-spec', file], env);
    assert.equal(r.code, 0, r.stderr);
    const id = runId(r.stdout);
    const defaultWorktree = path.join(sb.home, '.config', 'agy-staff', 'worktrees', path.basename(sb.repo), 'agy', id, 'a');
    const waited = run(sb, ['run-wait', id, '--timeout', '90s'], env);
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
    assert.ok(fs.existsSync(defaultWorktree), 'the default worktree is outside the repository');
    assert.ok(!fs.existsSync(path.join(sb.repo, '.agy-staff', 'worktrees', id)), 'no default worktree is created under the repository state directory');
    assert.ok(r.stdout.includes(defaultWorktree), 'the start message reports the actual worktree location');
    assert.ok(waited.stdout.includes(defaultWorktree), 'the cleanup report reports the actual worktree location');
    assert.match(waited.stdout, /3\/3 task\(s\) done/);
    assert.match(waited.stdout, new RegExp(`git merge --no-ff agy/${id}/a\\ngit merge --no-ff agy/${id}/c\\ngit merge --no-ff agy/${id}/b`));
    const log = execFileSync('git', ['log', '--format=%s', `agy/${id}/b`], { cwd: sb.repo, encoding: 'utf8' });
    assert.match(log, /^agy\(b\)\nagy\(a\): first\n/);
    const seen = prompts(sb).map((entry) => entry.prompt);
    assert.ok(seen.some((p) => /C part 1/.test(p)) && seen.some((p) => /C part 2/.test(p)));
    const inbox = fs.readFileSync(path.join(sb.home, '.config', 'agy-staff', 'inbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const repo = fs.realpathSync(sb.repo);
    assert.ok(inbox.some((entry) => entry.run === id && entry.repo === repo && /3\/3 done/.test(entry.line)));
    assert.equal(inbox.filter((entry) => entry.job && entry.repo === repo).length, 4, 'every job reports to the main checkout');
  });

  test('a failed prerequisite blocks its dependents', posixOnly, () => {
    const sb = sandbox('f4-blocked');
    const bins = workers(sb, [2]);
    quota(path.join(sb.root, 'quota-cache'), { 2: {} });
    const file = plan(sb, { tasks: [
      { id: 'a', prompt: 'A', model: 'claude-sonnet-4-6', worker: 'agy2' },
      { id: 'b', prompt: 'B', depends_on: ['a'], model: 'claude-sonnet-4-6', worker: 'agy2' },
    ] });
    const env = envFor(sb, bins, { FAKE_AGY_QUOTA_FOR: 'agy2' });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    const waited = run(sb, ['run-wait', id, '--timeout', '60s'], env);
    assert.equal(waited.code, 5);
    assert.match(waited.stdout, /- a: failed — STATUS: QUOTA_EXHAUSTED/);
    assert.match(waited.stdout, /- b: blocked — prerequisite a is failed/);
  });

  test('worktree_root from config uses the repository name placeholder', posixOnly, () => {
    const sb = sandbox('f4-worktree-root');
    const root = '~/shared/{repo}';
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off', worktree_root: root }));
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high' }] });
    const env = envFor(sb, [], { AGY_BIN: FAKE_AGY });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    const waited = run(sb, ['run-wait', id, '--timeout', '60s'], env);
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
    assert.ok(fs.existsSync(path.join(sb.home, 'shared', path.basename(sb.repo), 'agy', id, 'a')));
  });

  test('a relative task worktree is resolved against the plan folder, not the cwd', posixOnly, () => {
    const sb = sandbox('f4-worktree-relative');
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off' }));
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high', worktree: 'rel/wt-a' }] });
    const env = envFor(sb, [], { AGY_BIN: FAKE_AGY });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    assert.equal(run(sb, ['run-wait', id, '--timeout', '60s'], env).code, 0);
    assert.ok(fs.existsSync(path.join(path.dirname(file), 'rel', 'wt-a')), 'next to the plan');
    assert.ok(!fs.existsSync(path.join(sb.repo, 'rel')), 'not under the cwd');
  });

  test('a run started from a linked worktree names the main repository in the default location', posixOnly, () => {
    const sb = sandbox('f4-worktree-from-linked');
    commitOnce(sb);
    const linked = path.join(sb.root, 'linked-checkout');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: sb.repo });
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high' }] });
    const env = { ...process.env, HOME: sb.home, XDG_CONFIG_HOME: '', AGY_POOL_BINS: '', FAKE_AGY_ARGV_FILE: sb.argvFile,
      ...envFor(sb, [], { AGY_BIN: FAKE_AGY }) };
    const started = spawnSync(process.execPath, [COMPANION, 'run-spec', file], { cwd: linked, env, encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    const id = runId(started.stdout);
    const expected = path.join(sb.home, '.config', 'agy-staff', 'worktrees', path.basename(sb.repo), 'agy', id, 'a');
    assert.match(started.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!started.stdout.includes(path.join('worktrees', 'linked-checkout')));
    spawnSync(process.execPath, [COMPANION, 'run-wait', id, '--timeout', '60s'], { cwd: linked, env, encoding: 'utf8' });
  });

  test('a task worktree overrides worktree_root and is retained as worktree_path', posixOnly, () => {
    const sb = sandbox('f4-worktree-override');
    const root = path.join(sb.root, 'shared');
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off', worktree_root: root }));
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high', worktree: '~/task-worktree' }] });
    const env = envFor(sb, [], { AGY_BIN: FAKE_AGY });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    const waited = run(sb, ['run-wait', id, '--timeout', '60s'], env);
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff', 'runs', id, 'state.json'), 'utf8'));
    const expected = path.join(sb.home, 'task-worktree');
    assert.equal(state.tasks.a.worktree_path, expected);
    assert.equal(state.tasks.a.worktree, expected);
    assert.ok(fs.existsSync(expected));
    assert.ok(!fs.existsSync(path.join(root, 'agy', id, 'a')));
  });

  test('a registered matching worktree is reused and still receives setup files', posixOnly, () => {
    const sb = sandbox('f4-reuse-worktree');
    commitOnce(sb);
    const id = 'run-reuse';
    const branch = `agy/${id}/a`;
    const worktree = path.join(sb.root, 'existing-worktree');
    fs.writeFileSync(path.join(sb.repo, '.env'), 'TEST_VALUE=1\n');
    execFileSync('git', ['worktree', 'add', '-qb', branch, worktree, 'HEAD'], { cwd: sb.repo });
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'do not replace\n');
    writeRunState(sb, id, savedTask({ worktreePath: worktree }), { worktreeSetup: 'touch worktree-setup-ran' });
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off' }));
    const result = runInternal(sb, id, { AGY_BIN: FAKE_AGY, FAKE_AGY_SLEEP_MS: '50', FAKE_AGY_TOUCH_FILE: 'out.txt', FAKE_AGY_TOUCH_UNIQUE: '1' });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff', 'runs', id, 'state.json'), 'utf8'));
    assert.equal(state.tasks.a.status, 'done', JSON.stringify(state.tasks.a));
    assert.equal(state.tasks.a.worktree, worktree);
    assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'do not replace\n');
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'TEST_VALUE=1\n');
    assert.ok(fs.existsSync(path.join(worktree, 'worktree-setup-ran')));
  });

  test('an unrelated directory at a requested worktree path fails without deletion', posixOnly, () => {
    const sb = sandbox('f4-worktree-collision');
    const worktree = path.join(sb.root, 'not-a-worktree');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, 'keep.txt'), 'keep\n');
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', model: 'gemini-3.8-flash-high', worktree }] });
    const env = envFor(sb, [], { AGY_BIN: FAKE_AGY });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    const waited = run(sb, ['run-wait', id, '--timeout', '60s'], env);
    assert.equal(waited.code, 5, waited.stdout + waited.stderr);
    assert.match(waited.stdout, /worktree path already exists and is not registered on agy\//);
    assert.equal(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8'), 'keep\n');
  });

  test('a routed task with no open account waits for quota instead of failing', posixOnly, async () => {
    const sb = sandbox('f4-wait-quota');
    const bins = workers(sb, [2]);
    const cache = path.join(sb.root, 'quota-cache');
    quota(cache, { 2: { thirdParty: 100, gemini: 100 } });
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off' }));
    const file = plan(sb, { tasks: [{ id: 'a', prompt: 'A', class: 'feature' }] });
    const env = envFor(sb, bins, { AGY_RUN_QUOTA_RETRY_MS: '300' });
    const id = runId(run(sb, ['run-spec', file], env).stdout);
    const state = () => JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff', 'runs', id, 'state.json'), 'utf8'));
    for (let i = 0; i < 100 && state().tasks.a.status !== 'waiting_quota'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(state().tasks.a.status, 'waiting_quota');
    quota(cache, { 2: { thirdParty: 10 } });
    const waited = run(sb, ['run-wait', id, '--timeout', '60s'], env);
    assert.equal(waited.code, 0, waited.stdout);
    assert.deepEqual(prompts(sb).map((entry) => entry.model), ['claude-sonnet-4-6']);
  });

  test('the prompt hook delivers unread jobs once, then the mode and pool line', posixOnly, async () => {
    const sb = sandbox('f4-hook');
    commitOnce(sb);
    const bins = workers(sb, [2]);
    quota(path.join(sb.root, 'quota-cache'), { 2: {} });
    const env = envFor(sb, bins);
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--worker', 'agy2', '--prompt', 'look'], env);
    const job = /job id: (\S+)/.exec(started.stdout)[1];
    run(sb, ['wait', job, '--timeout', '30s'], env);
    const hook = (event) => spawnSync(process.execPath, [HOOK, event], {
      input: JSON.stringify({ cwd: sb.repo }), encoding: 'utf8', env: { ...process.env, HOME: sb.home, XDG_CONFIG_HOME: '', ...env },
    });
    const first = hook('prompt');
    const context = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, new RegExp(`1 finished since you last looked — ${job} research DONE worker=agy2 model=gemini-3\\.8-flash-high → \`result ${job}\``));
    assert.equal(hook('prompt').stdout, '', 'cooldown, and nothing unread');
    run(sb, ['mode', 'agy-first'], env);
    const session = hook('session');
    assert.match(JSON.parse(session.stdout).hookSpecificOutput.additionalContext, /delegation mode agy-first[\s\S]*pool: gemini open on 1\/1/);
  });
});
