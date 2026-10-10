import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendInbox, repoKey } from './inbox.mjs';

// `run-spec`: execute a plan the host wrote (plan.json) as a DAG of AGY jobs.
//
// The host keeps the judgement — it reads the spec, slices it into tasks and
// steps, names the gates, and merges what it accepts. This module keeps the
// bookkeeping it used to do by hand: one git worktree and branch per task,
// dependencies branched from their prerequisites, `--model auto` routing,
// waiting for a closed quota pool to reopen instead of failing, steps run in
// sequence in one conversation, a commit per accepted task, and one report
// with the merge commands. It never merges anything into the host's branch.
//
// Everything runs through the companion's own CLI in the task's worktree, so
// each job is an ordinary job there: `status`, `observe`, `result` work on it.

const PLAN_VERSION = 1;
const DEFAULT_MAX_PARALLEL = 4;
const QUOTA_RETRY_MS = Number(process.env.AGY_RUN_QUOTA_RETRY_MS) > 0 ? Number(process.env.AGY_RUN_QUOTA_RETRY_MS) : 5 * 60_000;
const MODES = new Set(['implement', 'staffer', 'research', 'review']);
const ENV_FILES = ['.env', '.env.local', '.env.test', '.env.development.local', '.env.test.local'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Validate a plan and return it normalized, or throw with every problem at
 * once — a plan is written by a model, and one round trip per mistake is the
 * slow way to fix five of them.
 */
export function loadPlan(file) {
  const problems = [];
  let plan;
  try { plan = readJSON(file); } catch (error) { throw new Error(`plan ${file}: ${error.message}`); }
  const dir = path.dirname(path.resolve(file));
  if (plan.version !== PLAN_VERSION) problems.push(`"version" must be ${PLAN_VERSION}`);
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) problems.push('"tasks" must be a non-empty array');
  const defaults = plan.defaults || {};
  const ids = new Set();
  const tasks = (plan.tasks || []).map((raw, index) => {
    const where = `tasks[${index}]${raw?.id ? ` (${raw.id})` : ''}`;
    const task = { ...defaults, ...raw };
    if (typeof task.id !== 'string' || !/^[\w.-]+$/.test(task.id)) problems.push(`${where}: "id" must match [A-Za-z0-9_.-]+`);
    else if (ids.has(task.id)) problems.push(`${where}: duplicate id`);
    ids.add(task.id);
    task.mode ||= 'implement';
    if (!MODES.has(task.mode)) problems.push(`${where}: "mode" must be one of ${[...MODES].join(', ')}`);
    task.depends_on = task.depends_on || [];
    if (!Array.isArray(task.depends_on)) problems.push(`${where}: "depends_on" must be an array`);
    const steps = Array.isArray(task.steps) && task.steps.length ? task.steps : [{ prompt: task.prompt, prompt_file: task.prompt_file, gates: task.gates }];
    task.steps = steps.map((step, n) => {
      const text = step.prompt_file ? readPrompt(dir, step.prompt_file, `${where} step ${n + 1}`, problems) : step.prompt;
      if (typeof text !== 'string' || !text.trim()) problems.push(`${where} step ${n + 1}: needs "prompt" or "prompt_file"`);
      const gates = step.gates ?? task.gates ?? [];
      if (!Array.isArray(gates)) problems.push(`${where} step ${n + 1}: "gates" must be an array of gate names`);
      return { prompt: text, gates };
    });
    if (task.model && task.class) problems.push(`${where}: give "model" or "class", not both`);
    if (task.worker !== undefined && (typeof task.worker !== 'string' || !task.worker)) problems.push(`${where}: "worker" must be a worker id`);
    return task;
  });
  for (const task of tasks) {
    for (const dep of task.depends_on || []) if (!ids.has(dep)) problems.push(`task ${task.id}: depends on unknown task "${dep}"`);
  }
  const cycle = findCycle(tasks);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(' → ')}`);
  if (problems.length) throw new Error(`plan ${file} is invalid:\n- ${problems.join('\n- ')}`);
  return { name: plan.name || path.basename(file, '.json'), base: plan.base || null, worktree_setup: plan.worktree_setup || null,
    max_parallel: plan.max_parallel || null, tasks };
}

function readPrompt(dir, file, where, problems) {
  try { return fs.readFileSync(path.resolve(dir, file), 'utf8'); } catch {
    problems.push(`${where}: cannot read prompt_file ${file}`);
    return null;
  }
}

function findCycle(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 'open');
    for (const dep of byId.get(id)?.depends_on || []) {
      const found = byId.has(dep) ? visit(dep, [...trail, id]) : null;
      if (found) return found;
    }
    state.set(id, 'done');
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id, []);
    if (found) return found;
  }
  return null;
}

/** Waves of tasks that could start together, for --dry-run. */
export function waves(tasks) {
  const done = new Set();
  const out = [];
  let left = tasks;
  while (left.length) {
    const ready = left.filter((task) => task.depends_on.every((dep) => done.has(dep)));
    out.push(ready.map((task) => task.id));
    for (const task of ready) done.add(task.id);
    left = left.filter((task) => !ready.includes(task));
  }
  return out;
}

function runsDir(root) {
  return path.join(root, '.agy-staff', 'runs');
}

function statePathFor(root, id) {
  return path.join(runsDir(root), id, 'state.json');
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export function cmdRunSpec({ root, companion, planFile, maxParallel, dryRun, out = process.stdout }) {
  const plan = loadPlan(planFile);
  const order = waves(plan.tasks);
  if (dryRun) {
    out.write(`plan ${plan.name}: ${plan.tasks.length} task(s), ${order.length} wave(s)\n`);
    order.forEach((wave, index) => out.write(`  wave ${index + 1}: ${wave.join(', ')}\n`));
    for (const task of plan.tasks) {
      out.write(`  ${task.id}: ${task.mode} ${task.model ? `--model ${task.model}` : `--model auto --class ${task.class || 'default'}`}` +
        `, ${task.steps.length} step(s)${task.depends_on.length ? `, after ${task.depends_on.join(', ')}` : ''}\n`);
    }
    return;
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).out) {
    out.write('note: the main checkout has uncommitted changes; run worktrees branch from HEAD and do not see them\n');
  }
  const head = git(root, ['rev-parse', '--verify', '--quiet', plan.base || 'HEAD']);
  if (head.code !== 0 || !head.out) {
    throw new Error(plan.base ? `plan "base" ${plan.base} is not a commit here` : 'run-spec needs a git repository with at least one commit');
  }
  const base = head.out;
  const id = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const dir = path.join(runsDir(root), id);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    id, name: plan.name, plan_file: path.resolve(planFile), root, base, status: 'running',
    max_parallel: maxParallel || plan.max_parallel || DEFAULT_MAX_PARALLEL, worktree_setup: plan.worktree_setup,
    started_at: new Date().toISOString(), pid: null,
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, {
      id: task.id, title: task.title || null, mode: task.mode, model: task.model || null, class: task.class || null,
      depends_on: task.depends_on, steps: task.steps, timeout: task.timeout || null, worker: task.worker || null,
      status: 'pending', step: 0, job: null, branch: null, worktree: null, status_line: null, note: null,
    }])),
  };
  writeJSON(statePathFor(root, id), state);
  const log = fs.openSync(path.join(dir, 'run.log'), 'a');
  const child = spawn(process.execPath, [companion, '_run', id], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  state.pid = child.pid;
  writeJSON(statePathFor(root, id), { ...readJSON(statePathFor(root, id)), pid: child.pid });
  out.write(
    `Started run ${id}: ${plan.tasks.length} task(s), ${order.length} wave(s), up to ${state.max_parallel} at a time.\n` +
      `Each task gets a worktree under .agy-staff/worktrees/${id}/ and a branch agy/${id}/<task>; nothing is merged for you.\n` +
      `Collect: \`run-wait ${id} --follow\` (Claude Code: run_in_background). Progress: \`run-status ${id}\`. Stop: \`run-cancel ${id}\`.\n`
  );
}

