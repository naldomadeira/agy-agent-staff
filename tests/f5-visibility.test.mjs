import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, run, jobIdOf, waitForJob, COMPANION, FAKE_AGY } from './helpers.mjs';
import { aggregateUsage, renderTop } from '../companion/views.mjs';

// F5 of the pool redesign: the pool's state where people look — a usage
// history per job, `top` in a terminal, a live local dashboard.

const posixOnly = { skip: process.platform === 'win32' };

function workers(sb, numbers) {
  return numbers.map((n) => {
    const bin = path.join(sb.root, `agy${n}`);
    fs.writeFileSync(bin, `#!/bin/sh\nFAKE_AGY_ID=agy${n} exec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  });
}

const nowS = () => Date.now() / 1000;
function quota(dir, readings) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, { gemini = 10, thirdParty = 10 }] of Object.entries(readings)) {
    fs.writeFileSync(path.join(dir, `agy-quota-profile${n}.json`), JSON.stringify({
      captured_at: nowS(),
      buckets: {
        'gemini 5h': { used_percent: gemini, resets_at: nowS() + 3600 },
        'gemini 7d': { used_percent: gemini, resets_at: nowS() + 86400 },
        '3p 5h': { used_percent: thirdParty, resets_at: nowS() + 3600 },
        '3p 7d': { used_percent: thirdParty, resets_at: nowS() + 7200 },
      },
    }));
  }
}

function envFor(sb, bins) {
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    AGY_BIN: '', AGY_POOL_BINS: bins.join(','), AGY_QUOTA_CACHE_DIR: path.join(sb.root, 'quota-cache'),
  };
}

describe('F5: visibility', () => {
  test('every finished job adds a usage line with its pool and the slack it started and ended with', posixOnly, async () => {
    const sb = sandbox('f5-usage');
    const bins = workers(sb, [2]);
    quota(path.join(sb.root, 'quota-cache'), { 2: { gemini: 30 } });
    const env = envFor(sb, bins);
    const r = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--worker', 'agy2', '--prompt', 'x'], env);
    assert.equal(await waitForJob(sb, jobIdOf(r.stdout)), 'done');
    const lines = fs.readFileSync(path.join(sb.home, '.config', 'agy-staff', 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].worker, 'agy2');
    assert.equal(lines[0].pool, 'gemini');
    assert.equal(lines[0].status, 'done');
    assert.equal(lines[0].slack_start, 70);
    assert.equal(lines[0].slack_end, 70);
    assert.equal(lines[0].attempts, 1);
  });

  test('aggregateUsage counts jobs, deliveries and quota deaths per model', () => {
    const rows = aggregateUsage([
      { ts: '2026-10-09T10:00:00Z', model: 'gemini-3.1-pro-high', worker: 'agy2', status: 'done', tokens: 10, slack_start: 90, slack_end: 80 },
      { ts: '2026-10-09T11:00:00Z', model: 'gemini-3.1-pro-high', worker: 'agy3', status: 'attention', tokens: 5 },
      { ts: '2026-10-10T09:00:00Z', model: 'claude-sonnet-4-6', worker: 'agy9', status: 'quota_exhausted' },
    ]);
    assert.deepEqual(rows.by_model.map((r) => [r.name, r.jobs, r.done, r.quota_deaths, r.tokens]),
      [['gemini-3.1-pro-high', 2, 1, 0, 15], ['claude-sonnet-4-6', 1, 0, 1, 0]]);
    assert.equal(rows.by_worker.find((r) => r.name === 'agy2').spent, 10);
    assert.deepEqual(rows.per_day, [{ day: '2026-10-09', jobs: 2 }, { day: '2026-10-10', jobs: 1 }]);
  });

  test('top without a terminal prints one frame with every account', posixOnly, () => {
    const sb = sandbox('f5-top');
    const bins = workers(sb, [2, 3]);
    quota(path.join(sb.root, 'quota-cache'), { 2: { thirdParty: 100 }, 3: {} });
    const r = run(sb, ['top'], envFor(sb, bins));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^agy pool · mode off · gemini 2\/2 open · 3p 1\/2 open/);
    assert.match(r.stdout, /^agy2 .* 0% ↻/m);
    assert.match(r.stdout, /^agy3 /m);
  });

  test('renderTop marks a closed pool with its reopen time', () => {
    const frame = renderTop({
      generated_at: new Date().toISOString(), mode: 'agy-first',
      summary: { total: 1, gemini: { open: 1 }, third_party: { open: 0 }, stale: [], running_jobs: 0 },
      workers: [{ id: 'agy9', status: 'available', capacity: 1, active_jobs: 0, quota_age_seconds: 30,
        gemini: { slack_percent: 80, blocked_until: null },
        third_party: { slack_percent: 0, blocked_until: new Date(Date.now() + 2 * 3600_000 + 60_000).toISOString() } }],
      jobs: [], runs: [], inbox: [], usage: { by_model: [], by_worker: [], per_day: [] },
    }, { colorOn: false });
    assert.match(frame, /mode agy-first/);
    assert.match(frame, /agy9 .* 80% .* 0% ↻2h0[01]m/);
  });

  test('dashboard serves the page, the snapshot and a live event stream on 127.0.0.1', posixOnly, async () => {
    const sb = sandbox('f5-dashboard');
    const bins = workers(sb, [2]);
    quota(path.join(sb.root, 'quota-cache'), { 2: {} });
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [COMPANION, 'dashboard', '--port', String(port)], {
      cwd: sb.repo, env: { ...process.env, HOME: sb.home, XDG_CONFIG_HOME: '', ...envFor(sb, bins) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (/agy dashboard on/.test(String(chunk))) resolve(); });
        child.on('exit', (code) => reject(new Error(`dashboard exited ${code}`)));
      });
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.match(page, /<title>agy pool<\/title>/);
      const snapshot = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
      assert.equal(snapshot.summary.total, 1);
      assert.equal(snapshot.workers[0].id, 'agy2');
      const events = await fetch(`http://127.0.0.1:${port}/events`);
      const reader = events.body.getReader();
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /^data: \{"generated_at"/);
      await reader.cancel();
    } finally {
      child.kill();
    }
  });
});
