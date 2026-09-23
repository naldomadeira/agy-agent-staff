import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sandbox, run, jobIdOf, agyCalls, waitForCalls, COMPANION, FAKE_AGY } from './helpers.mjs';

const stateFile = sb => path.join(sb.repo, '.agy-staff/state.json');
const state = sb => JSON.parse(fs.readFileSync(stateFile(sb), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause(20);
  assert.ok(predicate(), 'test checkpoint not reached');
}
function refused(result, active) {
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(`job ${active} is still running (status: running)`), result.stderr);
  assert.match(result.stderr, /not accepted or queued/, result.stderr);
  assert.ok(result.stderr.includes(`wait ${active}`), result.stderr);
  assert.ok(result.stderr.includes(`cancel ${active}`), result.stderr);
  assert.equal(result.stdout, '');
}

/**
 * Release a hand-built lock directory the same way `withStateLock`
 * (companion/state-lock.mjs) releases a real one: unlink the marker, then
 * rmdir. The instant the marker is gone the directory is empty, and a
 * contender that has been retrying `renameSync(candidate, lock)` can win the
 * race and replace it with its own (non-empty) candidate before this rmdir
 * runs — that is a fair acquisition, not a bug, and `state-lock.mjs`'s own
 * release path tolerates the resulting ENOTEMPTY for exactly this reason.
 * Mirroring it here (instead of a bare rmdirSync) is what makes this test
 * deterministic rather than an occasional false failure.
 */
function releaseLock(lock, marker) {
  fs.unlinkSync(marker);
  try { fs.rmdirSync(lock); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
}

test('initializing jobs reject follow-ups before a conversation or PID is available', () => {
  const sb = sandbox('continue-initializing');
  fs.mkdirSync(path.dirname(stateFile(sb)));
  const original = { jobs: [{ id: 'starting', mode: 'staffer', status: 'running', pid: null, conversation_id: null }] };
  fs.writeFileSync(stateFile(sb), JSON.stringify(original));
  refused(run(sb, ['continue', '--job', 'starting', '--prompt', 'next']), 'starting');
  assert.deepEqual(state(sb), original);
  assert.equal(agyCalls(sb).length, 0);
});

test('all follow-up entrypoints reject an active successor while other conversations remain usable', async t => {
  const sb = sandbox('continue-successor');
  const release = path.join(sb.root, 'release');
  t.after(() => { for (const j of state(sb).jobs) run(sb, ['cancel', j.id]); });
  const first = jobIdOf(run(sb, ['research', '--prompt', 'first']).stdout);
  assert.equal(run(sb, ['wait', first]).code, 0);
  const conversation = state(sb).jobs.find(j => j.id === first).conversation_id;
  const active = jobIdOf(run(sb, ['continue', '--job', first, '--prompt', 'active'], { FAKE_AGY_RELEASE_FILE: release }).stdout);
  await waitForCalls(sb, 2);
  const requests = [
    ['continue', '--job', first], ['continue', '--job', active],
    ['continue', '--conversation', conversation], ['continue'], ['research', '--continue'],
    ...['staffer', 'research', 'review', 'implement', 'ask'].map(mode => [mode, '--conversation', conversation]),
  ];
  const filesBefore = fs.readdirSync(path.join(sb.repo, '.agy-staff/jobs')).sort();
  for (const request of requests) refused(run(sb, [...request, '--prompt', 'must not run']), active);
  assert.equal(agyCalls(sb).length, 2);
  assert.equal(state(sb).jobs.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(sb.repo, '.agy-staff/jobs')).sort(), filesBefore);
  assert.equal(state(sb).jobs.find(j => j.id === active).cancel_requested_at, undefined);
  const unrelated = jobIdOf(run(sb, ['staffer', '--prompt', 'independent'], { FAKE_AGY_CONVERSATION_ID: 'independent' }).stdout);
  assert.equal(run(sb, ['wait', unrelated]).code, 0);
  fs.writeFileSync(release, 'finish');
  assert.equal(run(sb, ['wait', active]).code, 0);
  const next = jobIdOf(run(sb, ['continue', '--job', first, '--prompt', 'now allowed']).stdout);
  assert.equal(run(sb, ['wait', next]).code, 0);
  assert.equal(state(sb).jobs.find(j => j.id === next).conversation_id, conversation);
});

test('simultaneous follow-ups recheck occupancy inside registration and leave no rejected spec', async t => {
  const sb = sandbox('continue-registration-race');
  const release = path.join(sb.root, 'release');
  const dir = path.join(sb.repo, '.agy-staff');
  const lock = path.join(dir, 'state.json.lock');
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let pending = [];
  t.after(async () => {
    if (fs.existsSync(path.join(lock, owner))) releaseLock(lock, path.join(lock, owner));
    await Promise.allSettled(pending);
    fs.writeFileSync(release, 'finish');
    for (const j of state(sb).jobs) run(sb, ['cancel', j.id]);
  });
  const first = jobIdOf(run(sb, ['staffer', '--prompt', 'seed']).stdout);
  assert.equal(run(sb, ['wait', first]).code, 0);
  await until(() => state(sb).jobs[0].status === 'done' && !fs.existsSync(lock));
  const conversation = state(sb).jobs[0].conversation_id;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, owner), '');
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, 'continue', '--conversation', conversation, '--prompt', 'contender'], {
      // Neutralize the same host pool vars run() blanks in helpers.mjs (a
      // maintainer's AGY_POOL_BINS et al. must not change which worker this
      // spawn lands on) — this test builds its env by hand instead of
      // through run(), so it needs the same defaults repeated here.
      cwd: sb.repo, env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, AGY_BIN: FAKE_AGY,
        AGY_POOL_BINS: '', AGY_QUOTA_CACHE_DIR: '', AGY_PROBE_TIMEOUT_MS: '', AGY_PROBE_RETRY_TIMEOUT_MS: '',
        FAKE_AGY_ARGV_FILE: sb.argvFile, FAKE_AGY_RELEASE_FILE: release },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  pending = [invoke(), invoke()];
  // Both callers have passed the first guard and are waiting for this lock.
  await until(() => fs.readdirSync(dir).filter(n => n.startsWith('state.json.lock.owner-')).length === 2);
  releaseLock(lock, path.join(lock, owner));
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  const active = jobIdOf(results.find(r => r.code === 0).stdout);
  refused(results.find(r => r.code === 1), active);
  assert.equal(state(sb).jobs.length, 2);
  assert.equal(fs.readdirSync(path.join(dir, 'jobs')).filter(n => n.endsWith('.spec.json')).length, 2);
  await waitForCalls(sb, 2);
  assert.equal(agyCalls(sb).length, 2);
  fs.writeFileSync(release, 'finish');
  assert.equal(run(sb, ['wait', active]).code, 0);
});
