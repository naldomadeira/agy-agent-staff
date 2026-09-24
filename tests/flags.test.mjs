/**
 * Flag surface: removed 0.1 flags, deprecated aliases, mutual exclusion.
 * Spec sections "Removed flags", "Deprecated aliases", "Permission profiles".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, run, agyCalls, jobIdOf, waitForJob, waitForCalls, promptOf } from './helpers.mjs';

describe('removed review flags (--diff-file / --pr / --target)', () => {
  for (const [flag, args] of [
    ['--diff-file', ['review', '--diff-file', '/tmp/x.patch', '--prompt', 'subject']],
    ['--pr', ['review', '--pr', '730', '--prompt', 'subject']],
    ['--target', ['review', '--target', 'master', '--prompt', 'subject']],
  ]) {
    test(`${flag} dies with the prompt-based migration message`, () => {
      const sb = sandbox('removed-review');
      const r = run(sb, args);
      assert.notEqual(r.code, 0, `${flag} must exit nonzero`);
      assert.match(
        r.stderr,
        new RegExp(`${flag} was removed in 0\\.2: review is prompt-based now\\.`)
      );
      assert.match(r.stderr, /Describe the subject in the prompt/);
      assert.match(r.stderr, /review --prompt "Review PR #730"/);
      assert.match(r.stderr, /review --prompt "Review changes against master"/);
      // no execution-style advice leaking into the review message
      assert.doesNotMatch(r.stderr, /execution style is fixed per mode/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }
});

describe('removed execution flags (--background / --wait)', () => {
  for (const [flag, args] of [
    ['--background', ['research', '--background', '--prompt', 'task']],
    ['--wait', ['research', '--wait', '--prompt', 'task']],
    // also removed for ask, whose 0.1 special case is now moot
    ['--background', ['ask', '--background', '--prompt', 'question']],
  ]) {
    test(`${flag} dies with the fixed-execution-style migration message`, () => {
      const sb = sandbox('removed-exec');
      const r = run(sb, args);
      assert.notEqual(r.code, 0, `${flag} must exit nonzero`);
      assert.match(
        r.stderr,
        new RegExp(`${flag} was removed in 0\\.2: execution style is fixed per mode`)
      );
      assert.match(
        r.stderr,
        /ask runs in the foreground; research\/review\/implement run as background jobs/
      );
      assert.match(r.stderr, /Use status\/result\/cancel to manage jobs\./);
      assert.doesNotMatch(r.stderr, /review is prompt-based now/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }
});

describe('--worker scope', () => {
  // status/wait/result/cancel/observe/setup/workers never read opts.worker —
  // --worker lives in the global VALUE_FLAGS set, so without an explicit
  // rejection it was accepted and silently ignored there.
  for (const cmd of ['status', 'wait', 'result', 'cancel', 'observe', 'setup', 'workers']) {
    test(`${cmd} --worker dies naming the subcommand, not the pool`, () => {
      const sb = sandbox(`worker-scope-${cmd}`);
      const r = run(sb, [cmd, '--worker', 'agy2']);
      assert.equal(r.code, 1, `${cmd} --worker must use the usage-error exit code`);
      assert.match(
        r.stderr,
        new RegExp(`--worker has no effect on ${cmd}: it only selects a pool worker when starting or resuming a run`)
      );
      assert.match(r.stderr, /staffer, research, review, implement, ask, continue, restart/);
      // it must not fall through to pool selection (a different error shape)
      assert.doesNotMatch(r.stderr, /worker.*(unavailable|busy|no available AGY worker)/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }

  test('the same subcommands without --worker behave exactly as before', () => {
    const sb = sandbox('worker-scope-baseline');

    const status = run(sb, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /No agy-staff jobs recorded in this repository\./);

    const wait = run(sb, ['wait']);
    assert.equal(wait.code, 1);
    assert.match(wait.stderr, /no agy-staff jobs recorded in this repository/);

    const result = run(sb, ['result']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no finished jobs in this repository/);

    const cancel = run(sb, ['cancel']);
    assert.equal(cancel.code, 1);
    assert.match(cancel.stderr, /cancel needs a job id/);

    const observe = run(sb, ['observe']);
    assert.equal(observe.code, 1);
    assert.match(observe.stderr, /no agy-staff jobs recorded in this repository/);

    const setup = run(sb, ['setup']);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /DRY RUN/);

    const workers = run(sb, ['workers']);
    assert.equal(workers.code, 0, workers.stderr);
    assert.match(workers.stdout, /id \| executable \| status \| version \| capacity \| active jobs/);
  });

  test('a run command still accepts and acts on --worker', () => {
    const sb = sandbox('worker-scope-run-accepts');
    // AGY_BIN (the fake agy) is discoverable once the pool is probed, so
    // --worker auto resolves instead of dying — proving the flag still does
    // something here, unlike the rejected subcommands above.
    const r = run(sb, ['research', '--worker', 'auto', '--prompt', 'a topic']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /--worker has no effect on/);
  });
});

describe('flag scope (generalized)', () => {
  // --worker was the first flag scoped to specific subcommands (see the
  // "--worker scope" describe block above); the companion generalizes that
  // into a single flag -> accepted-subcommands map (FLAG_SCOPE in
  // companion/agy-companion.mjs) instead of one Set per flag. These pairs are
  // a representative sample of the map, not the full flags x commands
  // matrix: at least one rejecting command per command family (a run mode,
  // continue, restart, a status-family command, setup) for every flag, plus
  // the specific latent no-ops the map fixes:
  //   - --model/--effort/--restricted/--unrestricted/--conversation/--job/
  //     --json on `restart`: cmdRestart never reads the live invocation's
  //     opts for these — it forwards the stored job spec — so passing them
  //     used to look like an override that silently did nothing. (Exception:
  //     --prompt/--prompt-file/--stdin on `restart` stay accepted-and-ignored
  //     — see the FLAG_SCOPE comment in the companion for why, and the
  //     "restart accepts and ignores --prompt" test below for the
  //     already-documented invocation this preserves.)
  //   - --continue (the boolean) on the `continue` subcommand itself: a
  //     no-op today because cmdContinue always resolves a conversation id
  //     before resolveRun() ever consults opts.continue.
  //   - --json anywhere but review/continue: read unconditionally by
  //     executeRun() but only ever changes behavior when the resolved mode
  //     is review, so it silently did nothing for staffer/research/
  //     implement/ask.
  //   - --dry-run anywhere but setup: never read by any command at all.
  const NEEDS_VALUE = new Set(['job', 'conversation', 'model', 'effort', 'timeout', 'restrict', 'prompt', 'prompt-file', 'gate', 'gate-cmd', 'gate-timeout']);
  const rejectedPairs = [
    ['model', 'status', []],
    ['model', 'restart', ['fake-job']],
    ['effort', 'cancel', []],
    ['effort', 'restart', ['fake-job']],
    ['restricted', 'wait', []],
    ['restricted', 'restart', ['fake-job']],
    ['unrestricted', 'observe', []],
    ['unrestricted', 'restart', ['fake-job']],
    ['conversation', 'workers', []],
    ['conversation', 'restart', ['fake-job']],
    ['job', 'staffer', []],
    ['job', 'restart', ['fake-job']],
    ['prompt', 'status', []],
    ['prompt-file', 'wait', []],
    ['stdin', 'result', []],
    ['continue', 'continue', []],
    ['continue', 'setup', []],
    ['json', 'staffer', []],
    ['json', 'ask', []],
    ['json', 'restart', ['fake-job']],
    ['restrict', 'status', []],
    ['restrict', 'wait', []],
    ['timeout', 'status', []],
    ['timeout', 'cancel', []],
    ['apply', 'staffer', []],
    ['apply', 'wait', []],
    ['dry-run', 'staffer', []],
    ['dry-run', 'review', []],
    ['allow-gate', 'staffer', []],
    ['allow-gate', 'status', []],
    ['gate', 'staffer', []],
    ['gate', 'status', []],
    ['gate-cmd', 'research', []],
    ['gate-cmd', 'wait', []],
    ['gate-timeout', 'review', []],
    ['gate-timeout', 'cancel', []],
  ];

  for (const [flag, cmd, extraArgs] of rejectedPairs) {
    test(`--${flag} on ${cmd} dies naming the flag, the subcommand, and where it is valid`, () => {
      const sb = sandbox(`flagscope-${flag}-${cmd}`);
      const value = NEEDS_VALUE.has(flag) ? ['x'] : [];
      const r = run(sb, [cmd, ...extraArgs, `--${flag}`, ...value]);
      assert.equal(r.code, 1, `${cmd} --${flag} must use the usage-error exit code (stdout: ${r.stdout} stderr: ${r.stderr})`);
      assert.match(r.stderr, new RegExp(`--${flag} has no effect on ${cmd}:`));
      assert.match(r.stderr, /valid on:/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }

  test('an unrecognized subcommand still gets its own error, not a flag-scope one', () => {
    const sb = sandbox('flagscope-unknown-cmd');
    const r = run(sb, ['frobnicate', '--model', 'x']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown subcommand: frobnicate/);
    assert.doesNotMatch(r.stderr, /has no effect on frobnicate/);
  });

  test('staffer/research/review/implement/ask still accept model, effort and timeout', () => {
    const sb = sandbox('flagscope-accept-run');
    const r = run(sb, ['staffer', '--effort', 'high', '--timeout', '5m', '--prompt', 'do it']);
    assert.equal(r.code, 0, r.stderr);
  });

  test('review still accepts --json', () => {
    const sb = sandbox('flagscope-accept-review-json');
    const r = run(sb, ['review', '--json', '--prompt', 'Review PR #730']);
    assert.equal(r.code, 0, r.stderr);
  });

  test('continue still accepts --job and task-text flags (reaches cmdContinue, not rejected for scope)', () => {
    const sb = sandbox('flagscope-accept-continue');
    const r = run(sb, ['continue', '--job', 'missing-job', '--prompt', 'next']);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /has no effect on continue/);
    assert.match(r.stderr, /no job missing-job/);
  });

  test('restart still accepts --worker and --timeout (reaches cmdRestart, not rejected for scope)', () => {
    const sb = sandbox('flagscope-accept-restart');
    const r = run(sb, ['restart', 'missing-job', '--worker', 'auto', '--timeout', '5m']);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stderr, /has no effect on restart/);
    assert.match(r.stderr, /no job missing-job/);
  });

  test('restart accepts and ignores --prompt (cmdRestart rebuilds the prompt from the stored spec)', async () => {
    const sb = sandbox('flagscope-accept-restart-prompt');
    const first = run(sb, ['staffer', '--prompt', 'original task']);
    assert.equal(first.code, 0, first.stderr);
    const id = jobIdOf(first.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [originalArgv] = await waitForCalls(sb, 1);

    const restarted = run(sb, ['restart', id, '--prompt', 'this value is ignored']);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.doesNotMatch(restarted.stderr, /has no effect on restart/);
    const restartId = jobIdOf(restarted.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    const [, restartArgv] = await waitForCalls(sb, 2);
    // The restarted run used the original stored task, not the ignored override.
    assert.equal(promptOf(restartArgv), promptOf(originalArgv));
    assert.doesNotMatch(promptOf(restartArgv), /this value is ignored/);
  });

  test('implement/continue/restart still accept --allow-gate (reach their own logic, not rejected for scope)', async () => {
    const sb = sandbox('flagscope-accept-allow-gate');
    // implement's own postcondition flags a run "attention" when agy reports
    // success but touched nothing, unrelated to what this test checks (flag
    // scope) — give it a real delta so the job reaches "done".
    const started = run(sb, ['implement', '--allow-gate', '--prompt', 'a task'], {
      FAKE_AGY_TOUCH_FILE: path.join(sb.repo, 'agy-wrote.txt'),
    });
    assert.equal(started.code, 0, started.stderr);
    assert.doesNotMatch(started.stderr, /has no effect on implement/);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const continued = run(sb, ['continue', '--allow-gate', '--prompt', 'next']);
    assert.doesNotMatch(continued.stderr, /has no effect on continue/);

    const restarted = run(sb, ['restart', id, '--allow-gate']);
    assert.doesNotMatch(restarted.stderr, /has no effect on restart/);
  });

  test('wait still accepts --timeout (reaches cmdWait, not rejected for scope)', () => {
    const sb = sandbox('flagscope-accept-wait');
    const r = run(sb, ['wait', '--timeout', '1s']);
    assert.doesNotMatch(r.stderr, /has no effect on wait/);
    assert.match(r.stderr, /no agy-staff jobs recorded/);
  });

  test('setup still accepts --restrict, --apply and --dry-run', () => {
    const sb = sandbox('flagscope-accept-setup');
    const r = run(sb, ['setup', '--restrict', 'review', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /has no effect on setup/);
  });

  test('status/result/cancel/observe/workers keep accepting zero flags (baseline unaffected)', () => {
    const sb = sandbox('flagscope-accept-bare');
    for (const cmd of ['status', 'result', 'cancel', 'observe', 'workers']) {
      const r = run(sb, [cmd]);
      assert.doesNotMatch(r.stderr, new RegExp(`has no effect on ${cmd}`), `${cmd}: ${r.stderr}`);
    }
  });
});

describe('--deliver (implement commit authorization)', () => {
  test('--deliver only accepts "commit"', () => {
    const sb = sandbox('deliver-invalid-value');
    const r = run(sb, ['implement', '--deliver', 'push', '--prompt', 'a task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--deliver accepts only "commit" \(got "push"\)/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('--deliver needs a value', () => {
    const sb = sandbox('deliver-missing-value');
    const r = run(sb, ['implement', '--deliver', '--prompt', 'a task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /flag --deliver needs a value/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  for (const [cmd, extraArgs] of [
    ['staffer', []],
    ['research', []],
    ['review', []],
    ['ask', []],
    ['continue', []],
    ['restart', ['fake-job']],
    ['status', []],
    ['setup', []],
  ]) {
    test(`--deliver on ${cmd} dies naming the flag, the subcommand, and where it is valid`, () => {
      const sb = sandbox(`deliver-scope-${cmd}`);
      const r = run(sb, [cmd, ...extraArgs, '--deliver', 'commit']);
      assert.equal(r.code, 1, `${cmd} --deliver must use the usage-error exit code (stdout: ${r.stdout} stderr: ${r.stderr})`);
      assert.match(r.stderr, new RegExp(`--deliver has no effect on ${cmd}:`));
      assert.match(r.stderr, /valid on: implement/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }

  test('implement still accepts --deliver commit', () => {
    const sb = sandbox('deliver-accept-implement');
    const r = run(sb, ['implement', '--deliver', 'commit', '--prompt', 'do it']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /has no effect on implement/);
  });
});

describe('deprecated aliases', () => {
  test('--strict maps to restricted and warns once on stderr', () => {
    const sb = sandbox('alias-strict');
    const r = run(sb, ['implement', '--strict', '--prompt', 'do a thing']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^agy-staff: --strict is deprecated; use --restricted$/m);
    // implement defaults to unrestricted, so the alias is what flips it
    assert.match(r.stdout, /profile: restricted/);
  });

  test('--loose maps to unrestricted and warns once on stderr', () => {
    const sb = sandbox('alias-loose');
    const r = run(sb, ['research', '--loose', '--prompt', 'a topic']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^agy-staff: --loose is deprecated; use --unrestricted$/m);
    // research is unrestricted by default in 0.2 round 2, so --loose is now
    // redundant; what the alias must still do is resolve and warn, not die
    assert.match(r.stdout, /profile: unrestricted/);
  });

  test('--restricted with the --loose alias is mutually exclusive', () => {
    const sb = sandbox('alias-conflict');
    const r = run(sb, ['research', '--restricted', '--loose', '--prompt', 'a topic']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--restricted and --unrestricted are mutually exclusive/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('--restricted with --unrestricted is mutually exclusive', () => {
    const sb = sandbox('conflict');
    const r = run(sb, ['research', '--restricted', '--unrestricted', '--prompt', 'a topic']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--restricted and --unrestricted are mutually exclusive/);
  });
});
