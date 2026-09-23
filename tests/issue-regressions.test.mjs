import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, run, agyCalls, jobIdOf, promptOf, waitForJob } from './helpers.mjs';

const state = sb => JSON.parse(fs.readFileSync(path.join(sb.repo, '.agy-staff/state.json'), 'utf8'));
const timeoutEnv = {
  FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_ERROR: 'timeout waiting for response',
  FAKE_AGY_RESPONSE: '', FAKE_AGY_EXIT: '1', FAKE_AGY_CONVERSATION_ID: 'timed-out',
};

test('#8 foreground timeout persists configuration and signals attention without retrying', () => {
  const sb = sandbox('timeout-foreground');
  const r = run(sb, ['ask', '--model', 'gemini-3.8-flash-high', '--timeout', '2m', '--prompt', 'question'], timeoutEnv);
  assert.equal(r.code, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /timeout waiting for response/);
  assert.match(r.stderr, /Ask the user whether to continue/);
  assert.match(r.stderr, /--timeout 4m/);
  assert.equal(state(sb).conversations.ask, 'timed-out');
  assert.equal(agyCalls(sb).length, 1);
  run(sb, ['ask', '--prompt', 'other'], { FAKE_AGY_CONVERSATION_ID: 'other-ask' });
  run(sb, ['research', '--prompt', 'unrelated'], { FAKE_AGY_CONVERSATION_ID: 'other-mode' });
  assert.equal(run(sb, ['wait', '--timeout', '10s']).code, 0);
  const continued = run(sb, ['continue', '--conversation', 'timed-out', '--timeout', '4m', '--prompt', 'continue']);
  assert.equal(continued.code, 0, continued.stderr);
  const argv = agyCalls(sb).at(-1);
  assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.equal(argv[argv.indexOf('--conversation') + 1], 'timed-out');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'json');
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
});

for (const status of ['ERROR', 'TIMEOUT']) {
  test(`#8 background ${status} timeout preserves partial work and resumes original persona`, () => {
    const sb = sandbox('timeout-background');
    fs.writeFileSync(path.join(sb.repo, 'pre-existing.txt'), 'user work');
    const start = run(sb, ['implement', '--restricted', '--model', 'gemini-3.8-flash-low', '--timeout', '10m', '--prompt', 'task'], {
      ...timeoutEnv, FAKE_AGY_STATUS: status, FAKE_AGY_TOUCH_FILE: 'partial.txt',
    });
    const id = jobIdOf(start.stdout);
    const result = run(sb, ['wait', id, '--timeout', '10s']);
    assert.equal(result.code, 5, result.stdout + result.stderr);
    assert.match(result.stdout, /partial.txt/);
    assert.match(result.stdout, /pre-existing.txt/);
    assert.match(result.stdout, /Ask the user whether to continue/);
    const workspace = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).workspace;
    assert.match(workspace.before.text, /pre-existing.txt/);
    assert.doesNotMatch(workspace.before.text, /partial.txt/);
    assert.match(workspace.after.text, /partial.txt/);
    assert.equal(fs.readFileSync(path.join(sb.repo, 'pre-existing.txt'), 'utf8'), 'user work');
    const observed = run(sb, ['observe', id]);
    assert.equal(observed.code, 5);
    const packet = JSON.parse(observed.stdout);
    assert.equal(packet.status, 'attention');
    assert.equal(packet.reason, 'response_timeout');
    assert.equal(packet.recovery.requires_user_confirmation, true);
    assert.equal(packet.recovery.suggested_timeout, '20m');
    assert.match(packet.recovery.continue, new RegExp(`continue --job ${id} --timeout 20m`));
    assert.equal(run(sb, ['status', id]).code, 5);
    assert.equal(run(sb, ['result', id]).code, 5);
    assert.equal(agyCalls(sb).length, 1, 'collection must never retry');
    run(sb, ['ask', '--prompt', 'another task'], { FAKE_AGY_CONVERSATION_ID: 'other' });
    const resumed = run(sb, ['continue', '--conversation', 'timed-out', '--timeout', '20m', '--prompt', 'finish']);
    const childId = jobIdOf(resumed.stdout);
    assert.equal(run(sb, ['wait', childId, '--timeout', '10s']).code, 0);
    const argv = agyCalls(sb).at(-1);
    assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3.8-flash-low');
    assert.ok(!argv.includes('--dangerously-skip-permissions'));
    assert.match(promptOf(argv), /partial.txt/);
    const records = state(sb).jobs;
    assert.equal(records.find(j => j.id === id).status, 'attention');
    assert.equal(records.find(j => j.id === childId).parent_job_id, id);
    assert.equal(records.find(j => j.id === childId).mode, 'implement');
  });
}