export function cmdRunStatus({ root, id, json, out = process.stdout }) {
  if (!id) {
    const dir = runsDir(root);
    const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => fs.existsSync(statePathFor(root, name))).sort() : [];
    if (!ids.length) { out.write('No runs recorded in this repository.\n'); return; }
    out.write('run | name | status | tasks done/total | started\n');
    for (const runId of ids.slice(-20)) {
      const state = readJSON(statePathFor(root, runId));
      const tasks = Object.values(state.tasks);
      out.write(`${runId} | ${state.name} | ${liveStatus(state)} | ${tasks.filter((t) => t.status === 'done').length}/${tasks.length} | ${state.started_at}\n`);
    }
    return;
  }
  const state = loadRun(root, id);
  if (json) { out.write(JSON.stringify({ ...state, status: liveStatus(state) }, null, 2) + '\n'); return; }
  out.write(taskTable(state));
}

export async function cmdRunWait({ root, id, follow, timeoutMs = Infinity, out = process.stdout, err = process.stderr }) {
  let state = loadRun(root, id);
  const seen = new Map();
  const started = Date.now();
  for (;;) {
    state = loadRun(root, id);
    if (follow) {
      for (const task of Object.values(state.tasks)) {
        const mark = `${task.status}:${task.step}:${task.job || ''}`;
        if (seen.get(task.id) !== mark) {
          seen.set(task.id, mark);
          err.write(`   ${task.id}: ${task.status}${task.steps.length > 1 ? ` (step ${Math.min(task.step + 1, task.steps.length)}/${task.steps.length})` : ''}` +
            `${task.job ? ` job ${task.job}` : ''}${task.note ? ` — ${task.note}` : ''}\n`);
        }
      }
    }
    const status = liveStatus(state);
    if (status !== 'running') break;
    if (Date.now() - started >= timeoutMs) {
      err.write(`STILL RUNNING — run ${id}. Exit 2: not finished; call run-wait again.\n`);
      return 2;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const report = path.join(runsDir(root), id, 'report.md');
  out.write(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : taskTable(state));
  const tasks = Object.values(state.tasks);
  return tasks.every((task) => task.status === 'done') ? 0 : liveStatus(state) === 'crashed' ? 3 : 5;
}

export function cmdRunCancel({ root, id, companion, out = process.stdout }) {
  const state = loadRun(root, id);
  // A marker file, not a field: the run process owns state.json and would
  // overwrite a field written here on its next save.
  fs.writeFileSync(cancelMarker(root, id), new Date().toISOString());
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'running' && task.job && task.worktree) {
      spawnSync(process.execPath, [companion, 'cancel', task.job], { cwd: task.worktree, encoding: 'utf8', windowsHide: true });
    }
  }
  out.write(`Cancel requested for run ${id}; running jobs were asked to stop.\n`);
}

