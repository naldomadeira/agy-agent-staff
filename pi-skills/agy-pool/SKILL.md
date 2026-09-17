---
name: agy-pool
description: Use the optional AGY worker pool when independent tasks can safely run in parallel across discovered agy workers. Use when the user asks to inspect workers, dispatch parallel AGY work, or select a specific worker.
---

<!-- Generated from skills/pool/SKILL.md; run npm run generate:pi. Do not edit here. -->

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

## Host compatibility

When this skill or its referenced instructions require a tool that the current environment does not provide, use available capabilities to achieve an equivalent result. Adapt only the tool-specific execution method; preserve the task goal, authorization requirements, explicit confirmation steps, result delivery, and stopping conditions.

If an equivalent result cannot be achieved, or you cannot establish that an alternative is equivalent, explain the missing capability and its impact, and ask the user for help. Do not silently skip requirements or bypass the environment's restrictions.