test('#8 unrelated errors and timeout without conversation stay errors; complete answers survive', () => {
  const sb = sandbox('timeout-boundaries');
  for (const error of ['tool timeout waiting for response', 'network timeout waiting for response', '401 Unauthorized', 'invalid model selection']) {
    const r = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_ERROR: error });
    assert.equal(r.code, 1, error + r.stderr);
    assert.doesNotMatch(r.stderr, /Ask the user whether to continue/);
  }
  // "quota exceeded" is now its own terminal state (quota_exhausted, exit 6 —
  // Fase 1, item 1), not a generic error; see tests/triage.test.mjs.
  const quota = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_ERROR: 'quota exceeded' });
  assert.equal(quota.code, 6, quota.stderr);
  assert.match(quota.stderr, /Quota exhausted:/);
  const noId = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_CONVERSATION_ID: '' });
  assert.equal(noId.code, 1);
  const complete = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_RESPONSE: 'finished answer' });
  assert.equal(complete.code, 0);
  assert.match(complete.stdout, /finished answer/);
});

test('#8 explicit foreground timeout and background no-ID/ceiling boundaries', () => {
  const sb = sandbox('timeout-state-boundaries');
  const explicit = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_STATUS: 'TIMEOUT' });
  assert.equal(explicit.code, 5);
  for (const status of ['TOOL_TIMEOUT', 'NETWORK_TIMEOUT']) {
    const r = run(sb, ['ask', '--prompt', 'question'], { ...timeoutEnv, FAKE_AGY_STATUS: status });
    assert.equal(r.code, 1, r.stderr);
  }
  const noId = jobIdOf(run(sb, ['staffer', '--prompt', 'task'], { ...timeoutEnv, FAKE_AGY_CONVERSATION_ID: '' }).stdout);
  assert.equal(run(sb, ['wait', noId, '--timeout', '10s']).code, 3);
  const missing = JSON.parse(run(sb, ['observe', noId]).stdout);
  assert.equal(missing.status, 'error');
  assert.equal(missing.recovery.continue, null);
  const capped = jobIdOf(run(sb, ['staffer', '--timeout', '120m', '--prompt', 'task'], timeoutEnv).stdout);
  assert.equal(run(sb, ['wait', capped, '--timeout', '10s']).code, 5);
  const packet = JSON.parse(run(sb, ['observe', capped]).stdout);
  assert.equal(packet.recovery.suggested_timeout, '120m');
  assert.equal(packet.recovery.at_timeout_ceiling, true);
  assert.match(run(sb, ['result', capped]).stdout, /narrower task/);
});

// ---------------------------------------------------------------------------
// Fase 1, item 3: every non-done terminal job report gets an actionable
// `## Partial work` inventory, built from the same porcelain/HEAD snapshots
// the workspace guard already takes (no second snapshot mechanism).
// ---------------------------------------------------------------------------

for (const [label, env, expectStatus] of [
  ['ERROR', { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' }, 'error'],
  ['quota_exhausted', { FAKE_AGY_QUOTA: '1', FAKE_AGY_RESPONSE: '' }, 'quota_exhausted'],
]) {
  test(`Partial work: a background job that touched the workspace then ended ${label} inventories it`, async () => {
    const sb = sandbox(`partial-${label}`);
    const started = run(sb, ['implement', '--prompt', 'a task'], { ...env, FAKE_AGY_TOUCH_FILE: 'partial.txt' });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), expectStatus);
    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /## Partial work/);
    assert.match(res.stdout, new RegExp(`- Terminal state: ${expectStatus}`));
    assert.match(res.stdout, /- Dirty paths after the run \(1\):\n {2}- partial\.txt \(untracked; new this run\)/);
    assert.match(res.stdout, /- Inspect: `git status --short; git diff; git diff --cached`/);
    assert.match(res.stdout, /- Verification: not confirmed; do not treat this work as accepted\./);
    assert.match(res.stdout, /- Inventory completeness: complete/);
  });
}

