<!-- Generated from skills/lead/references/run-spec.md; run npm run generate:pi. Do not edit here. -->

# Running a whole spec: `plan.json` + `run-spec`

Use this when a spec has several tasks and you would otherwise create the worktrees, dispatch, wait
and branch dependents by hand. You keep the judgement: you write the plan, and you review and merge.
The companion does the bookkeeping.

## Write the plan

```json
{
  "version": 1,
  "name": "marketplace-br",
  "worktree_setup": "pnpm install --frozen-lockfile",
  "max_parallel": 4,
  "defaults": { "class": "feature", "gates": ["typecheck", "lint"] },
  "tasks": [
    { "id": "01-schema", "title": "schema and migrations", "prompt_file": "briefs/01.md", "gates": ["typecheck", "integration"] },
    { "id": "04-screen", "depends_on": ["01-schema"], "steps": [
      { "prompt_file": "briefs/04a-data.md" },
      { "prompt_file": "briefs/04b-ui.md", "gates": ["typecheck", "lint", "i18n"] }
    ] },
    { "id": "09-copy", "class": "mechanical", "prompt": "…" }
  ]
}
```

- `id`: `[A-Za-z0-9_.-]+`. `depends_on`: ids that must finish first. A dependent branches from its
  prerequisite's branch, and when it has several prerequisites their branches are merged into it.
- Per task: `prompt`/`prompt_file` (paths are relative to the plan), or `steps`; `class` (routes with
  `--model auto`) or `model` (explicit), never both; `gates` (names from `.agy-staff/config.json`);
  `mode` (`implement` by default; also `staffer`, `research`, `review`); `timeout`; `worker` (pins an
  account, which turns off moving to another one).
- `defaults` applies to every task. `base` is the commit to start from (HEAD by default).
  `worktree_setup` runs in each new worktree before its first job.

## Slice for Gemini

Gemini delivers well on bounded steps and badly on cross-cutting features. When a task's chain can
land on Gemini (`feature` falls back to `gemini-3.1-pro-high`), split it into `steps`:

- each step touches at most 2–3 files and has its own gates;
- the order follows the dependencies: data or schema first, then logic, then the screen and i18n;
- each step's brief names the exact files and the symbols it builds on.

Steps run one after another in the same worktree and conversation. Each step is committed before the
next one starts.

## Run it

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" run-spec plan.json --dry-run   # waves, no side effects
node "<skill-dir>/../../companion/agy-companion.mjs" run-spec plan.json
node "<skill-dir>/../../companion/agy-companion.mjs" run-wait <run-id> --follow    # Claude Code: run_in_background
```

- Each task gets the worktree `.agy-staff/worktrees/<run>/<task>` and the branch `agy/<run>/<task>`.
  The worktree gets copies of the main checkout's `.env*` files.
- A routed task with no open account waits (`waiting_quota`, retried every 5 minutes) instead of
  failing.
- A failed task blocks the tasks that depend on it.
- `run-status [<run-id>]` shows progress. `run-cancel <run-id>` stops the run and its running jobs.
- The report lists one `git merge --no-ff` per finished task, in dependency order. **Nothing is
  merged for you.** Review each branch's diff and gate output first, then merge the ones you accept.
