/**
 * Fase 2 item 3: companion-run gates after the agent finishes.
 *
 * `.agy-staff/config.json`'s optional `gates` map lets a repo declare named
 * verification commands (`pnpm check`, `pnpm build`, ...); `--gate <names>`
 * (comma list — see resolveGateList's own comment for why a comma list, not
 * a repeated flag, matches this parser) and `--gate-cmd "<cmd>"` opt a single
 * implement run into having the COMPANION run them itself once the worker
 * reports done — never inside the worker's own budget. Fake gates here are
 * tiny `node -e` one-liners spawned through the real shell (shell: true),
 * exercising the same cross-platform process-tree kill path a real `pnpm
 * test` would.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, run, agyCalls, jobIdOf, jobResultFile, waitForJob, waitForCalls, promptOf } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function state(sb) {
  const file = path.join(sb.repo, '.agy-staff', 'state.json');
  if (!fs.existsSync(file)) return { jobs: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Writes `.agy-staff/config.json` with a `gates` map directly — no
 *  companion invocation needed first, and the sandbox's git exclude already
 *  covers `.agy-staff/` unconditionally (see helpers.mjs sandbox()). */
function writeGates(dir, gates) {
  const configDir = path.join(dir, '.agy-staff');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ gates }, null, 2));
}

/** A `node -e <script>` command line, safe to embed in a shell:true command
 *  string (the companion always runs gates through the shell). */
function nodeCmd(script) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// implement's own postcondition (Fase 1) flags a run "attention" when agy
// reports success but touched nothing — unrelated to gates, but any implement
// run here that is meant to reach "done" needs its own delta. Each call gets
// a distinct file so a continue/restart doesn't inherit the prior call's
// already-dirty path as its own (fake) delta.
let touchCounter = 0;
function touchEnv(sb) {
  return { FAKE_AGY_TOUCH_FILE: path.join(sb.repo, `agy-wrote-${++touchCounter}.txt`) };
}

