import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, run, FAKE_AGY } from './helpers.mjs';

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
      { id: 'z', depends_on: ['nope'], prompt: 'Z', model: 'm', class: 'feature' },
    ] });
    const e = run(sb, ['run-spec', bad, '--dry-run']);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /tasks\[1\] \(y\) step 1: needs "prompt" or "prompt_file"/);
    assert.match(e.stderr, /depends on unknown task "nope"/);
    assert.match(e.stderr, /give "model" or "class", not both/);
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
    const waited = run(sb, ['run-wait', id, '--timeout', '90s'], env);
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
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
