---
name: pool
description: Use the optional AGY worker pool when independent tasks can safely run in parallel across discovered agy workers. Use when the user asks to inspect workers, dispatch parallel AGY work, or select a specific worker.
argument-hint: '[workers|--worker <id>] [task]'
allowed-tools: Bash(node:*)
---

# agy pool

The pool is opt-in. Use `workers` to inspect available workers, or pass `--worker <id>` when dispatching another persona. Without an explicit pool request, the existing skills continue to use the legacy worker (`AGY_BIN || agy`).

## Locating the companion

This skill file lives at `<plugin-root>/skills/pool/SKILL.md`; resolve the companion path relative to this skill directory:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" workers
node "<skill-dir>/../../companion/agy-companion.mjs" <staffer|research|review|implement|ask> --worker <id|auto> --prompt "task"
```

`workers` prints one row per worker: id, executable, status, version, capacity, active jobs, and quota slack. Pass an id from its first column to `--worker`; `--worker auto` prefers the worker with the most quota slack, falling back to the lowest active-job count when slack is unknown or tied. A busy pinned worker is reported as busy, with its load and capacity — that is a reason to wait or cancel, never to dispatch the same job elsewhere.

**Status is three-way, not a boolean.** `available` answered `--version`; `unavailable` is not there (no such binary, or not executable); `unknown` exists but did not answer in time, even after a longer retry. `unknown` is eligible for `--worker auto`, ranked behind everything that answered: it is used when nothing better is free, never instead of a worker that answered. Idle capacity never reports itself, while a dispatch to a dead worker fails fast and says so. The distinction earns its keep: a wrapper that provisions a keychain on first use takes seconds to answer, and calling that "unavailable" sends you hunting an installation problem that is not there.

**Quota slack is a reading off disk, and it carries its age.** It comes from whatever hook writes the quota cache; this command only reads. A worker with no reading shows `-`, which is a real answer and not a failure. Read the age next to the number: `93% (3m)` and `93% (2d)` are not the same claim.

> [!IMPORTANT]
> agy needs a localhost port and its OAuth token file, which some harness sandboxes hide. If the host sandbox blocks them (in Codex: the command fails with a sandbox/permission/connection error), request escalated permissions for the command; if the host already grants that access, just run it. Details: `../jobs/references/troubleshooting.md`.

## Discovery and selection

Workers are discovered by the companion in this order: `AGY_BIN`, entries in `AGY_POOL_BINS`, executable candidates `agy`, `agy2`, `agy3` on `PATH`, then optional `.agy-staff/config.json`. A config may name explicit executables:

```json
{"workers":[
  {"id":"primary","bin":"agy"},
  {"id":"secondary","bin":"/path/to/agy2"},
  {"id":"tertiary","bin":"/path/to/agy3"}
]}
```

Aliases and shell functions are invisible to Node; use real `PATH` executables or explicit paths. The same executable reached two ways — an absolute `AGY_BIN` and the bare name found on `PATH` — is one worker, not two; ids that would otherwise collide are suffixed (`agy2-2`) so every row stays addressable by `--worker`. Separate symlinks to one agy executable stay separate workers.

The default capacity is one active job per worker. Select the available worker with the lowest active-job count, unless a job or conversation already has affinity.

## Safe parallelism

Parallelize only independent tasks with separate ownership and acceptance criteria. Dependent tasks remain sequential. Never parallelize writes in the same worktree automatically: use different worktrees, or obtain explicit authorization for the shared-worktree exception. Keep each job's worker affinity for `continue` and `restart`; an unavailable original worker is reported rather than silently migrated.

A fresh worktree does not inherit a gitignored `.env` — it is untracked, so `git worktree add` leaves
it out. Left unnoticed, this reads as a regression (whole suites failing on a missing environment
variable) rather than the setup gap it actually is. Copy it in when creating the worktree, for
example `cp <repo>/.env <worktree>/.env`, before dispatching a job into it.

Completion means the companion reports the selected worker, affinity, and each job's result; the lead still reviews and integrates all outputs.
