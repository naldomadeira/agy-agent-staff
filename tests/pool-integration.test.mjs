import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, jobIdOf, waitForJob, agyCalls, FAKE_AGY } from './helpers.mjs';

function workersFor(sb, count = 2) {
  const bins = [];
  for (let i = 2; i <= count + 1; i++) {
    const bin = path.join(sb.root, `agy${i}`);
    fs.symlinkSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-agy.mjs'), bin);
    bins.push(bin);
  }
  return bins;
}

function state(sb) {
  return JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff', 'state.json'), 'utf8'));
}

describe('companion worker pool integration', () => {
  test('workers command reports configured and discovered workers', () => {
    const sb = sandbox('workers-command');
    const bins = workersFor(sb, 2);
    const result = run(sb, ['workers'], { AGY_POOL_BINS: bins.join(',') });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /id \| executable \| status \| version \| capacity \| active jobs/);
    assert.match(result.stdout, /agy2.*available/);
    assert.match(result.stdout, /agy3.*available/);
  });

  test('auto dispatches across two workers and persists the selected worker', async () => {
    const sb = sandbox('auto-two');
    const bins = workersFor(sb, 2);
    const env = { AGY_POOL_BINS: bins.join(','), FAKE_AGY_SLEEP_MS: '2000' };
    const first = run(sb, ['research', '--worker', 'auto', '--prompt', 'first'], env);
    const second = run(sb, ['research', '--worker', 'auto', '--prompt', 'second'], env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const firstId = jobIdOf(first.stdout);
    const secondId = jobIdOf(second.stdout);
    const records = state(sb).jobs.filter((job) => [firstId, secondId].includes(job.id));
    assert.equal(records.length, 2);
    assert.ok(records.every((job) => job.worker?.id));
    assert.notEqual(records[0].worker.bin, records[1].worker.bin, 'auto should avoid a saturated worker');
    assert.match(first.stdout, new RegExp(`AGY worker: ${records[0].worker.id} \\(`));
    assert.match(second.stdout, new RegExp(`AGY worker: ${records[1].worker.id} \\(`));
    assert.equal(await waitForJob(sb, firstId), 'done');
    assert.equal(await waitForJob(sb, secondId), 'done');
    assert.equal(agyCalls(sb).length, 2);
  });

  test('auto supports three workers', async () => {
    const sb = sandbox('auto-three');
    const bins = workersFor(sb, 3);
    const env = { AGY_POOL_BINS: bins.join(','), FAKE_AGY_SLEEP_MS: '2000' };
    const started = [1, 2, 3].map((n) => run(sb, ['research', '--worker', 'auto', '--prompt', `task ${n}`], env));
    assert.ok(started.every((result) => result.code === 0));
    const ids = started.map((result) => jobIdOf(result.stdout));
    const records = state(sb).jobs.filter((job) => ids.includes(job.id));
    assert.equal(new Set(records.map((job) => job.worker.bin)).size, 3);
    for (const id of ids) assert.equal(await waitForJob(sb, id), 'done');
  });

  test('continue and restart preserve affinity and reject migration', async () => {
    const sb = sandbox('affinity');
    const bins = workersFor(sb, 2);
    const env = { AGY_POOL_BINS: bins.join(',') };
    const first = run(sb, ['research', '--worker', 'agy2', '--prompt', 'original'], env);
    assert.equal(first.code, 0, first.stderr);
    const id = jobIdOf(first.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const original = state(sb).jobs.find((job) => job.id === id).worker;
    const continued = run(sb, ['continue', '--job', id, '--prompt', 'follow up'], env);
    assert.equal(continued.code, 0, continued.stderr);
    const continuedId = jobIdOf(continued.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === continuedId).worker, original);
    assert.equal(await waitForJob(sb, continuedId), 'done');
    const override = run(sb, ['continue', '--job', id, '--worker', 'agy3', '--prompt', 'wrong worker'], env);
    assert.notEqual(override.code, 0);
    assert.match(override.stderr, /worker affinity conflict/);
    const restarted = run(sb, ['restart', id, '--prompt', 'ignored'], env);
    assert.equal(restarted.code, 0, restarted.stderr);
    const restartId = jobIdOf(restarted.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === restartId).worker, original);
    assert.equal(await waitForJob(sb, restartId), 'done');

    const direct = run(sb, ['research', '--continue', '--prompt', 'same mode continuation'], env);
    assert.equal(direct.code, 0, direct.stderr);
    const directId = jobIdOf(direct.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === directId).worker, original);
    assert.equal(await waitForJob(sb, directId), 'done');
  });

  test('legacy dispatch without worker uses AGY_BIN and does not discover pool', async () => {
    const sb = sandbox('legacy');
    const result = run(sb, ['research', '--prompt', 'legacy'], { AGY_POOL_BINS: path.join(sb.root, 'missing') });
    assert.equal(result.code, 0, result.stderr);
    const id = jobIdOf(result.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === id).worker, {
      id: 'default', bin: FAKE_AGY, version: null, capacity: 1,
    });
    assert.equal(await waitForJob(sb, id), 'done');
    assert.equal(agyCalls(sb).length, 1);

    const continued = run(sb, ['continue', '--job', id, '--prompt', 'legacy follow up'], {
      AGY_POOL_BINS: path.join(sb.root, 'still-missing'),
    });
    assert.equal(continued.code, 0, continued.stderr);
    const continuedId = jobIdOf(continued.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === continuedId).worker, {
      id: 'default', bin: FAKE_AGY, version: null, capacity: 1,
    });
    assert.equal(await waitForJob(sb, continuedId), 'done');

    const restarted = run(sb, ['restart', id], { AGY_POOL_BINS: path.join(sb.root, 'still-missing') });
    assert.equal(restarted.code, 0, restarted.stderr);
    const restartedId = jobIdOf(restarted.stdout);
    assert.deepEqual(state(sb).jobs.find((job) => job.id === restartedId).worker, {
      id: 'default', bin: FAKE_AGY, version: null, capacity: 1,
    });
    assert.equal(await waitForJob(sb, restartedId), 'done');
  });

  test('no available worker fails clearly when pool is explicitly requested', () => {
    const sb = sandbox('none');
    const result = run(sb, ['research', '--worker', 'auto', '--prompt', 'none'], {
      AGY_BIN: path.join(sb.root, 'missing-agy'), AGY_POOL_BINS: path.join(sb.root, 'missing-pool'),
      PATH: path.join(sb.root, 'empty-path'),
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no available AGY worker found/);
  });

  test('worker unavailable after creation does not migrate', async () => {
    const sb = sandbox('disappears');
    const bins = workersFor(sb, 2);
    const disappearing = bins[0];
    const result = run(sb, ['research', '--worker', 'agy2', '--prompt', 'disappear'], { AGY_POOL_BINS: bins.join(',') });
    assert.equal(result.code, 0, result.stderr);
    const id = jobIdOf(result.stdout);
    fs.unlinkSync(disappearing);
    const status = await waitForJob(sb, id);
    assert.equal(status, 'error');
    const record = state(sb).jobs.find((job) => job.id === id);
    assert.equal(record.worker.id, 'agy2');
    assert.match(fs.readFileSync(record.result_file, 'utf8'), /failed to launch agy|became unavailable/);
  });
});

