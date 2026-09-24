/**
 * DX surface: the staffer mode's minimal prompt, the three explicit task-text
 * sources (--prompt / --prompt-file / --stdin) and the opacity guarantee that
 * comes with them, the value-flag guards, and first-run auto-ignore of
 * .agy-staff/.
 *
 * The opacity contract (issue #3): argv is parsed once, exactly as the shell
 * delivered it. Once a task value is read, no byte of it is ever inspected for
 * companion flags — `--check`, `--json`, `--timeout`, an unknown `--whatever`
 * inside a task are prompt content, not options.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, run, agyCalls, jobIdOf, waitForJob, waitForCalls, promptOf } from './helpers.mjs';
import { ROOT } from '../scripts/generate-pi-skills.mjs';

const skillText = name => fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');

describe('staffer: the general-purpose mode', () => {
  test('prompt is minimal: task + environment + guardrails, no role or output framing', async () => {
    const sb = sandbox('staffer-prompt');
    const r = run(sb, ['staffer', '--prompt', 'do the thing']);
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    const prompt = promptOf(argv);
    assert.match(prompt, /## Task\n\ndo the thing/);
    assert.match(prompt, /## Environment/);
    assert.match(prompt, /## Guardrails/);
    // the whole point of staffer: no template context beyond the guardrails
    assert.doesNotMatch(prompt, /## Rules/);
    assert.doesNotMatch(prompt, /## Output format/);
    assert.doesNotMatch(prompt, /You are/);
  });

  test('staffer can be restricted per repo like the other tool-using modes', () => {
    const sb = sandbox('staffer-policy');
    const r = run(sb, ['setup', '--restrict', 'staffer']);
    assert.equal(r.code, 0, r.stderr);
    const started = run(sb, ['staffer', '--prompt', 'a task']);
    assert.match(started.stdout, /profile: restricted/);
  });
});

describe('task text sources', () => {
  test('--prompt reads the task from one opaque argv value', async () => {
    const sb = sandbox('prompt-flag');
    const r = run(sb, ['staffer', '--prompt', 'a task passed as one argument']);
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /a task passed as one argument/);
  });

  test('--prompt-file reads the task from a file', async () => {
    const sb = sandbox('prompt-file');
    const f = path.join(sb.root, 'task.md');
    fs.writeFileSync(f, 'a long task written in a file\n');
    const r = run(sb, ['staffer', '--prompt-file', f]);
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /a long task written in a file/);
  });

  test('--stdin reads the task from stdin', async () => {
    const sb = sandbox('prompt-stdin');
    const r = run(sb, ['staffer', '--stdin'], {}, { input: 'a task piped via stdin\n' });
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.match(promptOf(argv), /a task piped via stdin/);
  });

  test('a missing --prompt-file dies pre-flight', () => {
    const sb = sandbox('prompt-file-missing');
    const r = run(sb, ['staffer', '--prompt-file', '/no/such/file.md']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cannot read --prompt-file/);
  });

  test('--prompt with --prompt-file dies as two task sources', () => {
    const sb = sandbox('prompt-two-sources');
    const f = path.join(sb.root, 'task.md');
    fs.writeFileSync(f, 'file task\n');
    const r = run(sb, ['staffer', '--prompt-file', f, '--prompt', 'inline task too']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /task text given more than one way \(--prompt, --prompt-file\)/);
  });

  test('--prompt with --stdin dies as two task sources', () => {
    const sb = sandbox('prompt-stdin-conflict');
    const r = run(sb, ['staffer', '--prompt', 'flag task', '--stdin'], {}, { input: 'piped task\n' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /task text given more than one way \(--prompt, --stdin\)/);
  });
});

describe('task text is opaque: flag-like content is never parsed (issue #3)', () => {
  test('foreground ask: a prompt mentioning `git diff --check` reaches agy intact', async () => {
    const sb = sandbox('opaque-ask');
    const task = "please explain what git diff --check verifies and keep 'the quotes'";
    const r = run(sb, ['ask', '--prompt', task]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown flag/);
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(promptOf(argv).includes(task), `prompt lost the task text: ${promptOf(argv)}`);
  });

  test('background review: known companion flag names inside the task stay content', async () => {
    const sb = sandbox('opaque-review');
    const task = 'Review code that mentions --json, --timeout 1s, --restricted and --whatever';
    const r = run(sb, ['review', '--prompt', task]);
    assert.equal(r.code, 0, r.stderr);
    // the mode's own defaults must be untouched by the flag names in the task
    assert.match(r.stdout, /profile: unrestricted/);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(promptOf(argv).includes(task), `prompt lost the task text: ${promptOf(argv)}`);
    assert.ok(!argv.includes('--json-schema'), '--json inside the task must not enable the schema');
    assert.equal(argv[argv.indexOf('--print-timeout') + 1], '60m', "review explicitly sets AGY's response budget");
  });

  test('--prompt-file content containing companion flags is never scanned', async () => {
    const sb = sandbox('opaque-file');
    const f = path.join(sb.root, 'task.md');
    const task = 'explain what git diff --check verifies, and what --json does';
    fs.writeFileSync(f, `${task}\n`);
    const r = run(sb, ['staffer', '--prompt-file', f]);
    assert.equal(r.code, 0, r.stderr);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(promptOf(argv).includes(task));
    assert.ok(!argv.includes('--json-schema'));
  });

  test('--stdin content containing companion flags is never scanned', async () => {
    const sb = sandbox('opaque-stdin');
    const task = 'a task piped via stdin that mentions --restricted and --timeout 1s';
    const r = run(sb, ['staffer', '--stdin'], {}, { input: `${task}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /profile: unrestricted/);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(promptOf(argv).includes(task));
  });

  test('real companion flags around --prompt still take effect', async () => {
    const sb = sandbox('real-flags-around-prompt');
    const task = 'Review this --json example and the --timeout 1s it mentions';
    // --timeout 90s is deliberately NOT review's default (60m), so the
    // assertion below proves the flag was honored rather than defaulted
    const r = run(sb, ['review', '--restricted', '--prompt', task, '--json', '--timeout', '90s']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /profile: restricted/);
    await waitForJob(sb, jobIdOf(r.stdout));
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(argv.includes('--json-schema'), 'the real --json flag must enable the schema');
    assert.equal(argv[argv.indexOf('--print-timeout') + 1], '90s');
    assert.ok(promptOf(argv).includes(task));
  });

  test('a flag-shaped prompt with whitespace is a sentence, not a flag', async () => {
    const sb = sandbox('prompt-leading-flag');
    const task = '--check means what in git diff?';
    const r = run(sb, ['ask', '--prompt', task]);
    assert.equal(r.code, 0, r.stderr);
    const [argv] = await waitForCalls(sb, 1);
    assert.ok(promptOf(argv).includes(task), `prompt lost the task text: ${promptOf(argv)}`);
  });

  test('prompt bytes survive verbatim: quotes, newlines and double spaces', async () => {
    const sb = sandbox('prompt-bytes');
    const task = 'line one  with "double"  spaces\nline two with \'single\' quotes and --check\n\nline four';
    const r = run(sb, ['ask', '--prompt', task]);
    assert.equal(r.code, 0, r.stderr);
    const [argv] = await waitForCalls(sb, 1);
    const prompt = promptOf(argv);
    assert.ok(prompt.includes(task), `bytes were altered:\n${JSON.stringify(prompt)}`);
  });

  test('continue reaches the state check with a flag-like follow-up', () => {
    const sb = sandbox('continue-opaque');
    const r = run(sb, ['continue', '--prompt', 'now check --check again']);
    assert.notEqual(r.code, 0);
    // the point: it fails on "no conversation yet", not on flag parsing
    assert.match(r.stderr, /no previous agy-staff conversation recorded/);
    assert.doesNotMatch(r.stderr, /unknown flag/);
    assert.doesNotMatch(r.stderr, /needs a value/);
  });
});

describe('task text comes only from the three sources', () => {
  test('a positional word on a run command dies with the three sources named', () => {
    const sb = sandbox('positional-word');
    const r = run(sb, ['staffer', 'do the thing']);
    assert.notEqual(r.code, 0);
    assert.match(
      r.stderr,
      /positional task text was removed; pass the task with --prompt <text>, --prompt-file <path>, or --stdin/
    );
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('an empty positional (an unset shell variable) dies loudly, never silently', () => {
    const sb = sandbox('positional-empty');
    // the shape produced by `ask --prompt "$Q" "$EXTRA"` with $EXTRA unset
    const r = run(sb, ['ask', '--prompt', 'a question', '']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /positional task text was removed/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('one big string of flags plus task points at the real fix', () => {
    const sb = sandbox('packed-string');
    const r = run(sb, ['review', '--restricted Review PR #730']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown flag --restricted/);
    assert.match(r.stderr, /arrived as a single argument/);
    assert.match(r.stderr, /never splits an argument into flags/);
    assert.match(r.stderr, /--prompt/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('-- has no special meaning', () => {
    const sb = sandbox('no-sentinel');
    const r = run(sb, ['ask', '--', 'a question']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^agy-staff error: unknown flag --$/m);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });
});

describe('value flags need a real value', () => {
  test('a forgotten --prompt value is caught instead of eating the next flag', () => {
    const sb = sandbox('prompt-eats-flag');
    const r = run(sb, ['ask', '--prompt', '--json']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /flag --prompt needs a value/);
    assert.match(r.stderr, /quote the full sentence or use --prompt-file/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('an empty --model value is an error, not a silent default', () => {
    const sb = sandbox('empty-model');
    const r = run(sb, ['ask', '--model', '', '--prompt', 'a question']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /flag --model needs a value/);
    assert.equal(agyCalls(sb).length, 0, 'agy must not be invoked');
  });

  test('a value flag at the end of argv is an error', () => {
    const sb = sandbox('missing-value');
    const r = run(sb, ['ask', '--prompt', 'a question', '--timeout']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /flag --timeout needs a value/);
  });

  test('a flag-shaped value for a non-prompt flag is an error', () => {
    const sb = sandbox('flag-shaped-value');
    const r = run(sb, ['ask', '--model', '--effort', 'low', '--prompt', 'a question']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /flag --model needs a value/);
  });
});

describe('management commands are unaffected by the task-source change', () => {
  test('wait <id> --timeout keeps parsing its positional id and its flag', async () => {
    const sb = sandbox('mgmt-wait');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '3000' });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);

    const early = run(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(early.code, 2, `expected still-running, got ${early.code}: ${early.stderr}`);
    assert.equal(await waitForJob(sb, id), 'done');

    const status = run(sb, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(id));
  });

  test('setup --restrict still takes its positional-free value', () => {
    const sb = sandbox('mgmt-setup');
    const r = run(sb, ['setup', '--restrict', 'review']);
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(sb.repo, '.agy-staff', 'config.json'), 'utf8')
    );
    assert.equal(cfg.profiles.review, 'restricted');
  });

  test('removed migration flags still die with their own message', () => {
    const sb = sandbox('mgmt-migration');
    const r = run(sb, ['review', '--pr', '730']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--pr was removed in 0\.2: review is prompt-based now\./);
    assert.match(r.stderr, /review --prompt "Review PR #730"/);
  });
});

describe('.agy-staff/ hygiene is automatic', () => {
  test('first run appends .agy-staff/ to .git/info/exclude', () => {
    const sb = sandbox('auto-exclude');
    // undo the sandbox's own hygiene to simulate a fresh caller
    const exclude = path.join(sb.repo, '.git', 'info', 'exclude');
    fs.writeFileSync(exclude, '');

    const r = run(sb, ['ask', '--prompt', 'a question']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(fs.readFileSync(exclude, 'utf8'), /^\.agy-staff\/$/m);
    const check = spawnSync('git', ['check-ignore', '-q', '.agy-staff'], { cwd: sb.repo });
    assert.equal(check.status, 0, '.agy-staff must be git-ignored after the first run');
  });

  test('an already-ignored .agy-staff/ is not appended again', () => {
    const sb = sandbox('auto-exclude-idempotent');
    const exclude = path.join(sb.repo, '.git', 'info', 'exclude');
    const before = fs.readFileSync(exclude, 'utf8');

    const r = run(sb, ['ask', '--prompt', 'a question']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(exclude, 'utf8'), before);
  });
});

describe('canonical skills document the Fase 1 result-truthing surface', () => {
  test('jobs documents the new terminal states and the exit-2-is-never-delivery rule', () => {
    const jobs = skillText('jobs');
    assert.match(jobs, /quota_exhausted/);
    assert.match(jobs, /verification_incomplete/);
    assert.match(jobs, /--until-done/);
    // exit 2 must be documented as "not delivered", not merely "still running"
    assert.match(jobs, /\bnot delivered\b/i);
    assert.match(jobs, /never pipe `wait`/i);
    // exit 5 is documented as more than just a resumable timeout
    assert.match(jobs, /implement_no_changes/);
    assert.match(jobs, /implement_uncommitted/);
  });

  test('the persona/pool skills that dispatch or collect jobs mention the new states', () => {
    for (const name of ['staffer', 'researcher', 'reviewer', 'implementer']) {
      const text = skillText(name);
      // each persona defers to jobs/SKILL.md for recovery, which now covers
      // quota/verification/partial-work; this is a light smoke check that the
      // pointer survived and nothing here contradicts it
      assert.match(text, /\.\.\/jobs\/SKILL\.md/, `${name}: must defer to jobs/SKILL.md`);
    }
  });

  test('the Codex permission wording is conditional, not "always escalate"', () => {
    for (const name of ['ask', 'staffer', 'reviewer', 'researcher', 'implementer', 'pool', 'lead']) {
      const text = skillText(name);
      assert.doesNotMatch(
        text,
        /In Codex, request escalated permissions for the command\./,
        `${name}: unconditional Codex escalation wording must be gone`
      );
    }
    // the surviving guidance names the concrete failure signal and the escape hatch
    for (const name of ['ask', 'staffer', 'reviewer', 'researcher', 'implementer', 'pool', 'lead']) {
      const text = skillText(name);
      assert.match(text, /sandbox blocks them/, `${name}: missing conditional permission wording`);
      assert.match(text, /just run it/, `${name}: missing the "already granted" branch`);
    }
    const troubleshooting = fs.readFileSync(
      path.join(ROOT, 'skills', 'jobs', 'references', 'troubleshooting.md'),
      'utf8'
    );
    assert.doesNotMatch(
      troubleshooting,
      /In Codex, request escalated permissions for the command\./
    );
    assert.match(troubleshooting, /sandbox blocks them/);
  });
});

describe('canonical skills document the Fase 2 gate surface', () => {
  test('jobs documents gate_failed and the verifying phase', () => {
    const jobs = skillText('jobs');
    assert.match(jobs, /gate_failed/);
    assert.match(jobs, /--gate\b/);
    assert.match(jobs, /--allow-gate/);
    assert.match(jobs, /verifying/);
  });

  test('implementer tells the briefer to declare --gate instead of ordering a full gate', () => {
    const implementer = skillText('implementer');
    assert.match(implementer, /--gate\b/);
    assert.match(implementer, /--allow-gate/);
    assert.match(implementer, /\.agy-staff\/config\.json/);
  });
});

describe('docs come in pairs: README/REFERENCE have a pt-BR counterpart', () => {
  test('README.pt-BR.md and docs/REFERENCE.pt-BR.md exist', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'README.pt-BR.md')),
      'README.pt-BR.md must exist'
    );
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'REFERENCE.pt-BR.md')),
      'docs/REFERENCE.pt-BR.md must exist'
    );
  });

  test('README.md links README.pt-BR.md', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /README\.pt-BR\.md/);
  });
});
