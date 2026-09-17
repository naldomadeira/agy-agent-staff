---
name: pool
description: Use the optional AGY worker pool when independent tasks can safely run in parallel across discovered agy workers. Use when the user asks to inspect workers, dispatch parallel AGY work, or select a specific worker.
argument-hint: '[workers|--worker <id>] [task]'
allowed-tools: Bash(node:*)
---

# agy pool

The pool is opt-in. Use `workers` to inspect available workers, or pass `--worker <id>` when dispatching another persona. Without an explicit pool request, the existing skills continue to use the legacy worker (`AGY_BIN || agy`).

## Discovery and selection

Workers are discovered by the companion in this order: `AGY_BIN`, entries in `AGY_POOL_BINS`, executable candidates `agy`, `agy2`, `agy3` on `PATH`, then optional `.agy-staff/config.json`. A config may name explicit executables:

```json
{"workers":[
  {"id":"primary","bin":"agy"},
  {"id":"secondary","bin":"/path/to/agy2"},
  {"id":"tertiary","bin":"/path/to/agy3"}
]}
```

Aliases and shell functions are invisible to Node; use real `PATH` executables or explicit paths. The default capacity is one active job per worker. Select the available worker with the lowest active-job count, unless a job or conversation already has affinity.

## Safe parallelism

Parallelize only independent tasks with separate ownership and acceptance criteria. Dependent tasks remain sequential. Never parallelize writes in the same worktree automatically: use different worktrees, or obtain explicit authorization for the shared-worktree exception. Keep each job's worker affinity for `continue` and `restart`; an unavailable original worker is reported rather than silently migrated.

Completion means the companion reports the selected worker, affinity, and each job's result; the lead still reviews and integrates all outputs.
