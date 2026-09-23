#!/usr/bin/env node
/**
 * Fake `agy` CLI used by the companion regression tests.
 *
 * Never touches the network. Two behaviours:
 *   --version  → print a version string and exit 0 (what `setup` probes)
 *   otherwise  → append the full argv (JSON array, one line) to
 *                $FAKE_AGY_ARGV_FILE and print a single-line JSON payload
 *                shaped like a real `agy --output-format json` result.
 *
 * Env knobs (all optional):
 *   FAKE_AGY_ARGV_FILE       where to record argv (JSONL)
 *   FAKE_AGY_RESPONSE        response text            (default "fake answer")
 *   FAKE_AGY_STATUS          status field             (default "SUCCESS")
 *   FAKE_AGY_CONVERSATION_ID conversation id          (default "conv-1")
 *   FAKE_AGY_SLEEP_MS        stall before answering   (default 0)
 *   FAKE_AGY_EVENTS_DELAY_MS stall before writing the streaming init/events
 *                            block below (default 0) — lets a test start
 *                            following a job before any step event exists,
 *                            instead of racing this process's own startup
 *   FAKE_AGY_EXIT            process exit code        (default 0)
 *   FAKE_AGY_TOUCH_FILE      create this file mid-"run" (default: touch nothing)
 *                            — simulates agy dirtying the working tree, which
 *                            the review/research delta report must catch
 *   FAKE_AGY_GIT_COMMIT      commit message; stage everything and commit it
 *                            mid-"run" (default: commit nothing) — simulates
 *                            agy delivering by git (PATTERNS.md rule 4),
 *                            which can leave the tree exactly as clean (or
 *                            dirty) as it found it while HEAD still moves
 *   FAKE_AGY_STDERR          text written to stderr alongside the payload
 *                            (or before dying under FAKE_AGY_NO_JSON)
 *   FAKE_AGY_ERROR           payload `error` field (default: absent)
 *   FAKE_AGY_NO_JSON         die before printing any payload (default exit 1),
 *                            with FAKE_AGY_STDERR on stderr — simulates agy
 *                            being killed by a harness sandbox pre-JSON
 *   FAKE_AGY_QUOTA           deterministic quota-exhaustion shortcut: sets
 *                            status ERROR (unless FAKE_AGY_STATUS is already
 *                            given) and a payload `error` reproducing agy's
 *                            real RESOURCE_EXHAUSTED/429 shape, so tests don't
 *                            repeat the literal string. Ignored if
 *                            FAKE_AGY_ERROR is already set.
 *   FAKE_AGY_QUOTA_RESETS    the "Resets in" duration text (default
 *                            "4h1m13s", the production incident sample); an
 *                            empty string omits "Resets in" entirely
 *   FAKE_AGY_USAGE           JSON object for the payload `usage` field
 *                            (default: absent — see below)
 *   FAKE_AGY_DURATION_SECONDS payload `duration_seconds`  (default: absent)
 *   FAKE_AGY_NUM_TURNS       payload `num_turns`          (default: absent)
 *
 * Telemetry (usage/duration_seconds/num_turns) is opt-in and absent by
 * default: several regression tests assert the exact stdout of `wait`/
 * `result`'s delivered header, which renders nothing extra when a job
 * carries no telemetry (Fase 1, item 6). A test that wants the header's
 * Usage line, or the job record's persisted fields, opts in with the three
 * knobs above.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_CWD_FILE) fs.writeFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd());

if (argv.includes('--version')) {
  // A probe that never answers in time is how a worker becomes `unknown`.
  // Busy-wait, not setTimeout: the pool kills the process on timeout, and a
  // pending timer would let the runtime exit early and answer after all.
  const delayMs = Number(process.env.FAKE_AGY_VERSION_DELAY_MS || 0);
  if (delayMs > 0) {
    const until = Date.now() + delayMs;
    while (Date.now() < until) {}
  }
  process.stdout.write('1.1.13-fake\n');
  process.exit(0);
}

const argvFile = process.env.FAKE_AGY_ARGV_FILE;
if (argvFile) {
  try {
    fs.appendFileSync(argvFile, JSON.stringify(argv) + '\n');
  } catch {
    /* recording is best-effort */
  }
}

// Deterministic quota-exhaustion simulation (agy-agent-staff Fase 1, item 1):
// reproduce AGY's real RESOURCE_EXHAUSTED/429 shape without repeating the
// literal string in every test that needs it.
if (process.env.FAKE_AGY_QUOTA && !process.env.FAKE_AGY_ERROR) {
  process.env.FAKE_AGY_STATUS ||= 'ERROR';
  const resets = process.env.FAKE_AGY_QUOTA_RESETS ?? '4h1m13s';
  process.env.FAKE_AGY_ERROR =
    'RESOURCE_EXHAUSTED (code 429): Individual quota reached for model gemini-3.8-flash-medium.' +
    (resets ? ` Resets in ${resets}` : '');
}

