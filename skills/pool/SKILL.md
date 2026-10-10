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
node "<skill-dir>/../../companion/agy-companion.mjs" workers --probe
node "<skill-dir>/../../companion/agy-companion.mjs" status --line
node "<skill-dir>/../../companion/agy-companion.mjs" <staffer|research|review|implement|ask> --worker <id|auto> --prompt "task"
```

`workers` prints one row per worker: id, executable, status, version, capacity, active jobs, **Gemini quota slack** and **Anthropic/3p quota slack**. Pass an id from its first column to `--worker`; `--worker auto` compares only the quota family of the requested model (Gemini models use Gemini; Claude and other third-party models use 3p), falling back to the lowest active-job count when that family's slack is unknown or tied. A busy pinned worker is reported as busy, with its load and capacity — that is a reason to wait or cancel, never to dispatch the same job elsewhere.

The two quota families are independent. Exhausted Anthropic/3p quota does not imply exhausted Gemini quota. Before choosing a model for pooled work, inspect both columns; if 3p is exhausted and Gemini has headroom, choose an appropriate Gemini model explicitly with `--model`, then use `--worker auto`. Do not silently change a user's explicitly requested model. Cache readings older than six hours are labeled `stale` and ignored by auto selection; `-` means no usable reading, including when one family window reset without a new measurement. Neither state proves a worker has no quota. `limitesv2 --agy` shows the underlying 5h and 7d windows when that local command is installed.

**Status is three-way, not a boolean.** `available` answered `--version`; `unavailable` is not there (no such binary, or not executable); `unknown` exists but did not answer in time, even after a longer retry. `unknown` is eligible for `--worker auto`, ranked behind everything that answered: it is used when nothing better is free, never instead of a worker that answered. Idle capacity never reports itself, while a dispatch to a dead worker fails fast and says so. The distinction earns its keep: a wrapper that provisions a keychain on first use takes seconds to answer, and calling that "unavailable" sends you hunting an installation problem that is not there.

**Quota slack is a reading off disk, and it carries its age.** It comes from whatever hook writes the quota cache (agy's status line rewrites it during every run). A worker with no reading shows `-`, which is a real answer and not a failure. Read the age next to the number; a reading from yesterday is marked `stale`, not treated as live capacity. A closed pool shows when it reopens (`0% (3m) ↻15h54m`): the reset of the window that closes it, so a full weekly window wins over an empty 5h one. A window agy marks `disabled` closes its pool even when its percentage reads 0%.

**Refresh before a dispatch round: `workers --probe`.** It pings every account whose reading is missing or older than ten minutes with one tool-free `gemini-3.8-flash-low` turn (about 9 s, in parallel, a sliver of Gemini quota), which makes agy rewrite the cache, then prints the fresh table. Per-account outcomes go to stderr (`probe agy7: ok in 9s`). Do this before planning parallel work instead of dispatching blind: a reading older than ten minutes does not show the bursts other jobs spent since.

**Pool summary: `status --line` and `status --json`.** One line for a status bar — `agy gem 8/10 · 3p 0/10 ↻1h32m · stale 2 · ▶3` (accounts open per pool, when the next closed one reopens, readings older than 10 min, running jobs) — or the same as JSON, with `open_workers` per pool and a per-worker breakdown. Neither starts agy unless `--probe` is passed. `workers --json` gives the table as JSON.

> [!IMPORTANT]
> agy needs a localhost port and its OAuth token file, which some harness sandboxes hide. If the host sandbox blocks them (in Codex: the command fails with a sandbox/permission/connection error), request escalated permissions for the command; if the host already grants that access, just run it. Details: `../jobs/references/troubleshooting.md`.

## Discovery and selection

Workers are discovered by the companion in this order: `AGY_BIN`, entries in `AGY_POOL_BINS`, executable candidates `agy`, `agy2`, `agy3` and any installed `agy4` through `agy20` on `PATH` (`AGY_POOL_MAX_PROFILE` raises the ceiling), then optional `.agy-staff/config.json`. `AGY_POOL_BINS` is only needed for extra names or paths outside `PATH`; separate its entries with commas, spaces, or `:` (`;` on Windows). A `--worker <id>` that was never discovered says so and lists the known ids; a busy one reports its load. A config may name explicit executables:

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

For image generation, dispatch smaller batches instead of asking one worker for a large set at once. Track the number requested, saved to disk, and reviewed. After each batch, read the partial result and inspect the generated files before deciding whether to continue; report those counts and any remaining images clearly.

An `implement` worker's `--gate <names>` still resolves: a pool worktree normally has no `.agy-staff/config.json` of its own (also git-ignored), so the lookup falls back to the main worktree's config when the current one has no `gates`.