function cancelMarker(root, id) {
  return path.join(runsDir(root), id, 'cancel');
}

function loadRun(root, id) {
  const file = statePathFor(root, id);
  if (!fs.existsSync(file)) throw new Error(`no run ${id} in this repository`);
  return readJSON(file);
}

function liveStatus(state) {
  if (state.status !== 'running') return state.status;
  if (state.pid && !alive(state.pid)) return 'crashed';
  return 'running';
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function taskTable(state) {
  const lines = ['task | status | step | branch | job | outcome'];
  for (const task of Object.values(state.tasks)) {
    lines.push(`${task.id} | ${task.status} | ${task.step}/${task.steps.length} | ${task.branch || '-'} | ${task.job || '-'} | ${task.status_line || task.note || '-'}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// the run process
// ---------------------------------------------------------------------------

export async function runMain({ root, id, companion }) {
  const file = statePathFor(root, id);
  const save = (state) => writeJSON(file, state);
  let state = readJSON(file);
  const log = (text) => process.stderr.write(`[run ${id}] ${new Date().toISOString()} ${text}\n`);
  const running = new Map();

  const update = (taskId, fields) => {
    state = readJSON(file);
    Object.assign(state.tasks[taskId], fields);
    save(state);
  };

  try {
    for (;;) {
      state = readJSON(file);
      if (!state.cancel_requested_at && fs.existsSync(cancelMarker(root, id))) {
        state.cancel_requested_at = fs.readFileSync(cancelMarker(root, id), 'utf8');
        save(state);
      }
      const tasks = Object.values(state.tasks);
      if (state.cancel_requested_at) {
        for (const task of tasks) if (['pending', 'waiting_quota'].includes(task.status)) update(task.id, { status: 'canceled' });
        if (!running.size) break;
      }
      // A task whose prerequisite did not finish cannot start.
      for (const task of tasks) {
        if (task.status !== 'pending') continue;
        const failed = task.depends_on.find((dep) => !['pending', 'running', 'waiting_quota', 'done'].includes(state.tasks[dep].status));
        if (failed) update(task.id, { status: 'blocked', note: `prerequisite ${failed} is ${state.tasks[failed].status}` });
      }
      state = readJSON(file);
      const ready = Object.values(state.tasks).filter((task) =>
        (task.status === 'pending' || (task.status === 'waiting_quota' && Date.now() >= (task.retry_at || 0))) &&
        task.depends_on.every((dep) => state.tasks[dep].status === 'done'));
      for (const task of ready) {
        if (state.cancel_requested_at || running.size >= state.max_parallel) break;
        update(task.id, { status: 'running', note: null });
        running.set(task.id, runTask({ root, id, companion, taskId: task.id, update, readState: () => readJSON(file), log })
          .catch((error) => update(task.id, { status: 'failed', note: error.message.split('\n')[0] }))
          .finally(() => running.delete(task.id)));
      }
      state = readJSON(file);
      const open = Object.values(state.tasks).filter((task) => ['pending', 'running', 'waiting_quota'].includes(task.status));
      if (!open.length && !running.size) break;
      await Promise.race([...running.values(), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    state = readJSON(file);
    state.status = state.cancel_requested_at ? 'canceled' : 'finished';
    state.finished_at = new Date().toISOString();
    save(state);
    fs.writeFileSync(path.join(runsDir(root), id, 'report.md'), report(state));
    const tasks = Object.values(state.tasks);
    appendInbox({ repo: repoKey(root), run: id, mode: 'run', status: state.status,
      line: `${state.name}: ${tasks.filter((t) => t.status === 'done').length}/${tasks.length} done` +
        `${tasks.some((t) => t.status !== 'done') ? `, ${tasks.filter((t) => t.status !== 'done').map((t) => `${t.id} ${t.status}`).join(', ')}` : ''}`,
      collect: `run-status ${id}` });
  } catch (error) {
    log(`run failed: ${error.stack || error.message}`);
    state = readJSON(file);
    state.status = 'crashed';
    state.error = error.message;
    save(state);
    throw error;
  }
}

/** One task: worktree, setup, then each step as a job, then a commit. */
async function runTask({ root, id, companion, taskId, update, readState, log }) {
  const state = readState();
  const task = state.tasks[taskId];
  const branch = `agy/${id}/${task.id}`;
  const worktree = task.worktree || path.join(root, '.agy-staff', 'worktrees', id, task.id);

  if (!task.worktree) {
    const deps = task.depends_on.map((dep) => state.tasks[dep].branch);
    const start = deps[0] || state.base;
    const added = git(root, ['worktree', 'add', '-b', branch, worktree, start]);
    if (added.code !== 0) throw new Error(`git worktree add failed: ${added.err}`);
    update(task.id, { branch, worktree });
    for (const dep of deps.slice(1)) {
      const merged = git(worktree, ['merge', '--no-edit', dep]);
      if (merged.code !== 0) {
        git(worktree, ['merge', '--abort']);
        update(task.id, { status: 'blocked', note: `prerequisite branches conflict (${dep}); merge them by hand, then rerun` });
        return;
      }
    }
    for (const name of ENV_FILES) {
      const source = path.join(root, name);
      if (fs.existsSync(source) && !fs.existsSync(path.join(worktree, name))) fs.copyFileSync(source, path.join(worktree, name));
    }
    if (state.worktree_setup) {
      update(task.id, { note: 'worktree setup' });
      const r = spawnSync(state.worktree_setup, { cwd: worktree, shell: true, encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000 });
      if (r.status !== 0) {
        update(task.id, { status: 'failed', note: `worktree_setup failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || ''}` });
        return;
      }
    }
  }

  const fresh = readState().tasks[taskId];
  for (let index = fresh.step; index < fresh.steps.length; index++) {
    const step = fresh.steps[index];
    const promptFile = path.join(runsDir(root), id, `${task.id}.step${index + 1}.md`);
    fs.writeFileSync(promptFile, step.prompt);
    const current = readState().tasks[taskId];
    const args = index === 0 || !current.job
      ? [task.mode, ...(task.model ? ['--model', task.model] : task.mode === 'implement' || task.class ? ['--model', 'auto', ...(task.class ? ['--class', task.class] : [])] : []),
        ...(task.timeout ? ['--timeout', task.timeout] : []), ...(task.worker ? ['--worker', task.worker] : [])]
      : ['continue', '--job', current.job];
    if (step.gates.length && (task.mode === 'implement' || args[0] === 'continue')) args.push('--gate', step.gates.join(','));
    args.push('--prompt-file', promptFile);
    const started = spawnSync(process.execPath, [companion, ...args], { cwd: worktree, encoding: 'utf8', windowsHide: true });
    if (started.status !== 0) {
      const text = `${started.stderr || ''}${started.stdout || ''}`;
      if (/no open account for --class/.test(text)) {
        update(task.id, { status: 'waiting_quota', retry_at: Date.now() + QUOTA_RETRY_MS, note: `no open account; retrying in ${Math.round(QUOTA_RETRY_MS / 1000)}s` });
        log(`${task.id}: no open account, waiting`);
        return;
      }
      update(task.id, { status: 'failed', note: `dispatch failed: ${text.trim().split('\n')[0]}` });
      return;
    }
    const job = /job id: (\S+)/.exec(started.stdout)?.[1];
    if (!job) { update(task.id, { status: 'failed', note: 'dispatch printed no job id' }); return; }
    update(task.id, { job, note: null });
    log(`${task.id}: step ${index + 1}/${fresh.steps.length} job ${job}`);
    const code = await waitJob(companion, worktree, job);
    const statusLine = code.stderr.split('\n').find((line) => line.startsWith('STATUS: ')) || null;
    if (code.exit !== 0) {
      update(task.id, { status: 'failed', status_line: statusLine || `exit ${code.exit}`, note: `step ${index + 1} did not finish` });
      return;
    }
    // A commit per step: the next step then starts from a clean tree, where
    // the job's no-op check can see its edits. On top of a dirty one it
    // cannot — rewriting a file the previous step left untracked looks like
    // "no changes" to a status comparison.
    if (task.mode === 'implement') {
      const title = task.title ? `: ${task.title}` : '';
      const label = fresh.steps.length > 1 ? ` step ${index + 1}/${fresh.steps.length}` : '';
      git(worktree, ['add', '-A']);
      const commit = git(worktree, ['-c', 'user.name=agy-staff run', '-c', 'user.email=agy-staff@localhost',
        'commit', '-q', '--allow-empty', '-m', `agy(${task.id})${label}${title}\n\nRun ${id}, job ${job}.`]);
      if (commit.code !== 0) { update(task.id, { status: 'failed', note: `commit failed: ${commit.err}` }); return; }
    }
    update(task.id, { step: index + 1, status_line: null });
  }
  update(task.id, { status: 'done', note: null });
}

function waitJob(companion, cwd, job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [companion, 'wait', job, '--until-done'], { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (exit) => resolve({ exit, stderr }));
    child.on('error', () => resolve({ exit: null, stderr }));
  });
}

function report(state) {
  const tasks = Object.values(state.tasks);
  const done = tasks.filter((task) => task.status === 'done');
  const lines = [`# Run ${state.id} — ${state.name}`, '',
    `${done.length}/${tasks.length} task(s) done; status ${state.status}. Base ${state.base}.`, '', taskTable(state).trimEnd(), ''];
  if (done.length) {
    const order = waves(tasks.map((task) => ({ id: task.id, depends_on: task.depends_on }))).flat().filter((taskId) => state.tasks[taskId].status === 'done');
    lines.push('## Merge (review each branch first; nothing was merged)', '', '```bash',
      ...order.map((taskId) => `git merge --no-ff ${state.tasks[taskId].branch}`), '```', '');
  }
  const stuck = tasks.filter((task) => task.status !== 'done');
  if (stuck.length) {
    lines.push('## Needs attention', '');
    for (const task of stuck) {
      lines.push(`- ${task.id}: ${task.status}${task.status_line ? ` — ${task.status_line}` : ''}${task.note ? ` — ${task.note}` : ''}` +
        `${task.job ? ` (in ${task.worktree}: \`result ${task.job}\`)` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Clean up', '', '```bash', `git worktree list | grep ${state.id}  # then: git worktree remove <path>`, '```', '');
  return lines.join('\n');
}
