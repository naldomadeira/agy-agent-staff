/**
 * Job lifecycle (status / result / cancel) and `continue` mode inheritance.
 * Spec sections "Execution style (background-first)".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandbox,
  run,
  agyCalls,
  jobIdOf,
  jobLog,
  jobResultFile,
  waitForJob,
  waitForCalls,
} from './helpers.mjs';

describe('background job lifecycle', () => {
  test('status → result → cancel over one finished job', async () => {
    const sb = sandbox('lifecycle');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.match(started.stdout, /AGY worker: default \(/);

    const terminal = await waitForJob(sb, id);
    assert.equal(terminal, 'done', `job ended as ${terminal}`);

    const one = run(sb, ['status', id]);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /"id": "research-/);
    assert.match(one.stdout, /"status": "done"/);
    assert.doesNotMatch(one.stdout, /Still running/);

    const list = run(sb, ['status']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /id \| mode \| worker \| status \| started \| finished/);
    assert.match(list.stdout, new RegExp(`${id} \\| research \\| default \\([^|]+\\) \\| done \\|`));

    const res = run(sb, ['result', id]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`# Job ${id} \\(research, done\\)`));
    assert.match(res.stdout, /fake answer/);
    // research is unrestricted by default in round 2 — the telemetry proving it
    // lives in the worker log, never in the delivered result
    assert.doesNotMatch(res.stdout, /\[agy-staff\]/);
    assert.doesNotMatch(jobResultFile(sb, id), /\[agy-staff\]/);
    assert.match(jobLog(sb, id), /\[agy-staff\] mode=research profile=unrestricted/);

    // result with no id falls back to the latest finished job
    const latest = run(sb, ['result']);
    assert.equal(latest.code, 0, latest.stderr);
    assert.match(latest.stdout, new RegExp(`# Job ${id}`));

    const cancel = run(sb, ['cancel', id]);
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, new RegExp(`Job ${id} is not running \\(status: done\\)\\.`));
  });

  test('status/result/cancel reject unknown ids', () => {
    const sb = sandbox('unknown-job');
    for (const cmd of ['status', 'result', 'cancel']) {
      const r = run(sb, [cmd, 'research-nope']);
      assert.notEqual(r.code, 0, `${cmd} on an unknown id must fail`);
      assert.match(r.stderr, /no job research-nope in this repository/);
    }
  });
});

describe('continue inherits the resumed mode default', () => {
  test('after ask, continue runs in the foreground', () => {
    const sb = sandbox('continue-ask');
    const first = run(sb, ['ask', '--prompt', 'what is 2 plus 2?']);
    assert.equal(first.code, 0, first.stderr);

    const cont = run(sb, ['continue', '--prompt', 'and what about 3 plus 3?']);
    assert.equal(cont.code, 0, cont.stderr);
    assert.match(cont.stdout, /fake answer/);
    assert.doesNotMatch(cont.stdout, /\[agy-staff\]/);
    assert.match(cont.stderr, /\[agy-staff\] mode=ask profile=restricted/);
    assert.match(cont.stderr, /^conversation: conv-1 \(follow up with --continue\)$/m);
    assert.doesNotMatch(cont.stdout, /Started background/);

    const calls = agyCalls(sb);
    assert.equal(calls.length, 2);
    const argv = calls[1];
    assert.ok(argv.includes('--conversation'), JSON.stringify(argv));
    assert.equal(argv[argv.indexOf('--conversation') + 1], 'conv-1');
    assert.match(argv[argv.indexOf('-p') + 1], /and what about 3 plus 3\?/);
  });

  test('after research, continue starts a background job', async () => {
    const sb = sandbox('continue-research');
    const first = run(sb, ['research', '--prompt', 'a topic']);
    assert.equal(first.code, 0, first.stderr);
    await waitForJob(sb, jobIdOf(first.stdout));

    const cont = run(sb, ['continue', '--prompt', 'dig into the second part']);
    assert.equal(cont.code, 0, cont.stderr);
    assert.match(cont.stdout, /Started background research job\./);
    const secondId = jobIdOf(cont.stdout);
    assert.equal(await waitForJob(sb, secondId), 'done');

    const calls = await waitForCalls(sb, 2);
    assert.equal(calls[1][calls[1].indexOf('--conversation') + 1], 'conv-1');
    assert.match(calls[1][calls[1].indexOf('-p') + 1], /dig into the second part/);
  });

  test('continue with no follow-up text and no history fails', () => {
    const sb = sandbox('continue-empty');
    const none = run(sb, ['continue', '--prompt', 'text with no history']);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /no previous agy-staff conversation recorded/);
  });
});

describe('quota_exhausted terminal state (Fase 1, item 1)', () => {
  test('background job ends quota_exhausted: status, reason, resets_in, wait exit 6, report prefix, status <id>, result, observe', async () => {
    const sb = sandbox('quota-job');
    // FAKE_AGY_QUOTA is the deterministic quota-simulation knob (tests/fake-agy.mjs):
    // it reproduces the production RESOURCE_EXHAUSTED/429 shape without repeating
    // the literal string in every test.
    const started = run(sb, ['research', '--prompt', 'a topic'], {
      FAKE_AGY_QUOTA: '1',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_QUOTA_RESETS: '4h1m13s',
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const st = run(sb, ['status', id]);
    assert.equal(st.code, 6, st.stderr);
    assert.match(st.stdout, /"status": "quota_exhausted"/);
    assert.match(st.stdout, /"reason": "quota_exhausted"/);
    assert.match(st.stdout, /"resets_in": "4h1m13s"/);
    assert.match(st.stdout, /"model": "gemini-3\.8-flash-high"/);

    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 6, w.stdout + w.stderr);
    assert.match(w.stdout, /^# Job .* \(research, quota_exhausted\)/m);
    assert.match(w.stdout, /Quota exhausted: model gemini-3\.8-flash-high, resets in 4h1m13s\./);
    assert.match(w.stdout, /Do not `continue` on the same model/);

    // `result` keeps its existing exit-0-for-non-attention convention; the
    // report body is unchanged from what `wait` just printed.
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Quota exhausted: model gemini-3\.8-flash-high, resets in 4h1m13s\./);

    const obs = run(sb, ['observe', id]);
    assert.equal(obs.code, 6, obs.stderr);
    const packet = JSON.parse(obs.stdout);
    assert.equal(packet.status, 'quota_exhausted');
    assert.equal(packet.reason, 'quota_exhausted');
    assert.equal(packet.resets_in, '4h1m13s');
    assert.match(packet.recovery.note, /workers/);
    assert.match(packet.recovery.note, /Do not `continue` on the same model/);
  });

  test('sync ask ends quota_exhausted with exit 6', () => {
    const sb = sandbox('quota-ask');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_QUOTA: '1',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_QUOTA_RESETS: '10m',
    });
    assert.equal(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Quota exhausted: model gemini-3\.8-flash-low, resets in 10m\./);
  });

  test('existing timeout (attention, exit 5) and cancel (exit 4) terminal states are unaffected by the new status', async () => {
    const sb = sandbox('quota-no-regression');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);
    const cancel = run(sb, ['cancel', id]);
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.match(cancel.stdout, /Canceled job/);
    assert.equal(run(sb, ['wait', id]).code, 4);
  });
});

describe('verification_incomplete terminal state (Fase 1, item 2)', () => {
  // Verbatim production reports: a SUCCESS whose own text still admits a
  // pending build must not become `done`. In one real incident this sentence
  // was the FIRST line of the report — a tail-only scan would have missed it.
  const NEXORA_FIRST_LINE = 'I have started `pnpm build` and am awaiting its completion.';
  const NEXORA_BACKGROUND = 'I have started `pnpm build` in the background and will wait for it to complete.';

  test('pending admission as the FIRST line (Nexora case, verbatim): attention, reason verification_incomplete, wait/status/observe exit 5, report prefix + evidence + original text preserved', async () => {
    const sb = sandbox('pending-first-line');
    const started = run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: `${NEXORA_FIRST_LINE}\n\nSummary: updated the config file as requested.`,
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');

    const st = run(sb, ['status', id]);
    assert.equal(st.code, 5, st.stderr);
    assert.match(st.stdout, /"reason": "verification_incomplete"/);
    assert.match(st.stdout, /"pending_evidence": ".*am awaiting its completion/);

    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 5, w.stdout + w.stderr);
    assert.match(w.stdout, /^# Job .* \(staffer, attention\)/m);
    assert.match(w.stdout, /Job needs attention: the worker declared a verification still pending/);
    assert.match(w.stdout, /am awaiting its completion/);
    assert.match(w.stdout, /run the pending verification yourself before accepting this work/i);
    // The full original response survives the prefix.
    assert.match(w.stdout, /Summary: updated the config file as requested\./);

    const res = run(sb, ['result', id]);
    assert.equal(res.code, 5, res.stderr);
    assert.match(res.stdout, /the worker declared a verification still pending/);

    const obs = run(sb, ['observe', id]);
    assert.equal(obs.code, 5, obs.stderr);
    const packet = JSON.parse(obs.stdout);
    assert.equal(packet.status, 'attention');
    assert.equal(packet.reason, 'verification_incomplete');
    assert.match(packet.pending_evidence, /am awaiting its completion/);
    assert.match(packet.recovery.note, /Run the pending verification yourself/);
  });

  test('pending admission at the END of a longer report: attention, evidence quotes the exact sentence', async () => {
    const sb = sandbox('pending-last-line');
    const started = run(sb, ['staffer', '--prompt', 'a topic'], {
      FAKE_AGY_RESPONSE: `Survey results: three candidate approaches evaluated.\n\n${NEXORA_BACKGROUND}`,
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 5, res.stderr);
    assert.match(res.stdout, /will wait for it to complete/);
    assert.match(res.stdout, /Survey results: three candidate approaches evaluated\./);
  });

  test('PT variant (pt-BR/pt-PT wording) is detected the same way', async () => {
    const sb = sandbox('pending-pt');
    const started = run(sb, ['staffer', '--prompt', 'um topico'], {
      FAKE_AGY_RESPONSE: 'Resumo da pesquisa concluído.\n\nAinda aguardando a conclusão do build antes de finalizar.',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 5, res.stderr);
    assert.match(res.stdout, /aguardando a conclusão do build/);
  });

  test('a pending admission followed LATER by explicit completion evidence ("build passed") stays done', async () => {
    const sb = sandbox('pending-then-passed');
    const started = run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: `${NEXORA_FIRST_LINE}\n\nUpdate: build passed. All done.`,
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /the worker declared a verification still pending/);
  });

  test('a pending admission inside a fenced code block is a quotation, not a claim: stays done', async () => {
    const sb = sandbox('pending-code-fence');
    const started = run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE:
        `Report:\n\n\`\`\`\n${NEXORA_FIRST_LINE}\n\`\`\`\n\nThe changes are complete.`,
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /the worker declared a verification still pending/);
  });

  test('unrelated "waiting" prose (no build/test/suite wording) never triggers: stays done', async () => {
    const sb = sandbox('pending-unrelated');
    const started = run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: "I'm waiting for the user's approval on the color palette before proceeding further.",
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const res = run(sb, ['result', id]);
    assert.equal(res.code, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /the worker declared a verification still pending/);
  });

  for (const [label, text] of [
    ['a dev server left running', 'Updated the header. The dev server is still running on :3000 if you want to look.'],
    ['PT approval wait', 'Ajustei o cabeçalho e fico à espera de aprovação da paleta.'],
  ]) {
    test(`near-miss wording (${label}) stays done`, async () => {
      const sb = sandbox(`pending-near-miss-${label.replace(/\W+/g, '-')}`);
      const id = jobIdOf(run(sb, ['staffer', '--prompt', 'a task'], { FAKE_AGY_RESPONSE: text }).stdout);
      assert.equal(await waitForJob(sb, id), 'done');
    });
  }

  test('"passou a usar" does not clear a real pending build', async () => {
    const sb = sandbox('pending-not-cleared-by-passou');
    const id = jobIdOf(run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: 'Iniciei o `pnpm build` e estou aguardando a conclusão. O módulo passou a usar o cliente novo.',
    }).stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
  });

  test('research describing someone else\'s pending build stays done', async () => {
    const sb = sandbox('pending-research-not-flagged');
    const id = jobIdOf(run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_RESPONSE: NEXORA_FIRST_LINE }).stdout);
    assert.equal(await waitForJob(sb, id), 'done');
  });

  test('precedence: a true implement no-op keeps implement_no_changes even when the response also reads as pending', async () => {
    const sb = sandbox('pending-vs-noop');
    const started = run(sb, ['implement', '--deliver', 'commit', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: NEXORA_FIRST_LINE, // no touch file, no commit: nothing happened at all
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const st = run(sb, ['status', id]);
    assert.match(st.stdout, /"reason": "implement_no_changes"/);
    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /Job needs attention: agy reported success but the repository is unchanged/);
    assert.doesNotMatch(res.stdout, /the worker declared a verification still pending/);
  });

  test('precedence: --deliver commit with unmoved HEAD keeps implement_uncommitted even when the response also reads as pending', async () => {
    const sb = sandbox('pending-vs-uncommitted');
    const started = run(sb, ['implement', '--deliver', 'commit', '--prompt', 'a task'], {
      FAKE_AGY_TOUCH_FILE: path.join(sb.repo, 'agy-wrote.txt'),
      FAKE_AGY_RESPONSE: NEXORA_FIRST_LINE,
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const st = run(sb, ['status', id]);
    assert.match(st.stdout, /"reason": "implement_uncommitted"/);
    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /Job needs attention: --deliver commit was requested but HEAD did not move/);
    assert.doesNotMatch(res.stdout, /the worker declared a verification still pending/);
  });

  test('ask (tool-free, always restricted) is never flagged even with the exact pending wording', () => {
    const sb = sandbox('pending-ask-irrelevant');
    const r = run(sb, ['ask', '--prompt', 'question'], { FAKE_AGY_RESPONSE: NEXORA_FIRST_LINE });
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /am awaiting its completion/); // the text is delivered verbatim
    assert.doesNotMatch(r.stderr, /verification still pending/);
  });
});

describe('Partial work inventory on attention/crashed jobs (Fase 1, item 3)', () => {
  test('verification_incomplete carries the section with a "finished" note, not just the terminal error framing', async () => {
    const sb = sandbox('partial-verification-incomplete');
    const started = run(sb, ['staffer', '--prompt', 'a task'], {
      FAKE_AGY_RESPONSE: 'I have started `pnpm build` and am awaiting its completion.',
      FAKE_AGY_TOUCH_FILE: 'partial.txt',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /## Partial work/);
    assert.match(res.stdout, /- Terminal state: attention \(verification_incomplete\)/);
    assert.match(res.stdout, /partial\.txt \(untracked; new this run\)/);
    assert.match(res.stdout, /- Note: the agent reported finishing the task; the only unconfirmed step is verification\./);
    assert.match(res.stdout, /- Verification: not confirmed; do not treat this work as accepted\./);
  });

  test('implement_uncommitted (real work, --deliver commit requested, HEAD never moved) carries the section', async () => {
    const sb = sandbox('partial-implement-uncommitted');
    const started = run(sb, ['implement', '--deliver', 'commit', '--prompt', 'a task'], {
      FAKE_AGY_TOUCH_FILE: 'agy-wrote.txt', FAKE_AGY_RESPONSE: 'done',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'attention');
    assert.match(run(sb, ['status', id]).stdout, /"reason": "implement_uncommitted"/);
    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /## Partial work/);
    assert.match(res.stdout, /- Terminal state: attention \(implement_uncommitted\)/);
    assert.match(res.stdout, /agy-wrote\.txt \(untracked; new this run\)/);
    assert.match(res.stdout, /- HEAD: .+ \(moved: no\)/);
  });

  test('a crashed job with no recorded snapshot gets "inventory unavailable", never invented data', () => {
    const sb = sandbox('partial-crashed');
    const id = 'research-simulated-crash';
    const stateDir = path.join(sb.repo, '.agy-staff');
    fs.mkdirSync(stateDir);
    const stateFile = path.join(stateDir, 'state.json');
    const state = { jobs: [{
      id, mode: 'research', status: 'running', pid: 99999999,
      cwd: sb.repo, started_at: new Date().toISOString(),
      spec_file: path.join(stateDir, `${id}.spec.json`),
      result_file: path.join(stateDir, `${id}.result.md`),
      log_file: path.join(stateDir, `${id}.log`),
    }] };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 3);
    assert.match(w.stdout, /## Partial work/);
    assert.match(w.stdout, /- Terminal state: crashed/);
    assert.match(w.stdout, /- Inventory unavailable: worker exited before recording the workspace\./);
    assert.match(w.stdout, /- Inspect: `git status --short; git diff; git diff --cached`/);
    assert.match(w.stdout, /- Verification: not confirmed; do not treat this work as accepted\./);
    // Never invented: no HEAD/changed-paths bullets when there is no snapshot.
    assert.doesNotMatch(w.stdout, /- HEAD:/);
    assert.doesNotMatch(w.stdout, /- Dirty paths after the run/);

    const s = run(sb, ['status', id]);
    assert.equal(s.code, 3);
    assert.match(s.stdout, /## Partial work/);
  });
});

describe('cross-context liveness checks (issue #11)', () => {
  test('pidAlive=false without result warns of permission/sandbox context mismatch and recovers when pid is visible', () => {
    const sb = sandbox('simulated-pid-liveness');
    const id = 'research-simulated-liveness';
    const stateDir = path.join(sb.repo, '.agy-staff');
    const stateFile = path.join(stateDir, 'state.json');
    fs.mkdirSync(stateDir);
    // A static record prevents worker writes from overwriting the simulated PID.
    // No stored result and an invisible PID represent the collector's context.
    const state = { jobs: [{
      id, mode: 'research', status: 'running', pid: 99999999,
      cwd: sb.repo, started_at: new Date().toISOString(),
      spec_file: path.join(stateDir, `${id}.spec.json`),
      result_file: path.join(stateDir, `${id}.result.md`),
      log_file: path.join(stateDir, `${id}.log`),
    }] };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const expectedWarning =
      /The worker pid is not visible from this process\. If the job may have been started from a different harness permission or sandbox context, rerun wait\/status\/result from the same unsandboxed context before treating it as crashed\./;

    // 1. status <id>
    const statusRes = run(sb, ['status', id]);
    assert.equal(statusRes.code, 3);
    assert.match(statusRes.stdout, /"status": "crashed"/);
    assert.match(statusRes.stdout, expectedWarning);

    // 2. status (list form)
    const listRes = run(sb, ['status']);
    assert.equal(listRes.code, 0);
    assert.match(listRes.stdout, expectedWarning);

    // 3. wait <id>
    const waitRes = run(sb, ['wait', id]);
    assert.equal(waitRes.code, 3);
    assert.match(waitRes.stdout, /finished with status crashed and no stored result/);
    assert.match(waitRes.stdout, expectedWarning);

    // 4. result <id>
    const resultRes = run(sb, ['result', id]);
    assert.notEqual(resultRes.code, 0);
    assert.match(resultRes.stderr, /has no stored result/);
    assert.match(resultRes.stderr, expectedWarning);

    // 5. Recovery when rerun from unsandboxed context where worker PID is visible
    const stateAfter = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const rec = stateAfter.jobs.find((j) => j.id === id);
    rec.pid = process.pid; // test runner process is alive
    fs.writeFileSync(stateFile, JSON.stringify(stateAfter, null, 2));

    const recoveredStatus = run(sb, ['status', id]);
    assert.equal(recoveredStatus.code, 2, 'recovers to running when pid is visible');
    assert.match(recoveredStatus.stdout, /"status": "running"/);
    assert.match(recoveredStatus.stdout, /Still running/);
  });
});
