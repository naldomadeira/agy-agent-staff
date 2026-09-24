---
name: implementer
description: Delegate a coding task to Google's Antigravity CLI (agy staffer, fast Gemini), which edits the working tree directly and can perform explicitly requested Git delivery. Use when the user says /agy:implementer, "have agy fix/build X", or wants to hand a well-scoped coding task to the agy staffer instead of doing it in the host model.
argument-hint: '[--continue] [--worker <id>] [--restricted|--unrestricted] [--model <id>|--effort low|medium|high] [--prompt-file <path>|--stdin] "task description"'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(gh:*)
---

# agy implementer

Hand a coding task to the agy staffer. agy edits the real working tree under its unrestricted permission profile; the companion is a thin launcher and job collector. Pass the user's requested delivery through in the task text instead of doing Git work yourself.

## Locating the companion

This skill file lives at `<plugin-root>/skills/implementer/SKILL.md`; resolve the companion path relative to this skill directory:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" implement [flags] --prompt "task description"
```

Pass the user's task description verbatim via `--prompt`; use `--prompt-file <path>` or `--stdin` for long text.

> [!IMPORTANT]
> agy needs a localhost port and its OAuth token file, which some harness sandboxes hide. If the host sandbox blocks them (in Codex: the command fails with a sandbox/permission/connection error), request escalated permissions for the command; if the host already grants that access, just run it. Details: `../jobs/references/troubleshooting.md`. (The companion passes `--dangerously-skip-permissions` to agy in this mode — that is the unrestricted profile working as designed.)

## Workspace and delivery

- Inside a git repository, dirty workspaces are allowed. When `git status --porcelain` is not clean, the companion injects a bounded pre-run status summary into the implement prompt so agy treats those paths as user-owned context.
- Outside a git repository the companion warns that agy's edits cannot be reviewed or rolled back via git, and proceeds. Relay that warning; there is no diff to fall back on.
- By default, agy leaves a working-tree diff. If the user explicitly asks for a commit, push, or PR, include that request verbatim in the task text and let agy do that exact Git delivery.
- After the run, surface agy's summary and the current workspace state. Do not add your own commit/PR step unless the user separately asks you to do it.

## Collecting the result

The command returns a job id. Read `../jobs/SKILL.md` for result collection and recovery: dispatch, wait for the final result, then validate as needed. Do not proactively observe progress, read logs or inspect intermediate artifacts while running. Observe only when the user explicitly asks for progress; diagnose a failure or a result requiring intervention under the jobs protocol.

## Flags (all optional)

- `--worker <id>` — optional pool worker; omitted keeps the legacy worker. Parallel writes require separate worktrees or explicit authorization.

- `--restricted` / `--unrestricted` — permission profile. implement defaults to unrestricted, so it works out of the box with no setup. `--restricted` is the opt-in hardening path: agy may then only use allowlisted tools, so it can usually only propose rather than edit, and it needs the setup flow's evidence-gathering allowlist to be useful.
- `--continue` (or `--conversation <id>`), `--model <id>` / `--effort low|medium|high` (default `gemini-3.8-flash-high`; when to override: `../jobs/references/model-routing.md`), `--timeout <dur>` (default 60m, maximum 120m hard execution limit).
- `--prompt <text>` / `--prompt-file <path>` / `--stdin` — the task, from exactly one of these three sources. Use file/stdin for long prompts.
- `--gate <names>` / `--gate-cmd <cmd>` / `--gate-timeout <dur>` / `--allow-gate` — see "Don't brief agy to run its own gate" below.

## Don't brief agy to run its own gate

Never order a full build/test/lint/typecheck baseline in the briefing (e.g. "run `pnpm check` and `pnpm build` to confirm the state of the project") — a briefing like that refuses **before dispatch** (exit 1, no job, no agy call), because the worker has burned entire runs on the gate instead of the task. Targeted tests for what you changed are fine in the briefing (`pnpm test src/x.test.ts`, `pytest tests/x.py -k foo`, `go test ./pkg/...`).

To prove the result instead, declare a gate for the COMPANION to run after the worker reports done — it doesn't eat into the agent's own time budget:

```json
{"gates": {"check": "pnpm check", "build": "pnpm build"}}
```

in `.agy-staff/config.json`, then dispatch with `--gate check,build`. A failing or timed-out gate ends the job `attention`/`gate_failed`; a passing gate turns even a worker's own `verification_incomplete` into `done`. Use `--gate-cmd "<cmd>"` for a one-off command with no config entry.

Only pass `--allow-gate` when the user explicitly wants agy itself to run the gate inside its own run (it authorizes a detected order instead of refusing it) — prefer `--gate` so the companion verifies the result independently.

## Rules

- Do not pre-implement, extend, or "clean up" agy's changes without user confirmation.
- Return agy's summary verbatim before presenting the diff.
- Pass the user's explicit authorizations through to the task string verbatim. The prompt template default-denies costly or irreversible side effects; that default opens only when the request itself asks for the operation — so keep "open a draft PR", "run the e2e tests", or "call the staging API" in the prompt instead of trimming it.
- Never commit agy's changes yourself unless the user explicitly asks you, the host agent, to do it.
- For errors and recovery, follow `../jobs/SKILL.md`.

For an existing conversation, `--continue` / `--conversation <id>` inherit its recorded model and permission profile unless explicitly overridden. The unrestricted defaults above apply to new tasks.
