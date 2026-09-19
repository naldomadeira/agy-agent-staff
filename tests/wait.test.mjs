/**
 * The job-wait contract: machine-readable exit codes on `status <id>` and the
 * blocking `wait` subcommand.
 *
 * Codes: 0 = done, 2 = running (for wait: its own timeout expired while the
 * job kept running — call it again), 3 = error/crashed, 4 = canceled, 1 =
 * generic companion error (unknown id). The point of the contract is that a
 * caller can loop on "exit code 2" with zero output parsing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, jobIdOf, jobLog, waitForJob } from './helpers.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The job's published progress snapshot, or null before the first publish. */
function progressOf(sb, jobId) {
  const file = path.join(sb.repo, '.agy-staff', 'jobs', `${jobId}.progress.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Poll until the worker has published at least one tool activity — the
 *  same wait streaming.test.mjs uses before asserting on progress, needed
 *  here because raw events land in the job's events file (what --follow
 *  tails) slightly ahead of the debounced progress publish this checks. */
async function waitForActivity(sb, jobId, { tries = 200, delayMs = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const snapshot = progressOf(sb, jobId);
    if (snapshot?.recent_activities?.length) return snapshot;
    await pause(delayMs);
  }
  throw new Error(`job ${jobId} never published a tool activity`);
}

describe('status <id> exit codes', () => {
  test('running → 2, done → 0', async () => {
    const sb = sandbox('waitc-status');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '3000' });
    const id = jobIdOf(started.stdout);

    const running = run(sb, ['status', id]);
    assert.equal(running.code, 2, `expected running exit code 2\n${running.stdout}${running.stderr}`);

    await waitForJob(sb, id);
    const done = run(sb, ['status', id]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /"status": "done"/);
  });

  test('error → 3, unknown id → 1, list form stays 0', async () => {
    const sb = sandbox('waitc-status-err');
    // an ERROR with a response would be delivered (done_with_warnings); a real
    // failure has no response
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' });
    const id = jobIdOf(started.stdout);
    await waitForJob(sb, id);

    assert.equal(run(sb, ['status', id]).code, 3);
    assert.equal(run(sb, ['status', 'no-such-job']).code, 1);
    assert.equal(run(sb, ['status']).code, 0);
  });
});

describe('wait', () => {
  test('blocks until done, prints the result, exits 0', async () => {
    const sb = sandbox('wait-done');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`# Job ${id} \\(research, done\\)`));
    assert.match(r.stdout, /fake answer/);
  });

  test('the delivered result is the body only; telemetry stays in the job log', async () => {
    const sb = sandbox('wait-telemetry');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fake answer/);
    assert.doesNotMatch(r.stdout, /\[agy-staff\]/);
    assert.doesNotMatch(r.stdout, /follow up with --continue/);

    const log = jobLog(sb, id);
    assert.match(log, /\[agy-staff\] mode=research profile=unrestricted model=\S+ /);
    assert.match(log, /^conversation: conv-1 \(follow up with --continue\)$/m);
  });

  test('own timeout while the job runs → exit 2, then a second wait succeeds', async () => {
    const sb = sandbox('wait-timeout');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(first.code, 2, `${first.stdout}${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).status, 'running');
    assert.doesNotMatch(first.stdout, /fake answer/, 'a timed-out wait must not print a result');

    const second = run(sb, ['wait', id]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /fake answer/);
  });

  test('wait stays silent past the former 15s heartbeat and still delivers progress/result', () => {
    const sb = sandbox('wait-silent');
    const started = run(sb, ['staffer', '--prompt', 'a quiet task'], { FAKE_AGY_SLEEP_MS: '21000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '16s']);
    assert.equal(first.code, 2, first.stdout + first.stderr);
    assert.equal(first.stderr, '', 'soft waiting must not emit liveness heartbeats');
    assert.equal(JSON.parse(first.stdout).status, 'running', 'stdout contains only the expiry snapshot');

    const final = run(sb, ['wait', id]);
    assert.equal(final.code, 0, final.stdout + final.stderr);
    assert.equal(final.stderr, '');
    assert.match(final.stdout, /fake answer/);
  });

  test('failed job → exit 3 with the stored error', async () => {
    const sb = sandbox('wait-error');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 3, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Job failed:/);
  });

  test('canceled job → exit 4', async () => {
    const sb = sandbox('wait-cancel');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '8000' });
    const id = jobIdOf(started.stdout);
    run(sb, ['cancel', id]);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 4, `${r.stdout}${r.stderr}`);
  });

  test('no id defaults to the most recent job; unknown id → 1', async () => {
    const sb = sandbox('wait-default');
    assert.equal(run(sb, ['wait', 'no-such-job']).code, 1);

    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);
    const r = run(sb, ['wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`# Job ${id} `));
  });
});

