import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, jobIdOf, waitForJob, FAKE_AGY } from './helpers.mjs';

// F2 of the pool redesign: the companion, not the host model, picks model and
// account from live quota (`--model auto --class`), and a job that dies of
// quota moves to another account, then down its chain, by itself.

const posixOnly = { skip: process.platform === 'win32' };

/** One wrapper script per worker: they all run the same fake agy, and the
 *  wrapper tells it which worker it is (FAKE_AGY_ID). */
function workers(sb, numbers) {
  return numbers.map((n) => {
    const bin = path.join(sb.root, `agy${n}`);
    fs.writeFileSync(bin, `#!/bin/sh\nFAKE_AGY_ID=agy${n} exec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  });
}

const nowS = () => Date.now() / 1000;
function quota(sb, readings) {
  const dir = path.join(sb.root, 'quota-cache');
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
  return dir;
}

function envFor(sb, bins, dir, extra = {}) {
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    AGY_BIN: '', AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir,
    FAKE_AGY_RUNS_FILE: path.join(sb.root, 'runs.jsonl'), XDG_CONFIG_HOME: path.join(sb.root, 'xdg'),
    ...extra,
  };
}

function runs(sb) {
  const file = path.join(sb.root, 'runs.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function job(sb, id) {
  return JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff', 'state.json'), 'utf8')).jobs.find((j) => j.id === id);
}

describe('F2: routing', () => {
  test('--model auto routes a feature to the first chain model with an open pool', posixOnly, async () => {
    const sb = sandbox('f2-route-sonnet');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 100 }, 3: { thirdParty: 20 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /routing: class feature → claude-sonnet-4-6 on agy3 \(3p slack 80%\); chain claude-sonnet-4-6 → gemini-3\.1-pro-high/);
    const id = jobIdOf(r.stdout);
    await waitForJob(sb, id);
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy3', 'claude-sonnet-4-6']]);
  });

  test('with every 3p pool closed, a feature goes to Gemini 3.1 Pro high', posixOnly, async () => {
    const sb = sandbox('f2-route-gemini');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 100, gemini: 50 }, 3: { thirdParty: 99, gemini: 10 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /routing: class feature → gemini-3\.1-pro-high on agy3/);
  });

  test('nothing open: --model auto refuses and says when each pool reopens, with no job', posixOnly, () => {
    const sb = sandbox('f2-no-route');
    const bins = workers(sb, [2]);
    const dir = quota(sb, { 2: { thirdParty: 100, gemini: 100 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'x'], envFor(sb, bins, dir));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no open account for --class feature/);
    assert.match(r.stderr, /claude-sonnet-4-6 \(3p\): no account with ≥5% slack; next reopens in/);
    assert.equal(fs.existsSync(path.join(sb.repo, '.agy-staff', 'jobs')) && fs.readdirSync(path.join(sb.repo, '.agy-staff', 'jobs')).length, 0);
  });

  test('quota death on an auto worker moves the job to another account, same model', posixOnly, async () => {
    const sb = sandbox('f2-fallback-account');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 10 }, 3: { thirdParty: 40 } });
    const r = run(sb, ['implement', '--model', 'claude-sonnet-4-6', '--worker', 'auto', '--prompt', 'add a thing'],
      envFor(sb, bins, dir, { FAKE_AGY_QUOTA_FOR: 'agy2', FAKE_AGY_TOUCH_FILE: 'partial.txt' }));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id, { tries: 80 }), 'done');
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy2', 'claude-sonnet-4-6'], ['agy3', 'claude-sonnet-4-6']]);
    assert.match(runs(sb)[1].prompt, /stopped on quota exhaustion and left these paths changed[\s\S]*- partial\.txt/);
    const record = job(sb, id);
    assert.equal(record.worker.id, 'agy3');
    assert.equal(record.attempts.length, 1);
    const w = run(sb, ['wait', id], envFor(sb, bins, dir));
    assert.match(w.stdout, /## Routing\n1\. agy2\/claude-sonnet-4-6: quota_exhausted \(resets in 4h1m13s\), left 1 changed path\(s\)\n2\. agy3\/claude-sonnet-4-6: finished/);
  });

  test('a routed job steps down its chain when no account has its model open', posixOnly, async () => {
    const sb = sandbox('f2-fallback-chain');
    const bins = workers(sb, [2, 3]);
    // the job ends on Gemini; its F3 cross-review is covered elsewhere
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ auto_review: 'off' }));
    const dir = quota(sb, { 2: { thirdParty: 10, gemini: 90 }, 3: { thirdParty: 100, gemini: 10 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'],
      envFor(sb, bins, dir, { FAKE_AGY_QUOTA_FOR: 'agy2/claude-sonnet-4-6', FAKE_AGY_TOUCH_FILE: 'partial.txt' }));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id, { tries: 80 }), 'done');
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy2', 'claude-sonnet-4-6'], ['agy3', 'gemini-3.1-pro-high']]);
    assert.equal(job(sb, id).model, 'gemini-3.1-pro-high');
  });

  test('an explicitly named worker is never moved', posixOnly, async () => {
    const sb = sandbox('f2-explicit-stays');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: {}, 3: {} });
    const r = run(sb, ['implement', '--model', 'claude-sonnet-4-6', '--worker', 'agy2', '--prompt', 'x'],
      envFor(sb, bins, dir, { FAKE_AGY_QUOTA_FOR: 'agy2' }));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id, { tries: 80 }), 'quota_exhausted');
    assert.deepEqual(runs(sb).map(({ id: w }) => w), ['agy2']);
  });

  test('workers --suggest lists open options in chain order', posixOnly, () => {
    const sb = sandbox('f2-suggest');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 100, gemini: 30 }, 3: { thirdParty: 50, gemini: 10 } });
    const r = run(sb, ['workers', '--suggest', '--class', 'feature'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^class feature: claude-sonnet-4-6 → gemini-3\.1-pro-high\n1\. --model claude-sonnet-4-6 --worker agy3 {2}3p 50%.*\n2\. --model gemini-3\.1-pro-high --worker agy3 {2}gemini 90%.*\n3\. --model gemini-3\.1-pro-high --worker agy2 {2}gemini 70%/);
  });

  test('a project routing class overrides the default chain', posixOnly, () => {
    const sb = sandbox('f2-project-routing');
    const bins = workers(sb, [2]);
    const dir = quota(sb, { 2: {} });
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ routing: { feature: ['gemini-3.1-pro-high'] } }));
    const r = run(sb, ['workers', '--suggest', '--class', 'feature', '--json'], envFor(sb, bins, dir));
    assert.deepEqual(JSON.parse(r.stdout).chain, ['gemini-3.1-pro-high']);
  });

  test('mode is stored, shown, and marked on the status line', posixOnly, () => {
    const sb = sandbox('f2-mode');
    const bins = workers(sb, [2]);
    const dir = quota(sb, { 2: {} });
    const env = envFor(sb, bins, dir);
    assert.match(run(sb, ['mode'], env).stdout, /^mode: off\n/);
    assert.match(run(sb, ['mode', 'agy-first'], env).stdout, /^mode: agy-first \(set /);
    assert.match(run(sb, ['status', '--line'], env).stdout, /^agy\[agy-first\] gem 1\/1/);
    assert.equal(run(sb, ['mode', 'turbo'], env).code, 1);
  });

  test('--class with an explicit model, and --model auto on ask, are refused', () => {
    const sb = sandbox('f2-refusals');
    assert.match(run(sb, ['implement', '--model', 'claude-sonnet-4-6', '--class', 'feature', '--prompt', 'x']).stderr, /--class only applies to --model auto/);
    assert.match(run(sb, ['ask', '--model', 'auto', '--prompt', 'x']).stderr, /ask does not route/);
    assert.match(run(sb, ['implement', '--model', 'auto', '--class', 'nope', '--prompt', 'x']).stderr, /unknown --class "nope"/);
  });
});