describe('workers table reports what discovery found', () => {
  /** A quota cache of the shape the external hook writes, in the sandbox. */
  function quotaCache(sb, entries) {
    const dir = path.join(sb.root, 'quota-cache');
    fs.mkdirSync(dir, { recursive: true });
    for (const [profile, value] of Object.entries(entries)) {
      fs.writeFileSync(path.join(dir, `agy-quota-${profile}.json`), JSON.stringify(value));
    }
    return dir;
  }

  test('quota slack is printed with its age, and absence prints as a dash', () => {
    const sb = sandbox('workers-quota-column');
    const bins = workersFor(sb, 2);
    const dir = quotaCache(sb, {
      // 21% used, captured two hours ago → 79% slack, age 2h.
      profile2: { used_percent: 21, captured_at: (Date.now() - 2 * 3600_000) / 1000 },
      // profile3 deliberately absent: no reading is a real answer.
    });
    const result = run(sb, ['workers'], { AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: dir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /id \| executable \| status \| version \| capacity \| active jobs \| quota slack/);
    assert.match(result.stdout, /agy2.*\| 79% \(2h\)/);
    assert.match(result.stdout, /agy3.*\| -$/m);
  });

  test('a worker that never answers the probe prints unknown, not unavailable', () => {
    const sb = sandbox('workers-unknown-row');
    const bins = workersFor(sb, 1);
    // Both attempts expire well before the fake binary answers, which is the
    // only way to reach `unknown` end to end. Printing `unavailable` here is
    // the exact false negative this row exists to prevent.
    const result = run(sb, ['workers'], {
      AGY_POOL_BINS: bins.join(','),
      AGY_PROBE_TIMEOUT_MS: '60',
      AGY_PROBE_RETRY_TIMEOUT_MS: '60',
      FAKE_AGY_VERSION_DELAY_MS: '400',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /agy2 \|.*\| unknown \|/);
    assert.doesNotMatch(result.stdout, /agy2 \|.*\| unavailable \|/);
  });

  test('a bin that does not exist still prints unavailable, with no retry cost', () => {
    const sb = sandbox('workers-unavailable-row');
    const missing = path.join(sb.root, 'agy9-nao-existe');
    const result = run(sb, ['workers'], { AGY_POOL_BINS: missing });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /agy9-nao-existe \|.*\| unavailable \|/);
  });
});