if (argv[0] === 'models' || argv.includes('models')) {
  if (process.env.FAKE_AGY_MODELS_ERROR) {
    process.stderr.write(process.env.FAKE_AGY_MODELS_ERROR + '\n');
    process.exit(Number(process.env.FAKE_AGY_MODELS_EXIT || 1));
  }
  const defaultModels =
    process.env.FAKE_AGY_MODELS_OUTPUT ??
    [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
      'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    ].join('\n');
  process.stdout.write(defaultModels + '\n');
  process.exit(0);
}

// Side effect knob: write a file while the "model" is working, i.e. strictly
// between the companion's before/after `git status --porcelain` snapshots.
const touch = process.env.FAKE_AGY_TOUCH_FILE;
if (touch) {
  const target = path.resolve(touch);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'written by fake agy\n');
}

// Same window as the touch knob above: strictly between the companion's
// before/after snapshots, so a test can simulate agy delivering by git
// (commit/push/PR) instead of leaving the working tree dirty.
const commitMessage = process.env.FAKE_AGY_GIT_COMMIT;
if (commitMessage) {
  execFileSync('git', ['add', '-A']);
  execFileSync('git', [
    '-c', 'user.name=fake-agy', '-c', 'user.email=fake-agy@example.com',
    'commit', '--allow-empty', '-qm', commitMessage,
  ]);
}

const streaming = argv[argv.indexOf('--output-format') + 1] === 'stream-json';
const eventsDelayMs = Number(process.env.FAKE_AGY_EVENTS_DELAY_MS || 0);
if (eventsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, eventsDelayMs));
if (streaming && !process.env.FAKE_AGY_NO_JSON) {
  process.stdout.write(JSON.stringify({ event: 'init', init: { conversation_id: process.env.FAKE_AGY_CONVERSATION_ID ?? 'conv-1' } }) + '\n');
  if (process.env.FAKE_AGY_EVENTS) {
    for (const event of JSON.parse(process.env.FAKE_AGY_EVENTS)) process.stdout.write(JSON.stringify(event) + '\n');
  }
}

if (process.env.FAKE_AGY_CHILD_PID_FILE) {
  const descendantCode = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)";
  if (process.env.FAKE_AGY_ORPHAN_RELEASE_FILE) {
    const intermediary = `const fs = require('fs'); const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'ignore' }); child.unref(); fs.writeFileSync(process.env.FAKE_AGY_CHILD_PID_FILE, String(child.pid)); setInterval(() => { if (fs.existsSync(process.env.FAKE_AGY_ORPHAN_RELEASE_FILE)) process.exit(0); }, 25);`;
    spawn(process.execPath, ['-e', intermediary], { stdio: 'ignore' });
  } else {
    const child = spawn(process.execPath, ['-e', descendantCode], { detached: !process.env.FAKE_AGY_INHERIT_STDIO, stdio: process.env.FAKE_AGY_INHERIT_STDIO ? ['ignore', 1, 2] : 'ignore' });
    fs.writeFileSync(process.env.FAKE_AGY_CHILD_PID_FILE, String(child.pid));
  }
}
if (process.env.FAKE_AGY_IGNORE_TERM) process.on('SIGTERM', () => {});

const sleepMs = Number(process.env.FAKE_AGY_SLEEP_MS || 0);
if (sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}
if (process.env.FAKE_AGY_RELEASE_FILE) {
  while (!fs.existsSync(process.env.FAKE_AGY_RELEASE_FILE)) await new Promise(resolve => setTimeout(resolve, 25));
}

// Crash knob: emulate agy dying before it can print JSON (e.g. blocked by a
// harness sandbox). Writes FAKE_AGY_STDERR to stderr, prints no payload.
if (process.env.FAKE_AGY_NO_JSON) {
  if (process.env.FAKE_AGY_STDOUT) process.stdout.write(process.env.FAKE_AGY_STDOUT + '\n');
  if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR + '\n');
  process.exit(Number(process.env.FAKE_AGY_EXIT || 1));
}

const payload = {
  status: process.env.FAKE_AGY_STATUS || 'SUCCESS',
  response: process.env.FAKE_AGY_RESPONSE ?? 'fake answer',
  conversation_id: process.env.FAKE_AGY_CONVERSATION_ID ?? 'conv-1',
};
// Opt-in telemetry (Fase 1, item 6) — see the FAKE_AGY_USAGE/
// FAKE_AGY_DURATION_SECONDS/FAKE_AGY_NUM_TURNS doc comment above.
if (process.env.FAKE_AGY_USAGE) payload.usage = JSON.parse(process.env.FAKE_AGY_USAGE);
if (process.env.FAKE_AGY_DURATION_SECONDS) payload.duration_seconds = Number(process.env.FAKE_AGY_DURATION_SECONDS);
if (process.env.FAKE_AGY_NUM_TURNS) payload.num_turns = Number(process.env.FAKE_AGY_NUM_TURNS);
if (process.env.FAKE_AGY_ERROR) payload.error = process.env.FAKE_AGY_ERROR;

if (process.env.FAKE_AGY_STDERR) process.stderr.write(process.env.FAKE_AGY_STDERR + '\n');
await new Promise((resolve) => process.stdout.write(JSON.stringify(streaming ? { event: 'result', result: payload } : payload) + '\n', resolve));
if (process.env.FAKE_AGY_RESULT_FILE) fs.writeFileSync(process.env.FAKE_AGY_RESULT_FILE, 'result sent');
if (process.env.FAKE_AGY_AFTER_RESULT_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_AGY_AFTER_RESULT_MS)));
process.exit(Number(process.env.FAKE_AGY_EXIT || 0));
