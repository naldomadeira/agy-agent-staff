/**
 * Fase 2 item 1: `## Decision discipline` in templates/implement.md.
 *
 * Background: the production incident report that documented "an
 * orchestrator's briefing told the implement worker to run pnpm check/build,
 * and the worker spent its whole run on the gate" fell into the same trap
 * hours later in the same session — a text warning without enforcement
 * doesn't hold. This section names the discipline directly in the prompt the
 * worker actually reads: report contradictions instead of working around
 * them, follow project rules over invented "robust" fallbacks, name who
 * reaches a new code path in production, and respect the time budget instead
 * of running long baselines/gates unless explicitly authorized.
 *
 * Only `implement` gets this section; every other template is unchanged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, jobIdOf, waitForJob, waitForCalls, promptOf } from './helpers.mjs';

function specOf(sb, id) {
  const file = path.join(sb.repo, '.agy-staff', 'jobs', `${id}.spec.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// implement's own postcondition (Fase 1) flags a run "attention" when agy
// reports success but touched nothing — unrelated to this section, but any
// implement run here that is meant to reach "done" needs its own delta. Each
// call gets a distinct file so a restart doesn't inherit the original call's
// already-dirty path as its own (fake) delta.
let touchCounter = 0;
function touchEnv(sb) {
  return { FAKE_AGY_TOUCH_FILE: path.join(sb.repo, `agy-wrote-${++touchCounter}.txt`) };
}

describe('implement prompt carries the Decision discipline section', () => {
  test('default timeout renders as "60 minutes" and all four rules are present', async () => {
    const sb = sandbox('discipline-default');
    const r = run(sb, ['implement', '--prompt', 'a task'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    const prompt = promptOf(argv);
    assert.match(prompt, /## Decision discipline/);
    assert.match(prompt, /contradicted by the code, stop and report the contradiction with file:line evidence/);
    assert.match(prompt, /A project rule \(AGENTS\.md, conventions, existing patterns\) beats a "robust" fallback you invent\./);
    assert.match(prompt, /name who reaches it in production/);
    assert.match(prompt, /You have about 60 minutes\./);
    assert.match(prompt, /Do not run long baselines or full gates/);
    assert.doesNotMatch(prompt, /\{\{TIME_BUDGET\}\}/);
    assert.doesNotMatch(prompt, /\{\{GATE_AUTHORIZATION\}\}/);
  });

  test('--timeout renders the actual budget, not the default', async () => {
    const sb = sandbox('discipline-custom-timeout');
    const r = run(sb, ['implement', '--timeout', '5m', '--prompt', 'a task'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /You have about 5 minutes\./);
  });

  test('a singular-unit timeout is not pluralized', async () => {
    const sb = sandbox('discipline-singular-timeout');
    const r = run(sb, ['implement', '--timeout', '1h', '--prompt', 'a task'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /You have about 1 hour\./);
  });

  test('no --allow-gate authorization line when nothing was authorized', async () => {
    const sb = sandbox('discipline-no-gate-line');
    const r = run(sb, ['implement', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    assert.doesNotMatch(promptOf(argv), /The caller authorized running:/);
  });
});

describe('other modes are unaffected', () => {
  for (const [mode, promptArg] of [
    ['staffer', 'do a thing'],
    ['research', 'survey a thing'],
    ['review', 'Review the current working tree'],
    ['ask', 'what is 2+2?'],
  ]) {
    test(`${mode} prompt has no Decision discipline section`, async () => {
      const sb = sandbox(`discipline-absent-${mode}`);
      const r = run(sb, [mode, '--prompt', promptArg]);
      assert.equal(r.code, 0, r.stderr);
      // ask is synchronous (no job); every other mode here is a background job.
      if (mode !== 'ask') assert.equal(await waitForJob(sb, jobIdOf(r.stdout)), 'done');
      const [argv] = await waitForCalls(sb, 1);
      const prompt = promptOf(argv);
      assert.doesNotMatch(prompt, /Decision discipline/);
      assert.doesNotMatch(prompt, /\{\{TIME_BUDGET\}\}/);
      assert.doesNotMatch(prompt, /\{\{GATE_AUTHORIZATION\}\}/);
    });
  }
});

describe('job spec persistence', () => {
  test('stores the original task, the rendered prompt, and policy_version for implement', async () => {
    const sb = sandbox('discipline-spec-implement');
    const r = run(sb, ['implement', '--prompt', 'fix the thing'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const spec = specOf(sb, id);
    assert.equal(spec.prompt_source.task, 'fix the thing');
    assert.match(spec.prompt, /## Decision discipline/);
    assert.match(spec.prompt, /fix the thing/);
    assert.equal(spec.policy_version, 'implement-discipline-1');
  });

  test('policy_version is null for a non-implement mode', async () => {
    const sb = sandbox('discipline-spec-staffer');
    const r = run(sb, ['staffer', '--prompt', 'do a thing']);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    assert.equal(specOf(sb, id).policy_version, null);
  });
});

describe('restart re-renders the section with the fresh timeout', () => {
  test('restart without --timeout reuses the mode default', async () => {
    const sb = sandbox('discipline-restart-default');
    const started = run(sb, ['implement', '--timeout', '5m', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['restart', id], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const restartId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    const [, restartArgv] = await waitForCalls(sb, 2);
    assert.match(promptOf(restartArgv), /You have about 60 minutes\./);
  });

  test('restart --timeout renders the new budget', async () => {
    const sb = sandbox('discipline-restart-custom');
    const started = run(sb, ['implement', '--prompt', 'a task'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['restart', id, '--timeout', '10m'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const restartId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    const [, restartArgv] = await waitForCalls(sb, 2);
    assert.match(promptOf(restartArgv), /You have about 10 minutes\./);
  });

  test('restart of a legacy spec (no policy_version, no prompt_source) still works', async () => {
    const sb = sandbox('discipline-restart-legacy');
    const stateDir = path.join(sb.repo, '.agy-staff');
    const jobsDir = path.join(stateDir, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const id = 'implement-legacy-discipline';
    const specFile = path.join(jobsDir, `${id}.spec.json`);
    fs.writeFileSync(specFile, JSON.stringify({
      resolved: { mode: 'implement', model: 'gemini-3.8-flash-high', profile: 'unrestricted', background: true, timeout: '60m' },
      prompt: 'Fix the old thing, no gate order here.',
      cwd: sb.repo,
    }, null, 2));
    const resultFile = path.join(jobsDir, `${id}.result.md`);
    fs.writeFileSync(resultFile, 'done\n');
    const stateFile = path.join(stateDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ jobs: [{
      id, mode: 'implement', status: 'done', pid: null, cwd: sb.repo,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      spec_file: specFile, result_file: resultFile, log_file: path.join(jobsDir, `${id}.log`),
    }] }, null, 2));

    const r = run(sb, ['restart', id], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const restartId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    // The new job's own spec still gets a fresh policy_version, even though
    // the job it restarted from had none.
    assert.equal(specOf(sb, restartId).policy_version, 'implement-discipline-1');
  });
});
