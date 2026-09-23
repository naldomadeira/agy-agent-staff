/**
 * triageResult: a non-SUCCESS status must never discard a finished answer,
 * and cause hints are appended only when the error text actually matches.
 *
 * The motivating incident: jobs whose final tool call timed out were marked
 * exit 3 even though the complete answer was already in payload.response, and
 * the caller's failure protocol ("quote the error, stop") threw the answer
 * away. Non-SUCCESS + non-empty response is now done_with_warnings: exit 0,
 * response on stdout, warning on stderr.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, jobIdOf, jobLog, waitForJob, agyCalls } from './helpers.mjs';

const stateFile = sb => path.join(sb.repo, '.agy-staff', 'state.json');
const readState = sb => JSON.parse(fs.readFileSync(stateFile(sb), 'utf8'));

const CATALOG_WITHOUT_38 = [
  'Fetching available models...',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
].join('\n');

describe('done_with_warnings: non-SUCCESS status with a complete response', () => {
  test('foreground (ask): exit 0, response intact on stdout, warning on stderr', () => {
    const sb = sandbox('triage-warn-fg');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: 'the full answer, produced before the failure',
    });
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /the full answer, produced before the failure/);
    assert.match(r.stderr, /agy-staff warning: agy reported status ERROR/);
    assert.doesNotMatch(r.stdout, /agy-staff warning/, 'the warning must not pollute the deliverable');
  });

  test('background (research): job ends done, wait exits 0 and prints the response', async () => {
    const sb = sandbox('triage-warn-bg');
    const started = run(sb, ['research', '--prompt', 'a topic'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: 'survey results',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /survey results/);
    assert.match(jobLog(sb, id), /agy-staff warning: agy reported status ERROR/);
  });
});

describe('cause hints are conditional on the error text', () => {
  test('an unrelated error (tool timeout) gets no model/auth/quota hint', () => {
    const sb = sandbox('triage-hint-none');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_STDERR: 'grep: process timed out after 30s',
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /grep: process timed out after 30s/, 'the real error must be quoted');
    assert.doesNotMatch(r.stderr, /Likely cause/);
  });

  test('a model-id error gets exactly the model hint', () => {
    const sb = sandbox('triage-hint-model');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: '--model gemini-3.8-flash requires --effort',
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Likely cause: invalid model id/);
    assert.doesNotMatch(r.stderr, /expired auth|exhausted quota/);
  });
});

describe('quota_exhausted classification (Fase 1, item 1)', () => {
  test('RESOURCE_EXHAUSTED with "Resets in" is classified quota_exhausted: exit 6, model + resets_in + recovery, never suggests continuing on the same model', () => {
    const sb = sandbox('quota-resets');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached for model gemini-3.8-flash-low. Resets in 4h1m13s',
    });
    assert.equal(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Quota exhausted: model gemini-3\.8-flash-low, resets in 4h1m13s\./m);
    assert.match(r.stderr, /workers/);
    assert.match(r.stderr, /Do not `continue` on the same model/);
  });

  test('a 429/rate-limit error with no "Resets in" text never invents a reset time', () => {
    const sb = sandbox('quota-no-resets');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: '429 rate limit exceeded',
    });
    assert.equal(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Quota exhausted: model gemini-3\.8-flash-low \(reset time not reported\)\./m);
    assert.doesNotMatch(r.stderr, /resets in/i);
  });

  test('a quota ERROR with partial response text still becomes quota_exhausted and preserves the partial text — it must not fall into done_with_warnings', () => {
    const sb = sandbox('quota-partial-response');
    const r = run(sb, ['ask', '--prompt', 'a question'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: 'partial answer produced before the quota error',
      FAKE_AGY_ERROR: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 45s',
    });
    assert.equal(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Quota exhausted: model gemini-3\.8-flash-low, resets in 45s\./m);
    assert.match(r.stderr, /partial answer produced before the quota error/);
    assert.doesNotMatch(r.stderr, /done_with_warnings|agy-staff warning: agy reported status ERROR/);
  });

  test('401/403 auth errors are never classified as quota', () => {
    const sb = sandbox('quota-not-auth');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: '401 Unauthorized: Invalid credentials',
    });
    assert.notEqual(r.code, 6);
    assert.doesNotMatch(r.stderr, /Quota exhausted/);
    assert.match(r.stderr, /expired auth/);
  });

  test('an invalid-model error is never classified as quota', () => {
    const sb = sandbox('quota-not-model');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'model gemini-3.8-flash-low is not recognized as a known model',
    });
    assert.notEqual(r.code, 6);
    assert.doesNotMatch(r.stderr, /Quota exhausted/);
  });

  test('a retried 429 or a stray "429" in agy stderr does not turn an unrelated ERROR into quota', () => {
    const sb = sandbox('quota-not-stderr-noise');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'stream closed unexpectedly',
      FAKE_AGY_STDERR: 'tool http_get: got 429, rate limit hit, retrying\nworker pid 429 exited',
    });
    assert.notEqual(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /Quota exhausted/);
  });

  test('RESOURCE_EXHAUSTED reported only on agy stderr is still quota', () => {
    const sb = sandbox('quota-stderr-strong');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'request failed',
      FAKE_AGY_STDERR: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h',
    });
    assert.equal(r.code, 6, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /resets in 2h\./);
  });

  test('SUCCESS with "429"/"quota" mentioned in the response body stays done — response text is never scanned for classification', () => {
    const sb = sandbox('quota-not-success-body');
    const r = run(sb, ['ask', '--prompt', 'summarize this bug report'], {
      FAKE_AGY_STATUS: 'SUCCESS',
      FAKE_AGY_RESPONSE: 'The bug report mentions a 429 RESOURCE_EXHAUSTED error from an unrelated API. Resets in 3 days per their docs. Quota exceeded, they said.',
    });
    assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /429 RESOURCE_EXHAUSTED/);
    assert.doesNotMatch(r.stderr, /Quota exhausted:/);
  });

  test('missing_result (agy killed before producing JSON) is never classified as quota', async () => {
    const sb = sandbox('quota-not-missing-result');
    const started = run(sb, ['research', '--prompt', 'a topic'], {
      FAKE_AGY_NO_JSON: '1',
      FAKE_AGY_STDERR: 'operation not permitted',
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'error');
    const res = run(sb, ['result', id]);
    assert.doesNotMatch(res.stdout, /Quota exhausted/);
  });
});

describe('continue/restart into a quota_exhausted window warns without blocking (Fase 1, item 7)', () => {
  const quotaEnv = { FAKE_AGY_QUOTA: '1', FAKE_AGY_RESPONSE: '', FAKE_AGY_QUOTA_RESETS: '4h1m13s' };

  test('continue --job <id> on the same model within the reset window warns on stderr, then still dispatches', async () => {
    const sb = sandbox('quota-continue-warn');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], quotaEnv);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const r = run(sb, ['continue', '--job', id, '--prompt', 'try again']);
    assert.match(
      r.stderr,
      new RegExp(
        `agy-staff warning: job ${id} ended quota_exhausted on model gemini-3\\.8-flash-high ` +
          '\\(resets in 4h1m13s from .+\\); continuing on the same model will likely fail again — ' +
          'pass --model <other> or choose another worker \\(see workers\\)\\.'
      )
    );
    assert.equal(r.code, 0, r.stderr); // a warning, never a block
  });

  test('bare `continue --conversation <id>` resolving to the same quota_exhausted job also warns', async () => {
    const sb = sandbox('quota-continue-bare');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], {
      ...quotaEnv, FAKE_AGY_CONVERSATION_ID: 'quota-conv',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const r = run(sb, ['continue', '--conversation', 'quota-conv', '--prompt', 'try again']);
    assert.match(r.stderr, new RegExp(`agy-staff warning: job ${id} ended quota_exhausted on model gemini-3\\.8-flash-high`));
  });

  test('restart reusing the same model warns the same way', async () => {
    const sb = sandbox('quota-restart-warn');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], quotaEnv);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const r = run(sb, ['restart', id]);
    assert.match(r.stderr, new RegExp(`agy-staff warning: job ${id} ended quota_exhausted on model gemini-3\\.8-flash-high`));
  });

  test('no warning once the reset window has clearly passed', async () => {
    const sb = sandbox('quota-continue-window-passed');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], quotaEnv);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    // Fake the job's finished_at well past the 4h1m13s reset window, exactly
    // as the maintainer's TDD note asks for this case.
    const data = readState(sb);
    data.jobs.find(j => j.id === id).finished_at = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    fs.writeFileSync(stateFile(sb), JSON.stringify(data));

    const r = run(sb, ['continue', '--job', id, '--prompt', 'try again']);
    assert.doesNotMatch(r.stderr, /agy-staff warning: job/);
  });

  test('no warning when --model differs from the job\'s model', async () => {
    const sb = sandbox('quota-continue-diff-model');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], quotaEnv);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const r = run(sb, ['continue', '--job', id, '--model', 'gemini-3.7-flash-high', '--prompt', 'try again']);
    assert.doesNotMatch(r.stderr, /agy-staff warning: job/);
  });

  test('warns without a time claim when resets_in is missing/unparseable', async () => {
    const sb = sandbox('quota-continue-no-resets');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic'], {
      ...quotaEnv, FAKE_AGY_QUOTA_RESETS: '',
    });
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'quota_exhausted');

    const r = run(sb, ['continue', '--job', id, '--prompt', 'try again']);
    assert.match(
      r.stderr,
      new RegExp(
        `agy-staff warning: job ${id} ended quota_exhausted on model gemini-3\\.8-flash-high; ` +
          'continuing on the same model will likely fail again — pass --model <other> or choose another worker \\(see workers\\)\\.'
      )
    );
    assert.doesNotMatch(r.stderr, /resets in/);
  });

  test('a job that did not end quota_exhausted never warns on continue', async () => {
    const sb = sandbox('quota-continue-not-quota');
    const started = run(sb, ['research', '--model', 'gemini-3.8-flash-high', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'done');

    const r = run(sb, ['continue', '--job', id, '--prompt', 'follow up']);
    assert.doesNotMatch(r.stderr, /agy-staff warning: job/);
  });
});

describe('unsupported model error handling without silent fallback', () => {
  test('foreground (ask) fails clearly on catalog without 3.8 Flash, reports models, recommends same-effort 3.7-flash-low, and does not retry', () => {
    const sb = sandbox('unsupported-ask');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'invalid model selection (--model "gemini-3.8-flash-low" --effort ""): model gemini-3.8-flash-low is not recognized as a known model or custom model in settings',
      FAKE_AGY_MODELS_OUTPUT: CATALOG_WITHOUT_38,
    });
    assert.notEqual(r.code, 0);
    // Actionable failure behavior
    assert.match(r.stderr, /requested model "gemini-3\.8-flash-low"/);
    assert.match(r.stderr, /Available models \(from `agy models`\):/);
    assert.match(r.stderr, /gemini-3\.7-flash-low/);
    assert.match(r.stderr, /Best same-effort compatible recommendation: --model gemini-3\.7-flash-low/);
    assert.match(r.stderr, /Updating agy is preferred to use the latest default/);

    // No automatic retry or silent fallback
    const calls = agyCalls(sb);
    const taskRuns = calls.filter((args) => args.includes('-p'));
    assert.equal(taskRuns.length, 1, 'must only run agy once for the task, no retry');
    assert.ok(!calls.some((args) => args.includes('gemini-3.7-flash-low')), 'must not silently fall back to 3.7');
  });

  test('background job (implement) fails clearly on catalog without 3.8 Flash, recommending same-effort 3.7-flash-high', async () => {
    const sb = sandbox('unsupported-implement');
    const started = run(sb, ['implement', '--prompt', 'a task'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'model gemini-3.8-flash-high is not recognized as a known model',
      FAKE_AGY_MODELS_OUTPUT: CATALOG_WITHOUT_38,
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'error');

    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /requested model "gemini-3\.8-flash-high"/);
    assert.match(res.stdout, /Available models \(from `agy models`\):/);
    assert.match(res.stdout, /gemini-3\.7-flash-high/);
    assert.match(res.stdout, /Best same-effort compatible recommendation: --model gemini-3\.7-flash-high/);
    assert.match(res.stdout, /Updating agy is preferred to use the latest default/);

    // Verify wait exit code 3
    const w = run(sb, ['wait', id]);
    assert.equal(w.code, 3);
    assert.match(w.stdout, /Best same-effort compatible recommendation: --model gemini-3\.7-flash-high/);

    // No automatic retry or silent fallback in background execution
    const calls = agyCalls(sb);
    const taskRuns = calls.filter((args) => args.includes('-p'));
    assert.equal(taskRuns.length, 1, 'worker must not automatically retry with another model');
    assert.ok(!calls.some((args) => args.includes('gemini-3.7-flash-high')), 'must not silently fall back to 3.7');
  });

  test('background job (staffer) recommends medium effort gemini-3.7-flash-medium on catalog without 3.8 Flash', async () => {
    const sb = sandbox('unsupported-staffer');
    const started = run(sb, ['staffer', '--prompt', 'a general task'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'unknown model: gemini-3.8-flash-medium',
      FAKE_AGY_MODELS_OUTPUT: CATALOG_WITHOUT_38,
    });
    assert.equal(started.code, 0, started.stderr);
    const id = jobIdOf(started.stdout);
    assert.equal(await waitForJob(sb, id), 'error');

    const res = run(sb, ['result', id]);
    assert.match(res.stdout, /requested model "gemini-3\.8-flash-medium"/);
    assert.match(res.stdout, /Best same-effort compatible recommendation: --model gemini-3\.7-flash-medium/);
  });

  test('preserves original error and advises running agy models when model discovery fails', () => {
    const sb = sandbox('unsupported-discovery-fail');
    const r = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: 'model gemini-3.8-flash-low is not recognized as a known model',
      FAKE_AGY_MODELS_ERROR: 'daemon disconnected: unable to reach model service',
    });
    assert.notEqual(r.code, 0);
    // Original error preserved
    assert.match(r.stderr, /model gemini-3\.8-flash-low is not recognized as a known model/);
    assert.match(r.stderr, /daemon disconnected/);
    // Advise running agy models and updating agy
    assert.match(r.stderr, /run `agy models`/i);
    assert.match(r.stderr, /Updating agy is preferred/);
  });

  test('does not misclassify auth, quota, network, or unrelated errors', () => {
    const sb = sandbox('no-misclassify');

    // Auth error
    const rAuth = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: '401 Unauthorized: Invalid credentials',
    });
    assert.notEqual(rAuth.code, 0);
    assert.match(rAuth.stderr, /expired auth/);
    assert.doesNotMatch(rAuth.stderr, /Best same-effort compatible recommendation/);
    assert.doesNotMatch(rAuth.stderr, /Available models/);

    // Quota error — now its own terminal state (quota_exhausted classification,
    // covered in detail above), not the old generic-error "exhausted quota" hint.
    const rQuota = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_ERROR: '429 ResourceExhausted: Quota exceeded for project',
    });
    assert.equal(rQuota.code, 6);
    assert.match(rQuota.stderr, /Quota exhausted:/m);
    assert.doesNotMatch(rQuota.stderr, /Best same-effort compatible recommendation/);

    // Unrelated error
    const rUnrelated = run(sb, ['ask', '--prompt', 'hello'], {
      FAKE_AGY_STATUS: 'ERROR',
      FAKE_AGY_RESPONSE: '',
      FAKE_AGY_STDERR: 'fatal error: memory allocation failed in subshell',
    });
    assert.notEqual(rUnrelated.code, 0);
    assert.doesNotMatch(rUnrelated.stderr, /Best same-effort compatible recommendation/);
    assert.doesNotMatch(rUnrelated.stderr, /Available models/);
  });
});
