import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, run, jobIdOf, waitForJob, agyCalls } from './helpers.mjs';

// F1 of the pool redesign (evals/2026-10-10-agy-pool-marketplace-br.md): the
// orchestrator dispatched blind because quota readings were stale or wrong,
// learned a job died of quota only by grepping its JSON, and lost agy8..agy10.

function workersFor(sb, numbers) {
  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agy.mjs');
  return numbers.map((n) => {
    const bin = path.join(sb.root, `agy${n}`);
    fs.symlinkSync(fake, bin);
    return bin;
  });
}

function quotaCache(sb, entries) {
  const dir = path.join(sb.root, 'quota-cache');
  fs.mkdirSync(dir, { recursive: true });
  for (const [profile, value] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dir, `agy-quota-${profile}.json`), JSON.stringify(value));
  }
  return dir;
}

// Discovery scans PATH for agy4..agy20. Without a closed PATH it finds the
// real profiles of the machine running the suite, and `--probe` pings them —
// it did, once, while this file was written. Node stays reachable for the fake
// agy's shebang; git for the sandbox repo.
const ISOLATED = {
  PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
  AGY_BIN: '',
};
const env = (extra) => ({ ...ISOLATED, ...extra });

const nowS = () => Date.now() / 1000;
const reading = ({ ageS = 60, gemini = [10, 10], thirdParty = [0, 100], weeklyResetS = 30 * 3600 } = {}) => ({
  captured_at: nowS() - ageS,
  buckets: {
    'gemini 5h': { used_percent: gemini[0], resets_at: nowS() + 3600 },
    'gemini 7d': { used_percent: gemini[1], resets_at: nowS() + 5 * 86400 },
    '3p 5h': { used_percent: thirdParty[0], resets_at: nowS() + 3600 },
    '3p 7d': { used_percent: thirdParty[1], resets_at: nowS() + weeklyResetS },
  },
});

describe('F1: quota truth', () => {
  test('status --line counts open accounts per pool and says when 3p reopens', () => {
    const sb = sandbox('f1-line');
    const bins = workersFor(sb, [2, 3]);
    const dir = quotaCache(sb, {
      profile2: reading({ weeklyResetS: 2 * 3600 }),
      profile3: reading({ thirdParty: [10, 10] }),
    });
    const r = run(sb, ['status', '--line'], env({ AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^agy gem 2\/2 · 3p 1\/2 ↻(1h59m|2h00m)\n$/);
    assert.equal(agyCalls(sb).length, 0, 'status --line must not start agy');
  });

  test('status --json reports open workers, the next reopen and stale readings', () => {
    const sb = sandbox('f1-json');
    const bins = workersFor(sb, [2, 3]);
    const dir = quotaCache(sb, { profile2: reading(), profile3: reading({ ageS: 3600 }) });
    const r = run(sb, ['status', '--json'], env({ AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir }));
    assert.equal(r.code, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.gemini.open_workers, ['agy2', 'agy3']);
    assert.deepEqual(summary.third_party.open_workers, []);
    assert.ok(summary.third_party.next_reopen_in_seconds > 29 * 3600);
    assert.deepEqual(summary.stale, ['agy3']);
    assert.equal(summary.workers[0].third_party.slack_percent, 0);
  });

  test('workers --probe pings only stale accounts, with the flash-low model', () => {
    const sb = sandbox('f1-probe');
    const bins = workersFor(sb, [2, 3]);
    const dir = quotaCache(sb, { profile2: reading(), profile3: reading({ ageS: 3600 }) });
    const r = run(sb, ['workers', '--probe'], env({ AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^probe agy3: ok in \d+s$/m);
    assert.doesNotMatch(r.stderr, /probe agy2/);
    const pings = agyCalls(sb).filter((argv) => argv.includes('-p'));
    assert.equal(pings.length, 1);
    assert.equal(pings[0][pings[0].indexOf('--model') + 1], 'gemini-3.8-flash-low');
    assert.match(r.stdout, /^agy2 \|/m);
  });

  test('workers shows when a closed pool reopens', () => {
    const sb = sandbox('f1-reset-cell');
    const bins = workersFor(sb, [2]);
    const dir = quotaCache(sb, { profile2: reading({ weeklyResetS: 3 * 3600 + 120 }) });
    const r = run(sb, ['workers'], env({ AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /agy2 .*\| 90% \(1m\) \| 0% \(1m\) ↻3h0[12]m$/m);
  });

  test('wait ends a quota death with one STATUS line on stderr', async () => {
    const sb = sandbox('f1-status-quota');
    const started = run(sb, ['research', '--prompt', 'a topic'], {
      FAKE_AGY_QUOTA: '1', FAKE_AGY_RESPONSE: '', FAKE_AGY_QUOTA_RESETS: '4h1m13s',
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');
    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 6);
    assert.match(w.stderr, /^STATUS: QUOTA_EXHAUSTED worker=\S+ model=gemini-3\.8-flash-high reset=4h1m13s partial_files=\d+$/m);
    assert.doesNotMatch(w.stdout, /^STATUS:/m, 'stdout keeps its shape');
  });

  test('a clean done job prints no STATUS line', async () => {
    const sb = sandbox('f1-status-done');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 0);
    assert.doesNotMatch(w.stderr, /STATUS:/);
  });

  test('--help works on every subcommand, including run commands with no task', () => {
    const sb = sandbox('f1-help');
    for (const cmd of ['implement', 'continue', 'wait', 'workers', 'status']) {
      const r = run(sb, [cmd, '--help']);
      assert.equal(r.code, 0, `${cmd}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`^usage: agy-companion\\.mjs ${cmd}`));
    }
    assert.match(run(sb, ['continue', '--help']).stdout, /--job <value>/);
    assert.match(run(sb, ['--help']).stdout, /workers \[--probe\] \[--json\]/);
  });

  test('--worker naming an undiscovered profile says so, not "at capacity"', () => {
    const sb = sandbox('f1-not-found');
    const bins = workersFor(sb, [4]);
    const r = run(sb, ['research', '--worker', 'agy9', '--prompt', 'x'], env({ AGY_POOL_BINS: bins.join(',') }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /worker "agy9" was not discovered \(known: [^)]*agy4/);
    assert.doesNotMatch(r.stderr, /at capacity/);
  });
});
