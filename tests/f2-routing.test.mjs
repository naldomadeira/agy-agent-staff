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
// What `agy models` lists on the profiles before 11, and on 11–13 (Argon and
// the 5.5 Claude ids). A reading with `argon` is a profile of the second kind.
const OLD_CATALOG = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
const NEW_CATALOG = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium'];
function quota(sb, readings) {
  const dir = path.join(sb.root, 'quota-cache');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, { gemini = 10, thirdParty = 10, argon }] of Object.entries(readings)) {
    const catalog = argon === undefined ? OLD_CATALOG : NEW_CATALOG;
    fs.writeFileSync(path.join(dir, `agy-models-profile${n}.json`), JSON.stringify({
      captured_at: nowS(), models: catalog.map((id) => ({ id, name: id })) }));
    fs.writeFileSync(path.join(dir, `agy-quota-profile${n}.json`), JSON.stringify({
      captured_at: nowS(),
      buckets: {
        'gemini 5h': { used_percent: gemini, resets_at: nowS() + 3600 },
        'gemini 7d': { used_percent: gemini, resets_at: nowS() + 86400 },
        '3p 5h': { used_percent: thirdParty, resets_at: nowS() + 3600 },
        '3p 7d': { used_percent: thirdParty, resets_at: nowS() + 7200 },
        ...(argon === undefined ? {} : { 'gemini-argon-wtu-weekly': { used_percent: argon, resets_at: nowS() + 86400 } }),
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
    assert.match(r.stdout, /routing: class feature → claude-sonnet-4-6 on agy3 \(3p slack 80%\); chain claude-sonnet-5-5-medium → gemini-4-argon-high → claude-sonnet-4-6/);
    const id = jobIdOf(r.stdout);
    await waitForJob(sb, id);
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy3', 'claude-sonnet-4-6']]);
  });

  test('with every 3p pool closed, a feature goes to the Argon on the profile that has it', posixOnly, async () => {
    const sb = sandbox('f2-route-argon');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 100, gemini: 50 }, 3: { thirdParty: 99, gemini: 10, argon: 20 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /routing: class feature → gemini-4-argon-high on agy3 \(argon slack 80%\)/);
  });

  test('a closed Argon is not routed to even with Flash wide open, and a profile without it is never eligible', posixOnly, () => {
    const sb = sandbox('f2-argon-closed');
    const bins = workers(sb, [2, 3]);
    // agy3 has the Argon but spent it (Flash and 3p are open); agy2 is an old profile.
    const dir = quota(sb, { 2: { thirdParty: 100, gemini: 0 }, 3: { thirdParty: 100, gemini: 0, argon: 100 } });
    const r = run(sb, ['implement', '--model', 'auto', '--class', 'review', '--prompt', 'x'], envFor(sb, bins, dir));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gemini-4-argon-high \(argon\): no account with ≥5% slack; next reopens in .*; not in the catalog of: agy2/);
  });

  test('a job that dies of quota on the Argon closes that account\'s Argon for the next route', posixOnly, async () => {
    const sb = sandbox('f2-argon-death');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 10 }, 3: { thirdParty: 100, argon: 10 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'],
      envFor(sb, bins, dir, { FAKE_AGY_QUOTA_FOR: 'agy3/gemini-4-argon-high', FAKE_AGY_TOUCH_FILE: 'partial.txt' }));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id, { tries: 80 }), 'done');
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy3', 'gemini-4-argon-high'], ['agy2', 'claude-sonnet-4-6']]);
    const reading = JSON.parse(fs.readFileSync(path.join(dir, 'agy-staff-argon-profile3.json'), 'utf8'));
    assert.equal(reading.open, false);
    assert.ok(reading.reopens_at * 1000 - Date.now() > 4 * 3600_000, 'reopens at the "Resets in 4h1m13s" AGY printed');
    const table = run(sb, ['workers', '--json'], envFor(sb, bins, dir));
    const agy3 = JSON.parse(table.stdout).find((w) => w.id === 'agy3');
    assert.equal(agy3.argon.slack_percent, 0);
    assert.ok(agy3.argon.blocked_until);
  });

  test('an explicit Argon model with --worker auto only considers profiles that have it', posixOnly, async () => {
    const sb = sandbox('f2-argon-explicit');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: {}, 3: { argon: 10 } });
    const r = run(sb, ['staffer', '--model', 'gemini-4-argon-low', '--worker', 'auto', '--prompt', 'x'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout), { tries: 80 });
    assert.deepEqual(runs(sb).map(({ id: w }) => w), ['agy3']);
  });

  test('every default class chain names only models that exist in some profile catalog', posixOnly, () => {
    const sb = sandbox('f2-chains-exist');
    const bins = workers(sb, [2, 11]);
    const dir = quota(sb, { 2: {}, 11: { argon: 10 } });
    const exists = new Set([...OLD_CATALOG, ...NEW_CATALOG]);
    const expected = {
      feature: ['claude-sonnet-5-5-medium', 'gemini-4-argon-high', 'claude-sonnet-4-6'],
      review: ['gemini-4-argon-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-4-6'],
      research: ['gemini-3.8-flash-high', 'gemini-4-argon-medium'],
      mechanical: ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
      design: ['claude-opus-5-5-high', 'claude-opus-4-6-thinking'],
    };
    for (const [routeClass, chain] of Object.entries(expected)) {
      const r = run(sb, ['workers', '--suggest', '--class', routeClass, '--json'], envFor(sb, bins, dir));
      assert.equal(r.code, 0, r.stderr);
      const got = JSON.parse(r.stdout).chain;
      assert.deepEqual(got, chain, routeClass);
      for (const model of got) assert.ok(exists.has(model), `${routeClass}: ${model} is in no catalog`);
    }
  });

  test('naming the retired gemini-3.1-pro is an error that lists the models that exist', posixOnly, () => {
    const sb = sandbox('f2-retired-pro');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: {}, 3: { argon: 10 } });
    for (const model of ['gemini-3.1-pro-high', 'gemini-3.1-pro', 'pro']) {
      const r = run(sb, ['ask', '--model', model, '--prompt', 'x'], envFor(sb, bins, dir));
      assert.equal(r.code, 1, model);
      assert.match(r.stderr, /no longer exists/);
      assert.match(r.stderr, /gemini-4-argon-high/);
      assert.match(r.stderr, /claude-sonnet-5-5-medium/);
      assert.match(r.stderr, /claude-sonnet-4-6/);
    }
    // the same error comes from a project chain that still names it
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ routing: { feature: ['gemini-3.1-pro-low'] } }));
    const chain = run(sb, ['workers', '--suggest', '--class', 'feature'], envFor(sb, bins, dir));
    assert.equal(chain.code, 1);
    assert.match(chain.stderr, /no longer exists/);
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
    const dir = quota(sb, { 2: { thirdParty: 10, gemini: 90 }, 3: { thirdParty: 10, gemini: 10, argon: 10 } });
    const r = run(sb, ['implement', '--model', 'auto', '--prompt', 'add a thing'],
      envFor(sb, bins, dir, { FAKE_AGY_QUOTA_FOR: 'agy3/claude-sonnet-5-5-medium', FAKE_AGY_TOUCH_FILE: 'partial.txt' }));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id, { tries: 80 }), 'done');
    assert.deepEqual(runs(sb).map(({ id: w, model }) => [w, model]), [['agy3', 'claude-sonnet-5-5-medium'], ['agy3', 'gemini-4-argon-high']]);
    assert.equal(job(sb, id).model, 'gemini-4-argon-high');
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

  test('workers --suggest lists open options in chain order, by catalog and family', posixOnly, () => {
    const sb = sandbox('f2-suggest');
    const bins = workers(sb, [2, 3]);
    const dir = quota(sb, { 2: { thirdParty: 50, gemini: 30 }, 3: { thirdParty: 50, gemini: 10, argon: 20 } });
    const r = run(sb, ['workers', '--suggest', '--class', 'feature'], envFor(sb, bins, dir));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^class feature: claude-sonnet-5-5-medium → gemini-4-argon-high → claude-sonnet-4-6\n1\. --model claude-sonnet-5-5-medium --worker agy3 {2}3p 50%.*\n2\. --model gemini-4-argon-high --worker agy3 {2}argon 80%.*\n3\. --model claude-sonnet-4-6 --worker agy2 {2}3p 50%/);
  });

  test('a project routing class overrides the default chain', posixOnly, () => {
    const sb = sandbox('f2-project-routing');
    const bins = workers(sb, [2]);
    const dir = quota(sb, { 2: {} });
    fs.mkdirSync(path.join(sb.repo, '.agy-staff'), { recursive: true });
    fs.writeFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), JSON.stringify({ routing: { feature: ['gemini-3.8-flash-high'] } }));
    const r = run(sb, ['workers', '--suggest', '--class', 'feature', '--json'], envFor(sb, bins, dir));
    assert.deepEqual(JSON.parse(r.stdout).chain, ['gemini-3.8-flash-high']);
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
