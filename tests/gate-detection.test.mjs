/**
 * Fase 2 item 2: pre-dispatch refusal of a briefing that orders agy to run a
 * long gate (build/test/check suite) itself. Spec sections "detectGateOrder",
 * "checkGateOrder", "--allow-gate".
 *
 * Background: the production incident this guards against ran on the exact
 * phrase "Run `pnpm check` and `pnpm build` to confirm the state of the
 * project." — the worker spent its whole run on the gate and delivered zero
 * files. The refusal must land BEFORE any job is created and BEFORE agy is
 * ever invoked, so the caller can fix the briefing (or authorize the gate)
 * without burning a run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, agyCalls, jobIdOf, waitForJob, waitForCalls, promptOf } from './helpers.mjs';

function state(sb) {
  const file = path.join(sb.repo, '.agy-staff', 'state.json');
  if (!fs.existsSync(file)) return { jobs: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function specOf(sb, id) {
  const file = path.join(sb.repo, '.agy-staff', 'jobs', `${id}.spec.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// implement's own postcondition (Fase 1) flags a run "attention" when agy
// reports success but touched nothing — unrelated to gate detection, but any
// implement run here that is meant to reach "done" needs its own delta. Each
// call gets a distinct file so a follow-up/restart doesn't inherit the prior
// call's already-dirty path as its own (fake) delta.
let touchCounter = 0;
function touchEnv(sb) {
  return { FAKE_AGY_TOUCH_FILE: path.join(sb.repo, `agy-wrote-${++touchCounter}.txt`) };
}

describe('detectGateOrder: positive orders refuse before dispatch', () => {
  const POSITIVE_CASES = [
    [
      'the verbatim incident phrasing',
      'Fix the bug in src/index.js. Run `pnpm check` and `pnpm build` to confirm the state of the project.',
      /pnpm check/,
    ],
    ['a fenced code block', 'Fix the bug.\n\n```\npnpm build\n```\n', /pnpm build/],
    ['a list item', 'Steps:\n\n- pnpm test\n- ship it\n', /pnpm test/],
    ['bare npm test (no "run")', 'Fix the bug, then run `npm test` to be sure.', /npm test/],
    ['npm run build', 'Fix the bug. Then run `npm run build`.', /npm run build/],
    ['pytest', 'Fix the bug. Run pytest afterward.', /pytest/],
    ['cargo test', 'Fix the bug. Run cargo test afterward.', /cargo test/],
    ['cargo build', 'Fix the bug. Execute cargo build afterward.', /cargo build/],
    ['go test', 'Fix the bug. Run go test ./... afterward.', /go test/],
    ['next build', 'Fix the bug. Confirm with next build.', /next build/],
    ['bare tsc, no file args', 'Fix the bug. Run tsc to check types.', /tsc/],
    ['PT imperative "rode"', 'Corrige o bug. Rode `pnpm build` no final.', /pnpm build/],
    ['PT imperative "corra"', 'Corrige o bug. Corra `pnpm test` no final.', /pnpm test/],
    ['"confirm with"', 'Fix the bug. Confirm with `pnpm build`.', /pnpm build/],
    ['"verify with"', 'Fix the bug. Verify with `pnpm check`.', /pnpm check/],
    ['"then run"', 'Fix the bug, then run `pnpm build`.', /pnpm build/],
  ];

  for (const [label, prompt, commandRe] of POSITIVE_CASES) {
    test(`${label} is refused before any job or agy call`, () => {
      const sb = sandbox(`gate-positive-${label.replace(/[^a-z0-9]+/gi, '-')}`);
      const r = run(sb, ['implement', '--prompt', prompt]);
      assert.equal(r.code, 1, `expected exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
      assert.match(r.stderr, commandRe);
      assert.match(r.stderr, /--allow-gate/);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
      assert.equal((state(sb).jobs || []).length, 0, 'no job may be created');
    });
  }

  test('tsc with a file argument is not treated as a full gate', () => {
    const sb = sandbox('gate-tsc-targeted');
    const started = run(sb, ['implement', '--prompt', 'Fix the bug. Run tsc src/index.ts to check it.']);
    assert.equal(started.code, 0, started.stderr);
  });
});

describe('detectGateOrder: targeted test commands are allowed, not gates', () => {
  // build/check/lint/typecheck/next build/cargo build/bare tsc are
  // whole-project by nature and stay gates no matter what follows them (see
  // the describe block above). Test commands (pm test, pytest, cargo test,
  // go test) are only a gate when nothing after them narrows the run to
  // specific tests — these all narrow it, so none of them should refuse.
  const TARGETED_CASES = [
    ['pm test with a file path', 'Fix the bug. Run `pnpm test src/foo.test.ts` for the changed file.'],
    ['pm test with -- and a file path', 'Fix the bug. Then run `npm test -- --run src/x.test.ts`.'],
    ['pytest with a file path', 'Fix the bug. Run `pytest tests/test_x.py`.'],
    ['pytest with -k', 'Fix the bug. Run `pytest -k test_name`.'],
    ['pytest with a node id', 'Fix the bug. Run `pytest tests/test_x.py::test_y`.'],
    ['go test with a specific package path', 'Fix the bug. Run `go test ./pkg/foo/...` for that package.'],
    ['cargo test with a bare test name', 'Fix the bug. Run `cargo test some_test_name` to confirm.'],
    ['cargo test with -p', 'Fix the bug. Run `cargo test -p crate` to confirm.'],
    ['pm test with -t', 'Fix the bug. Run `pnpm test -t "name"` to confirm.'],
    ['npx vitest run with a file path', 'Fix the bug. Run `npx vitest run src/a.test.ts` to confirm.'],
    ['pnpm --filter scoping test', 'Fix the bug. Run `pnpm --filter web test` to confirm.'],
  ];

  for (const [label, prompt] of TARGETED_CASES) {
    test(`${label} dispatches normally (not treated as a gate)`, async () => {
      const sb = sandbox(`gate-targeted-${label.replace(/[^a-z0-9]+/gi, '-')}`);
      const r = run(sb, ['implement', '--prompt', prompt], touchEnv(sb));
      assert.equal(r.code, 0, `expected dispatch to succeed (stdout: ${r.stdout} stderr: ${r.stderr})`);
      const id = jobIdOf(r.stdout);
      assert.equal(await waitForJob(sb, id), 'done');
    });
  }

  const STILL_GATE_CASES = [
    ['go test ./... (the full suite, not a specific package)', 'Fix the bug. Run `go test ./...` to confirm.', /go test/],
    ['bare pytest', 'Fix the bug. Run `pytest` to confirm.', /pytest/],
    ['bare pnpm test', 'Fix the bug. Run `pnpm test` to confirm.', /pnpm test/],
    ['bare npm test', 'Fix the bug. Run `npm test` to confirm.', /npm test/],
  ];

  for (const [label, prompt, commandRe] of STILL_GATE_CASES) {
    test(`${label} is still refused`, () => {
      const sb = sandbox(`gate-still-gate-${label.replace(/[^a-z0-9]+/gi, '-')}`);
      const r = run(sb, ['implement', '--prompt', prompt]);
      assert.equal(r.code, 1, `expected exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
      assert.match(r.stderr, commandRe);
      assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
    });
  }
});

describe('detectGateOrder: negation and descriptive prose are not orders', () => {
  const NEGATIVE_CASES = [
    ["EN: don't run", "Fix the bug. Don't run `pnpm build` — CI already covers it."],
    ['EN: do not run', 'Fix the bug. Do not run `pnpm test` yourself.'],
    ['EN: never run', 'Fix the bug. Never run `pnpm build` from this task.'],
    ['EN: avoid running', 'Fix the bug. Avoid running `pnpm test` — it is slow.'],
    ['PT: não rode', 'Corrige o bug. Não rode `pnpm build` — o CI já cobre isso.'],
    ['PT: não corra', 'Corrige o bug. Não corra `pnpm test` aqui.'],
    ['PT: não execute', 'Corrige o bug. Não execute `pnpm check` manualmente.'],
    ['PT: sem rodar', 'Corrige o bug sem rodar `pnpm test` — isso é feito depois.'],
    ['EN prose: describes what CI does', 'Fix the bug. The CI runs pnpm build on every push, so you do not need to.'],
    ['EN prose: describes a failure', 'Fix the bug. Note: `pnpm build` fails today for an unrelated reason.'],
    ['PT prose: describes coverage', 'Corrige o bug. O teste cobre build, não precisas de nada extra.'],
    ['PT prose: explains a known failure', 'Corrige o bug. O `pnpm build` falha hoje por causa de outra coisa.'],
  ];

  for (const [label, prompt] of NEGATIVE_CASES) {
    test(`${label} dispatches normally (not treated as an order)`, async () => {
      const sb = sandbox(`gate-negative-${label.replace(/[^a-z0-9]+/gi, '-')}`);
      const r = run(sb, ['implement', '--prompt', prompt], touchEnv(sb));
      assert.equal(r.code, 0, `expected dispatch to succeed (stdout: ${r.stdout} stderr: ${r.stderr})`);
      const id = jobIdOf(r.stdout);
      assert.equal(await waitForJob(sb, id), 'done');
    });
  }
});

describe('detectGateOrder applies to implement only', () => {
  for (const mode of ['staffer', 'research', 'review']) {
    test(`${mode} is never blocked by a gate order in its prompt`, async () => {
      const sb = sandbox(`gate-scope-${mode}`);
      const prompt = mode === 'review'
        ? 'Review PR #730. Run `pnpm build` to confirm the state of the project.'
        : 'Survey the codebase. Run `pnpm build` to confirm the state of the project.';
      const r = run(sb, [mode, '--prompt', prompt]);
      assert.equal(r.code, 0, r.stderr);
      const id = jobIdOf(r.stdout);
      assert.equal(await waitForJob(sb, id), 'done');
    });
  }
});

describe('--allow-gate authorizes the run', () => {
  test('bypasses the refusal and dispatches', async () => {
    const sb = sandbox('gate-allow-dispatch');
    const r = run(sb, ['implement', '--allow-gate', '--prompt', 'Fix the bug. Run `pnpm build` to confirm.'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
  });

  test('is recorded in the job spec so restart can inherit it', async () => {
    const sb = sandbox('gate-allow-spec');
    const r = run(sb, ['implement', '--allow-gate', '--prompt', 'Fix the bug. Run `pnpm build` to confirm.'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    await waitForJob(sb, id);
    assert.equal(specOf(sb, id).resolved.allowGate, true);
  });

  test('without a detected order it is accepted as a harmless no-op', async () => {
    const sb = sandbox('gate-allow-noop');
    const r = run(sb, ['implement', '--allow-gate', '--prompt', 'Fix the bug, nothing else.']);
    assert.equal(r.code, 0, r.stderr);
  });

  test('adds "The caller authorized running: <command>" to the rendered prompt', async () => {
    const sb = sandbox('gate-allow-prompt-line');
    const r = run(sb, ['implement', '--allow-gate', '--prompt', 'Fix the bug. Run `pnpm build` to confirm.'], touchEnv(sb));
    const id = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /The caller authorized running: pnpm build\./);
  });

  test('--allow-gate is scoped to implement/continue/restart, rejected elsewhere', () => {
    const sb = sandbox('gate-allow-scope');
    const r = run(sb, ['staffer', '--allow-gate', '--prompt', 'do it']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--allow-gate has no effect on staffer:/);
    assert.equal(agyCalls(sb).length, 0);
  });
});

describe('task-text sources: --prompt-file and --stdin are checked too', () => {
  test('--prompt-file', () => {
    const sb = sandbox('gate-source-prompt-file');
    const file = path.join(sb.repo, 'task.md');
    fs.writeFileSync(file, 'Fix the bug. Run `pnpm build` to confirm the state of the project.');
    const r = run(sb, ['implement', '--prompt-file', file]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pnpm build/);
    assert.equal(agyCalls(sb).length, 0);
  });

  test('--stdin', () => {
    const sb = sandbox('gate-source-stdin');
    const r = run(sb, ['implement', '--stdin'], {}, { input: 'Fix the bug. Run `pnpm build` to confirm the state of the project.' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pnpm build/);
    assert.equal(agyCalls(sb).length, 0);
  });
});

describe('continue re-checks new follow-up text', () => {
  test('a clean follow-up dispatches, a gate-ordering follow-up is refused', async () => {
    const sb = sandbox('gate-continue-refuse');
    const started = run(sb, ['implement', '--prompt', 'Fix the bug.'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');
    await waitForCalls(sb, 1);

    const r = run(sb, ['continue', '--prompt', 'Now run `pnpm build` to confirm the state of the project.']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /pnpm build/);
    // Only the original call reached agy — the follow-up must not.
    assert.equal(agyCalls(sb).length, 1);
  });

  test('--allow-gate on continue authorizes its own follow-up', async () => {
    const sb = sandbox('gate-continue-allow');
    const started = run(sb, ['implement', '--prompt', 'Fix the bug.'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['continue', '--allow-gate', '--prompt', 'Now run `pnpm build` to confirm the state of the project.'], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const followId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, followId), 'done');
  });
});

describe('restart re-checks the original stored task', () => {
  test('restart of an --allow-gate job inherits the authorization (no refusal)', async () => {
    const sb = sandbox('gate-restart-inherits');
    const started = run(sb, ['implement', '--allow-gate', '--prompt', 'Fix the bug. Run `pnpm build` to confirm.'], touchEnv(sb));
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['restart', id], touchEnv(sb));
    assert.equal(r.code, 0, r.stderr);
    const restartId = jobIdOf(r.stdout);
    assert.equal(await waitForJob(sb, restartId), 'done');
    assert.equal(specOf(sb, restartId).resolved.allowGate, true, 'restart persists the inherited authorization');
  });

  test('restart without --allow-gate on the original job is refused again', async () => {
    const sb = sandbox('gate-restart-refuses');
    // The only way to get a "done" implement job whose stored task orders a
    // gate without prior authorization is a spec written before this guard
    // existed (see the legacy-spec case below) — a freshly dispatched job can
    // never reach `done` with such a task, because cmdRun would already have
    // refused it. This exercises the same code path restart uses for a job
    // that WAS authorized, confirming an unauthorized restart of it refuses.
    const stateDir = path.join(sb.repo, '.agy-staff');
    const jobsDir = path.join(stateDir, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const id = 'implement-legacy-gate';
    const specFile = path.join(jobsDir, `${id}.spec.json`);
    // A spec from before Fase 2 item 2: no `resolved.allowGate`, no
    // `prompt_source`, no `policy_version` — restart must still check it.
    fs.writeFileSync(specFile, JSON.stringify({
      resolved: { mode: 'implement', model: 'gemini-3.8-flash-high', profile: 'unrestricted', background: true, timeout: '60m' },
      prompt: 'Fix the bug. Run `pnpm build` to confirm the state of the project.',
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

    const r = run(sb, ['restart', id]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /pnpm build/);
    assert.equal(agyCalls(sb).length, 0);
  });

  test('restart --allow-gate authorizes a previously-unauthorized legacy spec', () => {
    const sb = sandbox('gate-restart-legacy-allow');
    const stateDir = path.join(sb.repo, '.agy-staff');
    const jobsDir = path.join(stateDir, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    const id = 'implement-legacy-gate-2';
    const specFile = path.join(jobsDir, `${id}.spec.json`);
    fs.writeFileSync(specFile, JSON.stringify({
      resolved: { mode: 'implement', model: 'gemini-3.8-flash-high', profile: 'unrestricted', background: true, timeout: '60m' },
      prompt: 'Fix the bug. Run `pnpm build` to confirm the state of the project.',
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

    const r = run(sb, ['restart', id, '--allow-gate']);
    assert.equal(r.code, 0, r.stderr);
  });
});