test('Partial work: a hard-timeout job inventories the file the agent left behind', async () => {
  const sb = sandbox('partial-hard-timeout');
  const started = run(sb, ['implement', '--timeout', '800ms', '--prompt', 'task'], {
    FAKE_AGY_SLEEP_MS: '5000', FAKE_AGY_TOUCH_FILE: 'partial.txt',
  });
  const id = jobIdOf(started.stdout);
  const result = run(sb, ['wait', id]);
  assert.equal(result.code, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /## Partial work/);
  assert.match(result.stdout, /- Terminal state: attention \(hard_timeout\)/);
  assert.match(result.stdout, /partial\.txt \(untracked; new this run\)/);
  assert.match(result.stdout, /- Verification: not confirmed; do not treat this work as accepted\./);
});

test('Partial work: a run that commits then errors reports HEAD moved and lists the commit', async () => {
  const sb = sandbox('partial-commit-then-error');
  const started = run(sb, ['implement', '--prompt', 'a task'], {
    FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '', FAKE_AGY_GIT_COMMIT: 'partial commit by agy',
  });
  const id = jobIdOf(started.stdout);
  assert.equal(await waitForJob(sb, id), 'error');
  const res = run(sb, ['result', id]);
  assert.match(res.stdout, /- HEAD: \(no commits yet\) → [0-9a-f]{7,40} \(moved: yes\)/);
  assert.match(res.stdout, /- Commits made by the run \(`git log --oneline [0-9a-f]{7,40}`\):/);
  assert.match(res.stdout, /partial commit by agy/);
  assert.match(res.stdout, /- Inspect: `git status --short; git diff; git diff --cached; git log [0-9a-f]{7,40}`/);
});

test('Partial work: a path already dirty before the run that changes again is marked, not just listed', async () => {
  const sb = sandbox('partial-already-dirty');
  fs.writeFileSync(path.join(sb.repo, 'pre-staged.txt'), 'v1');
  execFileSync('git', ['add', 'pre-staged.txt'], { cwd: sb.repo });
  const started = run(sb, ['implement', '--prompt', 'a task'], {
    FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '', FAKE_AGY_TOUCH_FILE: 'pre-staged.txt',
  });
  const id = jobIdOf(started.stdout);
  assert.equal(await waitForJob(sb, id), 'error');
  const res = run(sb, ['result', id]);
  assert.match(res.stdout, /- pre-staged\.txt \(staged; already dirty before the run; status changed\)/);
});

test('Partial work: a done job never gets the section', async () => {
  const sb = sandbox('partial-done');
  const started = run(sb, ['staffer', '--prompt', 'a task'], { FAKE_AGY_TOUCH_FILE: 'ok.txt' });
  const id = jobIdOf(started.stdout);
  assert.equal(await waitForJob(sb, id), 'done');
  const res = run(sb, ['result', id]);
  assert.doesNotMatch(res.stdout, /## Partial work/);
});

test('Partial work: outside a git repository the completeness note says so instead of a path list', async () => {
  const sb = sandbox('partial-non-git', { git: false });
  const started = run(sb, ['staffer', '--prompt', 'a task'], { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' });
  const id = jobIdOf(started.stdout);
  assert.equal(await waitForJob(sb, id), 'error');
  const res = run(sb, ['result', id]);
  assert.match(res.stdout, /## Partial work/);
  assert.match(res.stdout, /- HEAD: unknown \(not a git repo\)/);
  assert.match(res.stdout, /- Dirty paths after the run: unknown \(git status unavailable after the run\)/);
  assert.match(res.stdout, /- Inventory completeness: incomplete/);
});

test('#9 both execution paths attach the repository even when launched in a subdirectory with spaces', () => {
  const sb = sandbox('attached-workspace');
  const nested = path.join(sb.repo, 'sub dir'); fs.mkdirSync(nested);
  const caller = { ...sb, repo: nested };
  assert.equal(run(caller, ['ask', '--prompt', 'question']).code, 0);
  for (const profile of ['--restricted', '--unrestricted']) {
    const id = jobIdOf(run(caller, ['staffer', profile, '--prompt', 'task']).stdout);
    assert.equal(run(sb, ['wait', id, '--timeout', '10s']).code, 0);
    const resumed = jobIdOf(run(sb, ['continue', '--job', id, '--prompt', 'follow up']).stdout);
    assert.equal(run(sb, ['wait', resumed, '--timeout', '10s']).code, 0);
  }
  for (const argv of agyCalls(sb)) {
    assert.equal(argv.filter(a => a === '--add-dir').length, 1);
    assert.equal(argv[argv.indexOf('--add-dir') + 1], sb.repo);
    assert.ok(!argv.includes('--sandbox'));
  }
});

test('#9 non-git workspace attaches the launch directory', () => {
  const sb = sandbox('attached-no-git', { git: false });
  const id = jobIdOf(run(sb, ['staffer', '--restricted', '--prompt', 'task']).stdout);
  assert.equal(run(sb, ['wait', id, '--timeout', '10s']).code, 0);
  const argv = agyCalls(sb)[0];
  assert.equal(argv[argv.indexOf('--add-dir') + 1], sb.repo);
});

test('#10 setup merges broad allow and targeted deny rules, preserving user settings', () => {
  const sb = sandbox('deny-setup');
  const settings = path.join(sb.home, '.gemini/antigravity-cli/settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = { custom: true, permissions: {
    allow: ['command(git)', 'command(gh)', 'command(git diff)', 'custom(rule)'],
    deny: ['command(git push)', 'command(custom-blocked)'], ask: ['command(gh api)'],
  } };
  fs.writeFileSync(settings, JSON.stringify(original));
  const preview = run(sb, ['setup']);
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /permissions\.allow/);
  assert.match(preview.stdout, /permissions\.deny/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), original);
  assert.equal(run(sb, ['setup', '--apply']).code, 0);
  const applied = JSON.parse(fs.readFileSync(settings));
  assert.ok(applied.permissions.allow.includes('command(git)'));
  assert.ok(applied.permissions.allow.includes('command(gh)'));
  for (const command of ['git push', 'git reset --hard', 'git clean', 'gh pr merge', 'gh release delete']) {
    assert.ok(applied.permissions.deny.includes(`command(${command})`), command);
  }
  for (const rule of original.permissions.allow) assert.ok(applied.permissions.allow.includes(rule));
  assert.ok(applied.permissions.deny.includes('command(custom-blocked)'));
  assert.deepEqual(applied.permissions.ask, original.permissions.ask);
  assert.equal(applied.custom, true);
  for (const kind of ['allow', 'deny']) assert.equal(new Set(applied.permissions[kind]).size, applied.permissions[kind].length);
  const backups = fs.readdirSync(path.dirname(settings)).filter(f => f.includes('.bak-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(settings), backups[0]))), original);
  assert.equal(run(sb, ['setup', '--apply']).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), applied);
  assert.equal(fs.readdirSync(path.dirname(settings)).filter(f => f.includes('.bak-')).length, 1);

  // An existing installation may have all allows but lack the new denies.
  const missingDenies = { ...applied, permissions: { ...applied.permissions, deny: original.permissions.deny } };
  fs.writeFileSync(settings, JSON.stringify(missingDenies));
  const pending = run(sb, ['setup']);
  assert.equal(pending.code, 0);
  assert.match(pending.stdout, /command\(gh pr merge\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), missingDenies);
  const upgrade = run(sb, ['setup', '--apply']);
  assert.equal(upgrade.code, 0);
  assert.match(upgrade.stdout, /Wrote 0 allow-rule\(s\) and 4 deny-rule\(s\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), applied);
});