describe('wait --follow', () => {
  // One tool step reported ACTIVE then DONE (what a real agy run streams for
  // every tool call), plus an agent_response delta — the kind of event
  // --follow must stay quiet about, since it has no tool_name and would be
  // prose, not progress.
  const events = [
    { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 7, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pnpm typecheck' } } } },
    { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 7, step_type: 'tool', state: 'DONE', tool_name: 'run_command', duration_seconds: 5.5, tool_info: { parameters: { CommandLine: 'pnpm typecheck' } } } },
    { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 8, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Looking good so far.' } },
  ];

  test('prints step lines to stderr while the job runs; stdout keeps the plain running snapshot', async (t) => {
    const sb = sandbox('wait-follow-live');
    const release = path.join(sb.root, 'release');
    t.after(() => fs.writeFileSync(release, 'finish')); // never leave the fake agy blocked past the test
    // The fake agy delays its streaming output well past this dispatch call
    // returning, so `wait --follow` below starts polling — and captures its
    // "only new lines from here" offset — before any event exists, instead
    // of racing the fake agy's own startup to land before that offset.
    const started = run(sb, ['research', '--prompt', 'follow me'], {
      FAKE_AGY_EVENTS: JSON.stringify(events),
      FAKE_AGY_EVENTS_DELAY_MS: '400',
      FAKE_AGY_RELEASE_FILE: release,
    });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id, '--follow', '--timeout', '2s']);
    assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).status, 'running', 'stdout is the same expiry snapshot as without --follow');
    assert.match(r.stderr, /▶ run_command pnpm typecheck/);
    assert.match(r.stderr, /✓ run_command pnpm typecheck \(5\.5s\)/);
    assert.doesNotMatch(r.stderr, /Looking good so far\./, 'agent_response text is prose, not a step, and must not print');

    fs.writeFileSync(release, 'finish');
    const done = run(sb, ['wait', id]);
    assert.equal(done.code, 0, done.stdout + done.stderr);
  });

  test('without the flag, stderr stays silent even though the job has step events (no regression of the default silence)', async (t) => {
    const sb = sandbox('wait-no-follow-silent');
    const release = path.join(sb.root, 'release');
    t.after(() => fs.writeFileSync(release, 'finish'));
    const started = run(sb, ['research', '--prompt', 'stay quiet'], { FAKE_AGY_EVENTS: JSON.stringify(events), FAKE_AGY_RELEASE_FILE: release });
    const id = jobIdOf(started.stdout);
    await waitForActivity(sb, id);

    const r = run(sb, ['wait', id, '--timeout', '150ms']);
    assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, '', 'no --follow means no progress lines at all');

    fs.writeFileSync(release, 'finish');
    assert.equal(run(sb, ['wait', id]).code, 0);
  });

  test('rejected on every subcommand but wait, coherent with FLAG_SCOPE', () => {
    for (const cmd of ['status', 'result', 'cancel', 'observe', 'setup', 'workers']) {
      const sb = sandbox(`wait-follow-scope-${cmd}`);
      const r = run(sb, [cmd, '--follow']);
      assert.equal(r.code, 1, `${cmd} --follow must use the usage-error exit code`);
      assert.match(r.stderr, new RegExp(`--follow has no effect on ${cmd}`));
      assert.match(r.stderr, /\(valid on: wait\)/);
    }
  });

  test('a missing events.jsonl degrades --follow silently; the result is still delivered', () => {
    const sb = sandbox('wait-follow-missing-events');
    const started = run(sb, ['research', '--prompt', 'no events file']);
    const id = jobIdOf(started.stdout);
    const eventsFile = path.join(sb.repo, '.agy-staff', 'jobs', `${id}.events.jsonl`);
    // Whether the worker has even created it yet is a race this test does not
    // need to win: deleting it (or finding nothing to delete) both exercise
    // the same "no file at this path" branch --follow must swallow.
    try { fs.unlinkSync(eventsFile); } catch {}

    const r = run(sb, ['wait', id, '--follow']);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /fake answer/);
  });
});
