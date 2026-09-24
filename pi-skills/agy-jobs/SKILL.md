---
name: agy-jobs
description: Manage agy staffer background jobs - collect results, check status, cancel, follow-up conversation, and setup. Use when an agy job needs collecting, when the user asks "is the agy job done", "show agy's result", "cancel the agy job", "continue the agy conversation", or "set up agy". This is the orchestrator's skill; the persona skills (staffer/researcher/reviewer/implementer) point here.
---

<!-- Generated from skills/jobs/SKILL.md; run npm run generate:pi. Do not edit here. -->

# agy jobs

Jobs may record a selected pool worker (`id`, executable, and detected version). Every background dispatch now prints `AGY worker: …`; `status`, `observe`, and the delivered result preserve that context so Codex, Claude Code, and other hosts can show which external worker is operating. `continue` and `restart` preserve affinity; legacy jobs without worker metadata use `AGY_BIN || agy`. Use the pool skill's `workers` command to inspect availability and active load.

Manage background staffer/research/review/implement jobs. State is per repository in `.agy-staff/`. Only ask runs synchronously.

This file lives at `<plugin-root>/pi-skills/agy-jobs/SKILL.md`:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" <command> [args]
```

## Collect the result

Default flow: prepare the prompt → dispatch → wait for the final result → validate as needed. While a job is running, do not proactively call `observe`/`status`, read logs or inspect intermediate artifacts. Do not query progress for routine updates or create sleep/observe loops. Observe only when the user explicitly asks for progress; diagnose after receiving a failure or a result requiring intervention.

1. Keep the returned job id, then collect it:
   - **Claude Code (background-job notifications)** — launch `wait <id> --until-done` as a background command (`run_in_background`); the host notifies you when it returns, so nothing has to poll or re-arm.
   - **Codex and other hosts without background notifications** — use `wait <id> --timeout 10m --follow` in the foreground, and re-arm the same call again on exit 2. `--follow` writes each step to stderr as the job runs, so the call does not sit with no output for the whole wait.

   Use a separate wait for each job; never wait for several jobs serially in one shell. **Never pipe `wait`'s output** — a pipe loses the exit code under a shell's default `pipefail`-off behavior, and the plain JSON on stdout then reads as a delivered result even on exit 2; if you must pipe it, `set -o pipefail` and check `${PIPESTATUS[0]}` (bash) or an equivalent, or capture output to a file/variable instead.
2. Branch on the terminal state/reason:

| State / reason | Exit | Next action |
| --- | --- | --- |
| `done` | 0 | Delivered. Assess whether it satisfies the task; inspect attached diagnostics further only as needed. |
| running (wait soft-expired) | 2 | **Not delivered.** Wait again for the same job — never treat the attached snapshot as the result or as a request to inspect/intervene. |
| attention — resumable timeout | 5 | Inspect partial workspace changes; ask the user whether to continue with the suggested timeout or stop. Continue only after explicit confirmation. |
| attention — `implement_no_changes` | 5 | A true no-op. Decide whether to retry, reframe the task, or hand it off differently; there is nothing to inventory or commit. |
| attention — `implement_uncommitted` | 5 | Changes exist but the requested delivery (commit/push/PR) didn't happen. Commit/deliver yourself or inspect (`git status`, `git diff`) before deciding. |
| attention — `verification_incomplete` | 5 | The worker itself declared a verification still pending. **Run the pending build/test yourself** before accepting the work as done. |
| attention — `gate_failed` | 5 | A companion-run `--gate`/`--gate-cmd` failed or timed out after the worker finished. Read `## Companion verification` in the report for the command, exit code, and output tail; fix the failure and `continue --job <id>` with the gate output, or inspect and fix it yourself. **Don't accept the work as done.** |
| `quota_exhausted` | 6 | Switch to another worker or model with headroom (see the `pool` skill's `workers`) or wait for `resets_in`. **Never `continue` on the same model before the reset.** |
| error / crashed | 3 | Read the report's `## Partial work` section and inspect the diff (`git status`, `git diff`) before any recovery. |
| canceled | 4 | Read `## Partial work`, inspect the diff, then complete any already-authorized follow-up or report cancellation. |
| command error | 1 | Quote the error and correct the named problem. |

A job with a declared gate (`--gate`/`--gate-cmd`) that reaches `phase: "verifying"` (visible in `status`/`observe`, and announced on `wait --follow`'s stderr) means the agent itself already finished and the companion is now running the gate command(s) — the job's own `status` is still `running`, still exit 2: keep waiting, the same as any other still-running job.

A `implement`/`continue`/`restart` call can also refuse **before dispatch** with exit 1 (no job created, agy never invoked) when the briefing text orders a full gate itself (an untargeted `pnpm test`, `pnpm build`, `pytest`, etc.) instead of declaring one. The error quotes the offending line; fix it by removing the gate order from the briefing, or by declaring `--gate <name>` (companion runs it after the worker finishes) or `--allow-gate` (authorizes the worker to run it itself).

`done` describes invocation and response delivery, not task acceptance. Preserve agy-cli response text and diagnostics; a nonempty response may only acknowledge launched background work. Successful calls with warnings include a bounded log tail on stderr and a full-log pointer. A terminal job's header also carries a `Usage:` line (in/out/think/cache tokens, duration, turns) when AGY reported telemetry — read it for cost awareness before deciding whether to continue or retry, not as a completion signal. The orchestrator assesses the response and artifacts, uses `observe` or diagnostics if the returned result needs investigation, and decides whether to propose continuation. Keep the recovery confirmation rules below; do not infer timeout from response wording or add routine progress polling.

When the user explicitly asks for progress, use `observe <id>` and answer from that snapshot, keeping any pending wait open. An already returned snapshot may answer the question; do not duplicate it or turn one question into recurring observation.

Collecting a pending wait command is necessary result collection, not active observation. Host collectors (for example, Codex `write_stdin`) return that command's output; an outer `functions.wait` resumes a yielded `functions.exec` call. They do not independently read AGY progress. Prefer background completion delivery; if host collection requires polling, use a long supported blocking wait rather than short empty polls or sleep loops. Keep the same pending command until it returns; only restart `wait` for the same job after exit 2.

A wait expires without stopping the worker. Cancel only when the task calls for stopping; silence or soft expiry alone is not a reason. For a user-requested progress answer or diagnosis after failure/required intervention, read a bounded `details` excerpt only if the returned information leaves a specific question unanswered. Never inspect logs or intermediate artifacts for routine reassurance.

When using lead, let the lead assess and synthesize the results. For direct persona invocations, deliver short results verbatim; summarize long results with their file path. Keep quoted verdicts, numbers and errors exact. For implement, also report the workspace state and inspect changes with `git diff`; verify any Git delivery that the user explicitly requested.

Follow through to a result unless the user asked only to launch. If the host cannot deliver background command results, use the longest practical wait within its tool-call limit (bare `wait` defaults to 100s). The host controls when the model receives a tool result; this plugin cannot schedule a future model invocation by itself.

## Other commands

| Command | Purpose |
| --- | --- |
| `observe [id]` | On an explicit user progress request, or for diagnosis after failure/required intervention: bounded JSON with progress or terminal metadata and recovery pointers. Never returns report text. |
| `status [id]` | List jobs with worker identity, or show one job's state and log tail. |
| `result [id]` | Reprint stored output; default to the latest finished job. |
| `cancel <id>` | Stop that job's execution. Interrupting wait does not cancel it. |
| `continue --job <id> --prompt "..."` | Resume the job's conversation with its original mode/model/profile; create a linked new job. |
| `continue --prompt "..."` | Continue the latest conversation; `--conversation <id>` selects a known older one. |
| `restart <id>` | Start the original task/configuration again without its conversation; create a linked new job. |
| `setup [--apply] [--restrict <modes\|none>]` | Optional permission setup; read `references/setup.md` first. |

Wait/observe default to the latest job. Observe uses the same status exit codes, but exit 0 means **finished, not full result delivered**. Collect the existing wait session, or use `result <id>` if none is pending; do not start another wait or expect observe to consume the pending session. Failed/canceled/attention observations provide bounded recovery metadata; wait/result deliver the full report. A continued ask remains synchronous. `result` also returns exit 5 for attention (its legacy exit behavior for other terminal states is unchanged).

Continuation and restart may be invoked from the root or any subdirectory of the same worktree; execution returns to the original cwd. Generic `continue` fails for an unrecorded conversation ID. It does not search other worktrees or infer configuration from an unrelated conversation. For continuation, explicit model/profile flags override the inherited values.

Cancel records a request first and returns success only after the worker has stored the cancellation report and published `canceled`. A crashed job keeps its crash diagnostics. A cancellation error requires inspection; it does not mean execution has stopped.

## Follow-up instructions

Use `continue --job <id>` to target an existing AGY conversation. It starts a new invocation once the current execution has stopped. While that job is still running, the companion refuses the follow-up with exit 1, reporting the job ID and status; nothing is queued. Decide whether to wait or cancel.

- **Finished:** continue directly with the next assignment or revision.
- **Running, feedback can wait:** collect the current result, then continue.
- **Running, direction must change now:** cancel the active job, confirm termination, then continue with the updated brief. An already-authorized change of direction does not require another confirmation solely for this sequence.

Include relevant decisions made in the host conversation, what changed, and what the worker should do next. After interruption, reconcile partial artifacts before repeating work: cancellation does not roll back edits, and the conversation may not contain the last interrupted step. If no usable conversation exists, start a fresh task with the updated brief and retained work. Timeout recovery still follows the rules below.

## Progress and recovery

Progress contains up to five recent tool calls, input/output excerpts, and the latest response text. Timestamps, incomplete text and truncation are labeled. It is a snapshot, not a judgment of useful progress. Reads do not consume history or reset deadlines. Payload limits and file layout are in `../../docs/REFERENCE.md`.

Exit 5 (`attention`) is not only the resumable timeout below — it is also `implement_no_changes`, `implement_uncommitted`, and `verification_incomplete` (see the action table above). This section covers the hard-timeout path specifically; for the other three, act on their row in the table instead of the recovery flow described here.

The worker has a separate hard limit: default 60m, configurable with launch `--timeout` up to 120m. AGY receives the same response timeout; the worker independently enforces the overall budget, including initialization. At that limit it stops execution. If response text has already arrived, it delivers that text with a warning for the orchestrator to assess; otherwise it reports `hard_timeout`, the last snapshot, logs, known conversation ID and original configuration. Before recovery, inspect `git status` and `git diff` so partial changes are accounted for. Prefer `continue --job` when a conversation exists; otherwise use `restart`. Each creates a fresh 60m budget unless `--timeout` is specified, and preserves the old terminal record. Restart refreshes workspace context; older specifications explicitly label historical snapshots and append current context. An empty response at either the AGY response deadline or worker hard limit becomes `attention` (exit 5) when a conversation ID is known, otherwise `error`. The response-timeout classifier accepts explicit TIMEOUT statuses and AGY's exact `ERROR` / `timeout waiting for response` payload; unrelated tool/network/auth/quota errors keep their own failure path. The report includes pre-run/current workspace status, original configuration and an exact continuation command with a doubled timeout capped at 120m for background jobs. At that ceiling, offer a narrower task. Ask the user whether to continue or stop and inspect; do not automatically retry, restart or continue after a timeout. Run the proposed recovery only after explicit user confirmation. A wait soft expiry is still exit 2 and requires no new execution.

Warning-free success removes intermediate stream/snapshot files after results are stored. Errors, cancellation, hard timeout and warning results retain them; results, logs and conversation metadata remain available. Older jobs may have no progress files.

Quote errors and add a concise diagnosis. For sandbox/permission errors or an apparent crash without a result, check that collection uses the same unsandboxed context as launch; see `references/troubleshooting.md`. For restricted empty responses, relay the companion's permission guidance. Do not switch repositories to bypass a precondition.

## Recommended prompt shape for dispatched work

Background jobs come back consistently better when the prompt follows this shape, in order:
CONTEXT (which repo and worktree, which branch, who else is running in parallel) · WHAT YOU WILL DO
(one task, the absolute path to its spec, "read it whole before writing a line") · WHY THIS TASK
EXISTS (the real problem, in two sentences, with concrete evidence) · WHAT ALREADY EXISTS ON THIS
BRANCH (what other tasks left ready to reuse instead of rebuilding) · EXECUTION ORDER, numbered,
not to be skipped · FILES YOU MAY / MAY NOT TOUCH (explicit lists; "if you find yourself editing
another file, STOP and report") · PITFALL (the trap specific to this repo) · VERIFICATION (exact
commands) · DELIVERY (commit policy) · REPORT (what was delivered, literal command output, and any
point where the task contradicts the real code).

Two parts of that shape carry disproportionate weight:

- **REPORT must explicitly ask for contradictions between the spec and the real code.** Without
  that instruction an executor quietly works around a mismatch instead of surfacing it; asking for
  it turns the executor into a defect detector instead of a code-around machine.
- **VERIFICATION must give a numeric baseline, not "tests pass."** A number like "65 suites, 581
  tests, zero failures" gives the executor an objective bar to compare against — without one, a
  pre-existing failure and a real regression read identically in its report.

## Host compatibility

When this skill or its referenced instructions require a tool that the current environment does not provide, use available capabilities to achieve an equivalent result. Adapt only the tool-specific execution method; preserve the task goal, authorization requirements, explicit confirmation steps, result delivery, and stopping conditions.

If an equivalent result cannot be achieved, or you cannot establish that an alternative is equivalent, explain the missing capability and its impact, and ask the user for help. Do not silently skip requirements or bypass the environment's restrictions.