describe('pre-dispatch: unknown gate name / no gates configured', () => {
  test('unknown gate name refuses before dispatch, listing available names and the config path', () => {
    const sb = sandbox('gates-unknown-name');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const r = run(sb, ['implement', '--gate', 'nope', '--prompt', 'a task']);
    assert.equal(r.code, 1, `expected exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.match(r.stderr, /unknown gate "nope"/);
    assert.match(r.stderr, /available: check/);
    assert.match(r.stderr, /config\.json/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    assert.equal((state(sb).jobs || []).length, 0, 'no job may be created');
  });

  test('no gates configured at all refuses, naming the config path', () => {
    const sb = sandbox('gates-no-config');
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task']);
    assert.equal(r.code, 1, `expected exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.match(r.stderr, /no gates are configured/);
    assert.match(r.stderr, /config\.json/);
    assert.equal(agyCalls(sb).length, 0);
    assert.equal((state(sb).jobs || []).length, 0);
  });

  test('--gate-cmd needs no config and never triggers the unknown-gate refusal', async () => {
    const sb = sandbox('gates-cmd-no-config');
    const r = run(sb, ['implement', '--gate-cmd', nodeCmd('process.exit(0)'), '--prompt', 'a task'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
  });

  test('--gate-cmd rejects a multi-line command', () => {
    const sb = sandbox('gates-cmd-newline');
    const r = run(sb, ['implement', '--gate-cmd', 'echo one\necho two', '--prompt', 'a task']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /single-line/);
    assert.equal(agyCalls(sb).length, 0);
  });

  test('declaring gates does not trigger the unrelated round-1 gate-order refusal', async () => {
    const sb = sandbox('gates-no-order-conflict');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'Fix the bug, nothing else.'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
  });
});

describe('a passing gate keeps the job done, with a Companion verification section', () => {
  test('single named gate passes', async () => {
    const sb = sandbox('gates-pass');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const result = jobResultFile(sb, id);
    assert.match(result, /## Companion verification/);
    assert.match(result, /### check/);
    assert.match(result, /Result: passed \(exit 0\)/);
    const statusOut = run(sb, ['status', id]).stdout;
    assert.match(statusOut, /"gate_results"/);
    assert.match(statusOut, /"name":\s*"check"/);
    assert.match(statusOut, /"exit":\s*0/);
  });

  test('the implement prompt tells the worker the companion will run the gate itself', async () => {
    const sb = sandbox('gates-prompt-note');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /the companion runs/);
    assert.match(promptOf(argv), /do not run it yourself/);
  });
});

describe('a failing gate ends attention/gate_failed', () => {
  test('failure exit code, output tail, and preserved response/diff', async () => {
    const sb = sandbox('gates-fail');
    writeGates(sb.repo, { check: nodeCmd("console.log('gate output line'); process.exit(1);") });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const statusR = run(sb, ['status', id]);
    assert.equal(statusR.code, 5);
    assert.match(statusR.stdout, /"reason":\s*"gate_failed"/);
    const result = jobResultFile(sb, id);
    assert.match(result, /Job needs attention: a companion verification gate failed/);
    assert.match(result, /gate output line/);
    assert.match(result, /Result: failed \(exit 1\)/);
    assert.match(result, /## Partial work/);
    assert.match(result, /fake answer/); // the worker's own response is preserved
    const waitR = run(sb, ['wait', id]);
    assert.equal(waitR.code, 5);
  });

  test('stops at the first failing gate — a later gate never runs', async () => {
    const sb = sandbox('gates-stop-first');
    const marker = path.join(sb.root, 'second-gate-ran.txt');
    writeGates(sb.repo, {
      first: nodeCmd('process.exit(1)'),
      second: nodeCmd(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
    });
    const r = run(sb, ['implement', '--gate', 'first,second', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    assert.equal(fs.existsSync(marker), false, 'second gate must not have run');
    const result = jobResultFile(sb, id);
    assert.match(result, /### first/);
    assert.doesNotMatch(result, /### second/);
  });
});

describe('gate timeout', () => {
  test('a gate exceeding --gate-timeout ends gate_failed/timed_out and its process is killed', async () => {
    const sb = sandbox('gates-timeout');
    const pidFile = path.join(sb.root, 'gate.pid');
    writeGates(sb.repo, {
      slow: nodeCmd(`require('fs').writeFileSync(process.env.GATE_PID_FILE, String(process.pid)); setInterval(()=>{}, 1000);`),
    });
    const r = run(sb, ['implement', '--gate', 'slow', '--gate-timeout', '1s', '--prompt', 'a task'],
      { ...touchEnv(sb), GATE_PID_FILE: pidFile });
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const statusOut = run(sb, ['status', id]).stdout;
    assert.match(statusOut, /"reason":\s*"gate_failed"/);
    const result = jobResultFile(sb, id);
    assert.match(result, /timed out after/);
    assert.ok(fs.existsSync(pidFile), 'gate should have started and recorded its own pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(isAlive(pid), false, 'the timed-out gate process must be killed');
  });
});

describe('cancel while verifying', () => {
  test('cancel during a running gate ends canceled and kills the gate process', async () => {
    const sb = sandbox('gates-cancel');
    const pidFile = path.join(sb.root, 'gate-cancel.pid');
    writeGates(sb.repo, {
      slow: nodeCmd(`require('fs').writeFileSync(process.env.GATE_PID_FILE, String(process.pid)); setInterval(()=>{}, 1000);`),
    });
    const r = run(sb, ['implement', '--gate', 'slow', '--gate-timeout', '2m', '--prompt', 'a task'],
      { ...touchEnv(sb), GATE_PID_FILE: pidFile });
    const id = jobIdOf(r.stdout);
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await sleep(50);
    assert.ok(fs.existsSync(pidFile), 'gate should have started before cancel');
    const cancelR = run(sb, ['cancel', id]);
    assert.match(cancelR.stdout, /Canceled job/, cancelR.stdout + cancelR.stderr);
    assert.equal(await waitForJob(sb, id), 'canceled');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(isAlive(pid), false, 'the gate process must be killed on cancel');
  });
});

describe('verification_incomplete: a passing gate supersedes the worker\'s own pending claim', () => {
  test('outcome becomes done, with a note that the pending claim was superseded', async () => {
    const sb = sandbox('gates-supersede');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], {
      ...touchEnv(sb),
      FAKE_AGY_RESPONSE: 'Done. I have started `pnpm build` and am awaiting its completion.',
    });
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const result = jobResultFile(sb, id);
    assert.match(result, /superseded/);
    assert.match(result, /## Companion verification/);
  });
});

describe('gates never run for terminal states that never finished the work', () => {
  test('quota_exhausted skips gates', async () => {
    const sb = sandbox('gates-skip-quota');
    const marker = path.join(sb.root, 'quota-marker.txt');
    writeGates(sb.repo, { check: nodeCmd(`require('fs').writeFileSync(process.env.MARKER, 'ran')`) });
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], { FAKE_AGY_QUOTA: '1', MARKER: marker });
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');
    assert.equal(fs.existsSync(marker), false, 'gate must not have run for a quota_exhausted job');
  });

  test('implement_no_changes (a true no-op) skips gates', async () => {
    const sb = sandbox('gates-skip-noop');
    const marker = path.join(sb.root, 'noop-marker.txt');
    writeGates(sb.repo, { check: nodeCmd(`require('fs').writeFileSync(process.env.MARKER, 'ran')`) });
    // No FAKE_AGY_TOUCH_FILE: the fake worker reports success but leaves the
    // tree exactly as it found it, so implementPostcondition sees a noop.
    const r = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], { MARKER: marker });
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const statusOut = run(sb, ['status', id]).stdout;
    assert.match(statusOut, /"reason":\s*"implement_no_changes"/);
    assert.equal(fs.existsSync(marker), false, 'gate must not have run for a true no-op');
  });

  test('implement_uncommitted skips gates', async () => {
    const sb = sandbox('gates-skip-uncommitted');
    const marker = path.join(sb.root, 'uncommitted-marker.txt');
    writeGates(sb.repo, { check: nodeCmd(`require('fs').writeFileSync(process.env.MARKER, 'ran')`) });
    const r = run(sb, ['implement', '--deliver', 'commit', '--gate', 'check', '--prompt', 'a task'],
      { ...touchEnv(sb), MARKER: marker });
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const statusOut = run(sb, ['status', id]).stdout;
    assert.match(statusOut, /"reason":\s*"implement_uncommitted"/);
    assert.equal(fs.existsSync(marker), false, 'gate must not have run when delivery was requested but never committed');
  });
});

describe('continue and restart inherit gates', () => {
  test('continue inherits the original run\'s gates without repeating --gate', async () => {
    const sb = sandbox('gates-continue-inherit');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const started = run(sb, ['implement', '--gate', 'check', '--prompt', 'first'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['continue', '--prompt', 'second'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const followId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, followId), 'done');
    const result = jobResultFile(sb, followId);
    assert.match(result, /## Companion verification/);
    const calls = await waitForCalls(sb, 2);
    assert.match(promptOf(calls[1]), /the companion runs/);
  });

  test('restart inherits the original job\'s gates', async () => {
    const sb = sandbox('gates-restart-inherit');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const started = run(sb, ['implement', '--gate', 'check', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['restart', id], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const restartId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    assert.match(jobResultFile(sb, restartId), /## Companion verification/);
  });

  test('a new --gate on continue replaces the inherited gates, not adds to them', async () => {
    const sb = sandbox('gates-continue-replace');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)'), build: nodeCmd('process.exit(0)') });
    const started = run(sb, ['implement', '--gate', 'check', '--prompt', 'first'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['continue', '--gate', 'build', '--prompt', 'second'], touchEnv(sb));
    const followId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, followId), 'done');
    const result = jobResultFile(sb, followId);
    assert.match(result, /### build/);
    assert.doesNotMatch(result, /### check/);
  });
});

describe('worktree fallback', () => {
  test('a linked worktree without its own config falls back to the main worktree\'s gates', async () => {
    const sb = sandbox('gates-worktree-fallback');
    writeGates(sb.repo, { check: nodeCmd('process.exit(0)') });
    const commit = spawnSync(
      'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial'],
      { cwd: sb.repo }
    );
    assert.equal(commit.status, 0);
    const other = path.join(sb.root, 'other-worktree');
    assert.equal(spawnSync('git', ['worktree', 'add', '--detach', other], { cwd: sb.repo }).status, 0);
    assert.equal(fs.existsSync(path.join(other, '.agy-staff', 'config.json')), false, 'the linked worktree has no config of its own');

    const otherSb = { ...sb, repo: other };
    const r = run(otherSb, ['implement', '--gate', 'check', '--prompt', 'a task'], {
      FAKE_AGY_TOUCH_FILE: path.join(other, 'agy-wrote.txt'),
    });
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(otherSb, id), 'done');
    assert.match(jobResultFile(otherSb, id), /## Companion verification/);
  });
});

describe('phase visibility', () => {
  test('phase "verifying" and the running gate name are visible in status while a gate runs', async () => {
    const sb = sandbox('gates-phase-visible');
    writeGates(sb.repo, { slow: nodeCmd('setInterval(() => {}, 1000);') });
    const r = run(sb, ['implement', '--gate', 'slow', '--gate-timeout', '3s', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    let sawVerifying = false;
    for (let i = 0; i < 100; i++) {
      const s = run(sb, ['status', id]);
      if (/"phase":\s*"verifying"/.test(s.stdout) && /"verifying_gate":\s*"slow"/.test(s.stdout)) {
        sawVerifying = true;
        break;
      }
      await sleep(50);
    }
    assert.ok(sawVerifying, 'expected phase=verifying and verifying_gate=slow to appear in status while the gate runs');
    assert.equal(await waitForJob(sb, id), 'attention'); // times out at 3s
  });
});
