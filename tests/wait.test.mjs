/**
 * The job-wait contract: machine-readable exit codes on `status <id>` and the
 * blocking `wait` subcommand.
 *
 * Codes: 0 = done, 2 = running (for wait: its own timeout expired while the
 * job kept running — call it again), 3 = error/crashed, 4 = canceled, 1 =
 * generic companion error (unknown id). The point of the contract is that a
 * caller can loop on "exit code 2" with zero output parsing.
 *
 * wait's exit-2 expiry also prints one line to STDERR ONLY ("STILL RUNNING —
 * job <id>, <n>s elapsed. Exit 2: not delivered; call wait again."). stdout
 * stays byte-identical JSON either way — existing callers do
 * `JSON.parse(stdout)` and must never see that line. It exists because a
 * production orchestrator piped `wait ... | tail`, lost the exit code, and
 * read the plain JSON as a delivered result.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, run, runShell, jobIdOf, jobLog, waitForJob, waitForCalls, COMPANION, FAKE_AGY } from './helpers.mjs';

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
    // A finished job's wait never carries the running-expiry notice.
    assert.doesNotMatch(r.stderr, /STILL RUNNING/);
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

  // Fase 1, item 6: the header's Usage line is opt-in on whatever telemetry
  // the run actually carried — fake-agy emits none of it by default (see
  // tests/fake-agy.mjs), so a plain job renders no line at all.
  test('a terminal job with no known telemetry renders no Usage line', async () => {
    const sb = sandbox('wait-usage-none');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Usage:/);
    assert.equal(r.stdout, `# Job ${id} (research, done) — AGY worker: default (${FAKE_AGY})\n\nfake answer\n`);
  });

  test('a terminal job with full telemetry renders one compact Usage line under the header, and persists it onto the job record', async () => {
    const sb = sandbox('wait-usage-full');
    const started = run(sb, ['research', '--prompt', 'a topic'], {
      FAKE_AGY_USAGE: JSON.stringify({ input_tokens: 1728044, output_tokens: 12301, thinking_tokens: 40112, cache_read_tokens: 1200000 }),
      FAKE_AGY_DURATION_SECONDS: '1177', // 19m37s
      FAKE_AGY_NUM_TURNS: '42',
    });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      `# Job ${id} (research, done) — AGY worker: default (${FAKE_AGY})\n` +
        'Usage: in 1,728,044 · out 12,301 · think 40,112 · cache 1,200,000 · 19m37s · 42 turns\n' +
        '\nfake answer\n'
    );

    const status = JSON.parse(run(sb, ['status', id]).stdout);
    assert.deepEqual(status.usage, { input_tokens: 1728044, output_tokens: 12301, thinking_tokens: 40112, cache_read_tokens: 1200000 });
    assert.equal(status.duration_seconds, 1177);
    assert.equal(status.num_turns, 42);

    const observed = JSON.parse(run(sb, ['observe', id]).stdout);
    assert.deepEqual(observed.usage, status.usage);
    assert.equal(observed.duration_seconds, 1177);
    assert.equal(observed.num_turns, 42);
  });

  test('the Usage line omits missing parts instead of guessing', async () => {
    const sb = sandbox('wait-usage-partial');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_DURATION_SECONDS: '65' });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Usage: 1m5s$/m);
    assert.doesNotMatch(r.stdout, /in \d|out \d|turns/);
  });

  test('own timeout while the job runs → exit 2, then a second wait succeeds', async () => {
    const sb = sandbox('wait-timeout');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(first.code, 2, `${first.stdout}${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).status, 'running');
    assert.doesNotMatch(first.stdout, /fake answer/, 'a timed-out wait must not print a result');
    assert.match(
      first.stderr,
      new RegExp(`^STILL RUNNING — job ${id}, \\d+s elapsed\\. Exit 2: not delivered; call wait again\\.\\n$`)
    );

    const second = run(sb, ['wait', id]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /fake answer/);
    assert.doesNotMatch(second.stderr, /STILL RUNNING/);
  });

  test('the expiry notice is stderr-only; stdout is unaffected (still parses as JSON)', async () => {
    const sb = sandbox('wait-expiry-notice-stdout-clean');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(r.code, 2, `${r.stdout}${r.stderr}`);
    const parsed = JSON.parse(r.stdout); // throws if the notice ever leaks into stdout
    assert.equal(parsed.status, 'running');
    assert.doesNotMatch(r.stdout, /STILL RUNNING/);
  });

  test('2>&1 carries the notice: a caller piping wait without pipefail still sees it', async () => {
    const sb = sandbox('wait-expiry-notice-2and1');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);

    const merged = runShell(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(merged.code, 2, merged.output);
    assert.match(merged.output, /"status":"running"/);
    assert.match(merged.output, new RegExp(`STILL RUNNING — job ${id}, \\d+s elapsed\\.`));
  });

  test('wait stays silent past the former 15s heartbeat (no periodic heartbeat) and still delivers progress/result', () => {
    const sb = sandbox('wait-silent');
    const started = run(sb, ['staffer', '--prompt', 'a quiet task'], { FAKE_AGY_SLEEP_MS: '21000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '16s']);
    assert.equal(first.code, 2, first.stdout + first.stderr);
    // No periodic heartbeat (the old behavior this test guards against): stderr
    // carries exactly the one expiry notice, not one line per poll tick.
    const elapsed = JSON.parse(first.stdout).elapsed_seconds;
    assert.equal(
      first.stderr,
      `STILL RUNNING — job ${id}, ${elapsed}s elapsed. Exit 2: not delivered; call wait again.\n`
    );
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
    assert.match(r.stderr, new RegExp(`STILL RUNNING — job ${id}, \\d+s elapsed\\.`), '--follow does not suppress the expiry notice');

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
    assert.doesNotMatch(r.stderr, /[▶✓✗]/, 'no --follow means no progress lines at all');
    const elapsed = JSON.parse(r.stdout).elapsed_seconds;
    assert.equal(
      r.stderr,
      `STILL RUNNING — job ${id}, ${elapsed}s elapsed. Exit 2: not delivered; call wait again.\n`,
      'the expiry notice still prints even without --follow'
    );

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

describe('wait --until-done', () => {
  test('mutually exclusive with --timeout: usage error, exit 1', () => {
    const sb = sandbox('until-done-mutex');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id, '--until-done', '--timeout', '5s']);
    assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--until-done/);
    assert.match(r.stderr, /--timeout/);
  });

  test('blocks past the default 100s ceiling and returns the terminal result once the job finishes', async (t) => {
    const sb = sandbox('until-done-blocks');
    const release = path.join(sb.root, 'release');
    t.after(() => fs.writeFileSync(release, 'finish')); // never leave the fake agy blocked past the test
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_RELEASE_FILE: release });
    const id = jobIdOf(started.stdout);
    // Confirms the worker actually launched and is parked on the release file
    // before the until-done waiter starts polling, same ordering streaming.test.mjs uses.
    await waitForCalls(sb, 1);

    const waiter = spawn(process.execPath, [COMPANION, 'wait', id, '--until-done'], {
      cwd: sb.repo,
      env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, AGY_BIN: FAKE_AGY, AGY_POOL_BINS: '', FAKE_AGY_ARGV_FILE: sb.argvFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    waiter.stdout.setEncoding('utf8'); waiter.stderr.setEncoding('utf8');
    waiter.stdout.on('data', (d) => { stdout += d; });
    waiter.stderr.on('data', (d) => { stderr += d; });
    const closed = new Promise((resolve) => waiter.on('close', resolve));

    fs.writeFileSync(release, 'finish');
    const code = await closed;
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, new RegExp(`# Job ${id} \\(research, done\\)`));
    assert.match(stdout, /fake answer/);
    assert.doesNotMatch(stderr, /STILL RUNNING/, 'a job that reached done never gets the running-expiry notice');
  });

  test('compatible with --follow: streams steps to stderr and still returns the terminal result', async (t) => {
    const events = [
      { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pnpm test' } } } },
      { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'run_command', duration_seconds: 2.1, tool_info: { parameters: { CommandLine: 'pnpm test' } } } },
    ];
    const sb = sandbox('until-done-follow');
    const release = path.join(sb.root, 'release');
    t.after(() => fs.writeFileSync(release, 'finish'));
    const started = run(sb, ['research', '--prompt', 'follow me too'], {
      FAKE_AGY_EVENTS: JSON.stringify(events), FAKE_AGY_EVENTS_DELAY_MS: '200', FAKE_AGY_RELEASE_FILE: release,
    });
    const id = jobIdOf(started.stdout);
    await waitForCalls(sb, 1);

    const waiter = spawn(process.execPath, [COMPANION, 'wait', id, '--until-done', '--follow'], {
      cwd: sb.repo,
      env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, AGY_BIN: FAKE_AGY, AGY_POOL_BINS: '', FAKE_AGY_ARGV_FILE: sb.argvFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    waiter.stdout.setEncoding('utf8'); waiter.stderr.setEncoding('utf8');
    waiter.stdout.on('data', (d) => { stdout += d; });
    waiter.stderr.on('data', (d) => { stderr += d; });
    const closed = new Promise((resolve) => waiter.on('close', resolve));

    await new Promise((r) => setTimeout(r, 400)); // let the step events land before releasing
    fs.writeFileSync(release, 'finish');
    const code = await closed;
    assert.equal(code, 0, stdout + stderr);
    assert.match(stderr, /▶ run_command pnpm test/);
    assert.match(stdout, /fake answer/);
  });

  test('a dead worker with no result ends as crashed instead of hanging forever', () => {
    const sb = sandbox('until-done-crashed');
    const id = 'research-simulated-crash-until-done';
    const stateDir = path.join(sb.repo, '.agy-staff');
    fs.mkdirSync(stateDir);
    const stateFile = path.join(stateDir, 'state.json');
    // Same fake-crash shape jobs.test.mjs uses: a running job record with an
    // unreachable pid and no result file. liveJobStatus() reclassifies it as
    // crashed on the very next read — the same refresh logic wait already
    // uses on every poll tick — so --until-done's uncapped loop still ends.
    fs.writeFileSync(stateFile, JSON.stringify({ jobs: [{
      id, mode: 'research', status: 'running', pid: 99999999,
      cwd: sb.repo, started_at: new Date().toISOString(),
      spec_file: path.join(stateDir, `${id}.spec.json`),
      result_file: path.join(stateDir, `${id}.result.md`),
      log_file: path.join(stateDir, `${id}.log`),
    }] }));

    const r = run(sb, ['wait', id, '--until-done']);
    assert.equal(r.code, 3, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /finished with status crashed and no stored result/);
  });

  test('rejected on every subcommand but wait, coherent with FLAG_SCOPE', () => {
    for (const cmd of ['status', 'result', 'cancel', 'observe', 'setup', 'workers']) {
      const sb = sandbox(`until-done-scope-${cmd}`);
      const r = run(sb, [cmd, '--until-done']);
      assert.equal(r.code, 1, `${cmd} --until-done must use the usage-error exit code`);
      assert.match(r.stderr, new RegExp(`--until-done has no effect on ${cmd}`));
      assert.match(r.stderr, /\(valid on: wait\)/);
    }
  });
});
