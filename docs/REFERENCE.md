# agy-staff — Full reference

Back to the [README](../README.md). See the [Portuguese reference](REFERENCE.pt-BR.md).

## Modes and defaults

| Persona (skill) | Companion mode | What it is | Default model | Profile | Execution |
|---|---|---|---|---|---|
| `ask` | `ask` | Cheap zero-tool one-shot Q&A (~3s); doubles as the post-install smoke test | `gemini-3.8-flash-low` | restricted (prompt-only) | synchronous — the answer comes back in the same call |
| `staffer` | `staffer` | General-purpose delegation without a specialist role or fixed output format; shared operational guardrails still apply | `gemini-3.8-flash-medium` | unrestricted | background job — returns a job id |
| `researcher` | `research` | Deep survey with cited sources and explicit unverified-claims marking | `gemini-3.8-flash-high` | unrestricted | background job — returns a job id |
| `reviewer` | `review` | Second-opinion verifier, two flavors routed by subject: code review (severity-ranked findings with `file:line` refs) and general review (multi-angle challenge of a plan, design, or decision) | `gemini-3.8-flash-medium` | unrestricted | background job — returns a job id |
| `implementer` | `implement` | Well-scoped coding task; agy edits the working tree and can perform explicitly requested Git delivery | `gemini-3.8-flash-high` | unrestricted | background job — returns a job id |
| `pool` | `workers` | Opt-in worker inspection: list discovered AGY workers, or pass `--worker <id>` when dispatching another persona for explicit selection | — | n/a — no agy invocation | synchronous — prints the worker table in the same call |

`lead` provides task orchestration guidance for the current agent, reusing the existing companion modes without adding a mode of its own; invoke `/agy:lead` in Claude Code, `$agy:lead` in Codex, or `/skill:agy-lead` in Pi.

Execution style is fixed per mode and cannot be overridden by a flag. `continue` inherits the resolved mode's style (continuing an `ask` stays synchronous; continuing the others returns a job id).

Claude Code, Codex, and Pi surface the same personas, backed by one companion script (`companion/agy-companion.mjs`, Node stdlib only) and shared prompt templates (`templates/`). Invocation tokens: `/agy:<persona>` on Claude Code, `$agy:<persona>` on Codex, and `/skill:agy-<persona>` on Pi. Pi's manifest exposes only `pi-skills/`, generated mechanically from canonical `skills/` via `npm run generate:pi`. Generated skills use `agy-` prefixes, rewrite sibling references, and append `templates/harness-compatibility.md` (directing the host to adapt missing tools to equivalent methods without dropping requirements, or ask for help). Job management (`wait`/`status`/`result`/`cancel`/`continue`/`setup`) lives in `jobs` (`agy-jobs` on Pi) plus the companion CLI — ask for it in natural language ("is the agy job done?").

## Optional worker pool

The normal path remains a single worker resolved as `AGY_BIN || agy`. The opt-in `pool` skill exposes `workers` for inspection and `--worker <id>` for explicit selection; existing skills remain unchanged otherwise. Discovery checks `AGY_BIN`, `AGY_POOL_BINS`, `agy`/`agy2`/`agy3` on `PATH`, then optional `.agy-staff/config.json`. Node cannot discover shell aliases or functions; use executable wrappers or explicit paths. Jobs record worker id, executable, and version when available; `continue` and `restart` preserve affinity, while legacy jobs use `AGY_BIN || agy`. Dispatch output, list status, observe snapshots, and diagnostics include worker identity so every host can present the external-worker context consistently without changing delivered-result text. The default capacity is one active job per worker. Independent tasks may run in parallel; dependent tasks stay sequential, and parallel writes require separate worktrees or explicit authorization. `workers` reports id, executable, availability, version, and active-job count.

## The two-profile permission model

Every mode runs under exactly one of two profiles. **Every tool-using mode defaults to `unrestricted`**, so the plugin works out of the box with no allowlist and no setup; `--restricted` is the opt-in hardening flag. `--restricted`/`--unrestricted` override per call (`ask` is tool-free and forced restricted — it ignores both, and passing `--unrestricted` to it prints a note and proceeds restricted).

The profile for a run is resolved in this order: CLI flag > recorded conversation profile (when continuing) > per-repo policy ([`setup --restrict`](#per-repo-policy-setup---restrict)) > built-in default.

| | **unrestricted** (default: staffer, research, review, implement) | **restricted** (opt-in hardening; forced for ask) |
|---|---|---|
| agy invocation | `--dangerously-skip-permissions` | no permission skipping — fail-closed, every unlisted tool call is auto-denied |
| What agy can do | anything, including editing files and running commands | workspace file reads plus `git gh cat head ls grep find rg wc`, with five targeted git/gh deny prefixes (AGY permission rules) |
| Safety net | prompt-level guardrails (default-deny on irreversible/costly actions) + the tiered git guards below | agy stays inside agy's own permission enforcement |
| Typical use | the normal path: Q&A, surveys, reviews, coding tasks | hardened runs: untrusted input, or machines where skipping agy's permission prompts is unacceptable |

`--restricted` and `--unrestricted` are mutually exclusive; passing both is an error. Two things to know before hardening: `--restricted` is only useful once setup's allowlist is installed (otherwise agy denies its own evidence gathering and the run comes back empty), and some native tools ignore allow-rules in headless mode entirely — a restricted run can be thinner than an unrestricted one.

### Tiered git guards

The guards apply to **unrestricted runs only** and differ by mode:

| Mode | Inside a git repo | Not a git repo |
|---|---|---|
| `implement` | dirty workspaces are allowed. If the repo already has changes, the companion adds a short pre-run status summary to agy's prompt so it knows which paths were already touched and must treat them as user-owned work. The summary is capped; agy should run `git status --porcelain` and inspect diffs when ownership is unclear. Afterward the companion reports whether the workspace is clean, changed, or still dirty | warns that agy's edits cannot be reviewed or rolled back via git, then proceeds |
| `research`, `review` | never blocked, no clean-tree check. The worker snapshots `git status --porcelain` before the run and compares afterwards; if agy introduced changes, the result carries a warning listing the delta plus a rollback hint | nothing to compare — silent |
| `staffer` | same snapshot/report as research/review, but neutrally worded: a general task may legitimately edit files, so the delta is information for the caller ("verify the task asked for it"), not an accusation | nothing to compare — silent |

Silence is the normal case for `research`/`review`: the delta warning shows up only when agy touched the working tree, which the templates tell it not to do.

### Prompt-level guardrails: default-deny, prompt-opens

The `staffer`, `research`, `review` and `implement` templates deny irreversible or costly side effects **by default**:

- no commits, pushes, PR writes or history rewrites unless the task explicitly asks for that exact Git delivery;
- no deleting files outside the workspace;
- no side-effectful network calls;
- no commands that burn paid API quota or tokens (e.g. an e2e suite that bills a live API).

Scratch scripts go in a temp dir, and everything the run does inside the workspace stays git-revertible.

**The default is closed, not locked.** If your request explicitly authorizes one of those operations ("commit this", "open a draft PR", "run the e2e tests", "call the staging API"), agy does exactly what was authorized and reports what it ran — so pass such authorizations through verbatim when you delegate. `review` in particular may run read-only commands, scratch scripts and tests to verify a finding; what it must not do is modify tracked files, commit or push.

### Decision discipline and pre-dispatch gate refusal (`implement` only)

The `implement` template carries a `## Decision discipline` section: report a briefing fact contradicted by the code (with `file:line` evidence) instead of working around it, prefer an existing project rule over an invented "robust" fallback, name who reaches a new branch/code path in production, and respect the run's own time budget — no full build/test/lint baseline unless the briefing explicitly authorizes it. The section states the resolved job timeout in words (e.g. "You have about 60 minutes.").

Before dispatch, the companion also scans the task text for a **positive order** to run a long gate itself — `pnpm|npm|yarn|bun build|test|check|lint|typecheck`, `pytest`, `cargo test`/`build`, `go test`, a bare `tsc`, or `next build` — inside a fenced code block, a list item, or an imperative sentence ("run", "execute", "rode", "corra", "confirm with", "verify with", "then run"). A negation ("don't run", "não rode", "sem rodar") or descriptive prose that merely names the command ("the CI runs pnpm build") is not an order and is left alone. On a match the companion refuses before any job is created and before agy is ever invoked (exit 1), quoting the offending line. Two ways out: remove the order from the briefing, or pass `--allow-gate` to authorize the worker to run it. This check runs on every source of task text (`--prompt`, `--prompt-file`, `--stdin`) and on `continue`'s and `restart`'s re-read task text; `--allow-gate` on the original run is recorded in the job spec, so a bare `restart` of an authorized job inherits the authorization instead of asking again.

### Declared gates: companion-run verification (`implement`/`continue`/`restart`)

Where `--allow-gate` authorizes the *worker* to run a gate itself (inside its own time budget), declared gates have the *companion* run one or more commands **after** the worker reports done — never eating into the agent's own budget, and never something the worker has to remember to do. Two ways to declare a gate for a single run:

- `--gate <names>` — a comma list of names (`--gate check` or `--gate check,build`; a repeated `--gate` is not supported by the flag parser, so the comma form is what actually works) looked up in `.agy-staff/config.json`'s `gates` map: `{ "gates": { "check": "pnpm check", "build": "pnpm build" } }`. Each value must be a non-empty, single-line command string. An unknown name, or no `gates` configured at all, refuses **before dispatch** (exit 1, no job, no agy call), listing the available names and the config path it looked at.
- `--gate-cmd "<cmd>"` — one ad hoc single-line command, needing no config entry; it runs after any named `--gate` commands, in the order given.
- `--gate-timeout <dur>` — each gate's own time budget, default 15m, entirely separate from the agent's own `--timeout`.

**Config lookup and the worktree fallback.** Named gates are read from the current workspace's own `.agy-staff/config.json` first. A linked `git worktree` normally has no config of its own (it is git-ignored, so `git worktree add` never copies it), so when the current workspace's config carries no `gates`, the lookup falls back to the **main worktree's** config (`git rev-parse --git-common-dir` → its parent). The fallback applies to `gates` only — profile policy (`setup --restrict`) is unaffected, and a worktree keeps its own profile choice.

**When gates run.** Only for the two outcomes that mean the worker actually finished its work: `done`, and `verification_incomplete` (see below — a passing gate is stronger evidence than the worker's own pending claim). Gates never run for `quota_exhausted`, `error`, a timeout (`response_timeout`/`hard_timeout`), `canceled`, `implement_no_changes`, or `implement_uncommitted` — none of those mean the worker delivered anything to verify yet. While a gate runs, the job's own `status` stays `running` (nothing new to poll for), but `phase: "verifying"` and `verifying_gate: "<name>"` appear in `status <id>`'s JSON, in `observe`'s running snapshot, and as a one-line announcement on `wait --follow`'s stderr each time the running gate changes.

**Execution.** Gates run in the given order and stop at the first failure or timeout — a later gate never starts. Each runs with `shell: true` (so a config string like `pnpm check` needs no argv splitting), in the job's own workspace, with the calling environment, in its own process group — killed as a whole tree (the same cross-platform helpers agy's own process uses: POSIX process groups, Windows via a CIM process-table query plus `taskkill /PID <pid> /F`, never `/T`) on its own `--gate-timeout` or on job cancel (the existing cancel-polling mechanism extends naturally to this phase, so a cancel requested while a gate is running still ends the job `canceled` and kills the gate). Output (stdout+stderr merged) is capped at the last ~8 KiB per gate.

**Result.** Every gate's outcome is recorded on the job (`gate_results`: an array of `{name, command, exit, timed_out, duration_ms}`) and reported in a `## Companion verification` section — name, command, pass/fail/timeout verdict, duration, and the bounded output tail — placed **before** `## Partial work`/the JSON diagnostics, if either is present.

- **All declared gates pass:** `done` stays `done`. `verification_incomplete` becomes `done` too — a passing declared gate outweighs the worker's own "still pending" sentence — with a one-line note in the report that the pending claim was superseded by the gate.
- **Any gate fails or times out:** the job ends `attention`, reason `gate_failed` (exit 5), with the worker's response and diff preserved and a `## Partial work` section appended (same shape as every other non-`done` terminal report — see below).

**Inheritance.** `gates` and `gate_timeout` are persisted on the job spec and record; `continue` and `restart` of that job inherit them automatically — no need to repeat `--gate` on every follow-up. Passing a new `--gate`/`--gate-cmd` on the continuation replaces the inherited list outright (looked up fresh against the current config), rather than adding to it. `--allow-gate`'s own pre-dispatch order refusal (above) is unaffected by any of this: it only ever scans the task text, never the declared gates, so declaring gates never trips it.

### Reviewing untrusted content

Under `unrestricted`, prompt injection is code execution. If you point `review` or `research` at content written by someone you do not trust — a PR from a stranger, a vendored dependency, an issue body full of instructions — text inside that content can tell agy to run arbitrary commands, and an unrestricted agy will run them.

Two mitigations, neither of them the default:

- **`--restricted`** — agy's own permission enforcement applies, so unlisted tools are auto-denied. Caveats as above: it needs setup's allowlist to be useful, the allowlist is prefix-matched rather than read-only, and native tools that ignore allow-rules may fail-close and thin out the review. It shrinks the blast radius; it is not a sandbox.
- **An isolated checkout** — review it in a throwaway clone, container or VM with no credentials worth stealing.

The default optimizes for the common case: your own code on your own machine. Untrusted input is the case where you should reach for one of the two.

### Optional hardening (setup)

`setup` is an optional companion management command handled by the `jobs` skill. Ask your host agent to configure agy's restricted mode when you need it. The command checks the `agy` binary and previews **evidence-gathering allow/deny rules** for `~/.gemini/antigravity-cli/settings.json`. Only after explicit confirmation does it back up the file and append the configuration. Default unrestricted tasks and tool-free ask do not depend on setup.

Two properties of these rules you should know before applying them:

- **It allows broad commands with a small deny list.** Setup keeps `command(git)` / `command(gh)` and adds deny prefixes for `git push`, `git reset --hard`, `git clean`, `gh pr merge` and `gh release delete`. [AGY evaluates deny before ask before allow](https://www.antigravity.google/docs/cli/permissions/); the companion only installs configuration, with no command parser or per-task allowlist. Existing allow/deny/ask rules are preserved. Applying setup to an earlier narrow configuration adds the broad grants shown in its dry run. These prefixes prevent common mistakes, not all irreversible actions: other argument arrangements, aliases, scripts, APIs and other allowed commands are not comprehensively covered. The setup is not a read-only boundary. A denied operation stays denied even if requested in the task; change the settings explicitly when needed.
- **It is global.** The file is `~/.gemini/antigravity-cli/settings.json`, so the rules apply to every `agy` run on the machine, not only to agy-staff jobs. That is the intended product path ("set up once, use everywhere").

Web search is not in the allowlist and does not need to be: on the tested agy (v1.1.13) `search_web` runs headless without an allow rule.

### Per-repo policy (`setup --restrict`)

If you want some modes to run restricted every time *in a particular repository* — say, a repo where you routinely review strangers' PRs — you can declare that once instead of remembering the flag:

```bash
setup --restrict review,research   # these modes default to restricted in this repo
setup --restrict none              # back to the built-in defaults
```

The policy is written to `<repo>/.agy-staff/config.json` and applied automatically (the run prints a note that the profile came from the project policy). Three properties:

- **Precedence.** Explicit `--restricted`/`--unrestricted` flags override the policy. Continuations without an explicit override inherit their recorded profile; new tasks use the repository policy or built-in defaults. `ask` is tool-free and always restricted.
- **Scope.** `.agy-staff/` is normally git-ignored, so the policy is a personal, per-machine preference — it is not shared with your team through the repo.
- **What it is not.** This is a run policy for consistency and accident prevention, not a security boundary: it feeds the same `--restricted` machinery, with the same caveats (needs the global allowlist, prefix-matched, some tools ignore allow-rules headless). For genuinely untrusted input, use an isolated checkout.

Note the two files are different things: the **allow/deny rules** (what a restricted agy may execute) is global by agy's design; the **policy** (which modes default to restricted) is per-repo by ours.

### Advanced: project-scoped permissions

If a machine-wide allowlist is too broad for you, agy also supports project-scoped permission rules (it treats them as highest priority) tied to its `--project` system. That would let you grant the evidence rules only inside the repos where you delegate.

Caveat, stated plainly: **the exact project-settings file path is undocumented and unverified against the current agy release**, so agy-staff does not write it and this document does not guess it. If you want project scoping, check `agy` interactively for where it reads project-level rules from, and configure it yourself. Until then, either accept the global scope or skip setup entirely — the default unrestricted profile bypasses agy's permission system rather than depending on it, and `ask` needs no allowlist at all; skipping setup only costs you the ability to harden a run with `--restricted`.

## Flags (uniform across modes)

| Flag | Meaning |
|---|---|
| `--conversation <id>` | resume a specific agy conversation |
| `--continue` | reuse this mode's last conversation id from state |
| `--model <id>` | explicit agy model (see `agy models`). Ids are effort-suffixed (`gemini-3.8-flash-low`); the companion normalizes bare families (`gemini-3.8-flash` + `--effort`) and the aliases `flash`/`pro`, and rejects unknown ids pre-flight |
| `--effort low\|medium\|high` | shorthand for `gemini-3.8-flash-<effort>` |
| `--restricted` / `--unrestricted` | permission profile override (ignored by `ask`). `unrestricted` is the default for `staffer`/`research`/`review`/`implement`, so `--restricted` is the flag you actually reach for |
| `--restrict <modes\|none>` | (setup) per-repo policy: the listed modes default to restricted in this repository; `none` clears it. See [Per-repo policy](#per-repo-policy-setup---restrict) |
| `--worker <id>` | (opt-in worker pool) select a specific discovered worker by id for this run, or `auto` for automatic selection by load. Valid on `staffer`/`research`/`review`/`implement`/`ask`, `continue`, and `restart`; rejected with an error on `status`, `wait`, `result`, `cancel`, `observe`, `setup`, and `workers`, which never dispatch to a worker. See [Optional worker pool](#optional-worker-pool) |
| `--json` | (review) schema-enforced JSON findings; default is free-form markdown. Meant for the code-review flavor; valid on `review` and on `continue` (it only takes effect if the resumed conversation's mode is `review`), rejected with an error elsewhere |
| `--timeout <dur>` | Background worker hard limit (default 60m, maximum 120m). AGY receives the selected response timeout. For synchronous ask: AGY response timeout, default 2m. Also valid on `wait` (its own soft poll timeout, default 100s) and `restart` (a fresh budget for the relaunch). Rejected together with `wait`'s `--until-done` — the two set the same thing two incompatible ways |
| `--follow` | (`wait` only) tail the job's step events to stderr while polling — `▶`/`✓`/`✗` per step, with its tool name and a short parameter hint. Wait's stdout is unchanged either way; without `--follow`, wait stays silent as before. Only steps that happen after this `wait` call are shown, never history from before it started. Compatible with `--until-done`. Also announces each declared gate as it starts running (`verifying: running gate <name>`), since a gate's own progress is not part of the job's agy event stream |
| `--until-done` | (`wait` only) block until the job reaches a terminal state, with no timeout ceiling — no `--timeout` value to pick, and none applies. Mutually exclusive with `--timeout` (usage error, exit 1). Uses the same poll cadence and crash detection as an ordinary wait, so a worker that dies mid-run still ends the wait as `crashed` rather than hanging. See [Wait, exit 2, and `--until-done`](#wait-exit-2-and---until-done) |
| `--allow-gate` | (`implement`/`continue`/`restart`) authorizes the worker to run a long gate command (build/test/check/lint) the briefing orders — without it, a detected order refuses the run pre-dispatch. See [Decision discipline and pre-dispatch gate refusal](#decision-discipline-and-pre-dispatch-gate-refusal-implement-only) |
| `--gate <names>` | (`implement`/`continue`/`restart`) comma list of named gates (`.agy-staff/config.json`'s `gates` map) the COMPANION runs after the worker finishes. Unknown name, or none configured, refuses pre-dispatch. See [Declared gates](#declared-gates-companion-run-verification-implementcontinuerestart) |
| `--gate-cmd <cmd>` | (`implement`/`continue`/`restart`) one ad hoc single-line command the companion runs after any named `--gate` commands; rejects a multi-line value |
| `--gate-timeout <dur>` | (`implement`/`continue`/`restart`) each gate's own time budget, default 15m — separate from `--timeout` (the agent's own budget) |
| `--prompt <text>` | the task text as one argument. Quote it; whatever is inside is opaque |
| `--prompt-file <path>` | read the task text from a file — for long prompts, instead of shell quoting |
| `--stdin` | read the task text from stdin. Exactly one task source per call: `--prompt`, `--prompt-file`, or `--stdin` |

That table, together with the persona table above, is the whole public surface. There is no flag for execution style — see the modes table above.

**Flag scope.** Every flag above is valid only on the subcommands that actually read it; passing it elsewhere is rejected before agy is ever invoked, with an error naming the flag, the subcommand, and where it is valid (`--worker`'s row above shows the pattern). Two scopes worth calling out because they are narrower than "every run command":
- `restart` only reads `--worker` and `--timeout` from its own invocation — it replays the stored job's original model, profile, and task, so `--model`/`--effort`/`--restricted`/`--unrestricted`/`--conversation`/`--job` are rejected there. `--prompt`/`--prompt-file`/`--stdin` are the one exception: accepted for backward compatibility, but ignored, since `restart` always rebuilds the prompt from the stored spec.
- `--continue` (the boolean flag) is rejected on the `continue` subcommand itself — `continue` has already resolved which conversation to resume before that flag would ever be consulted, so it only does something on a direct run command (`research --continue`).

## Task text

This section is about the **companion CLI**, not about how you invoke a persona. You type your task as plain text after the slash command (`/agy:reviewer Review PR #730`); the skill reads it and composes the `--prompt` call below. You never type `--prompt` yourself.

Every run command (`staffer`, `research`, `review`, `implement`, `ask`, `continue`) takes its task from **exactly one** of three sources:

```
ask       --prompt "what does git diff --check verify?"
research  --prompt-file /tmp/task.md
review    --stdin < /tmp/task.md
```

Giving two at once is an error (`task text given more than one way (…) — use exactly one`), and giving none is an error too.

**The opacity guarantee.** The companion parses the shell's argv once, exactly as the shell delivered it: it re-splits no argument, interprets no quotes, and inspects no byte of a task value. Your task reaches agy byte for byte — whitespace, quotes and newlines included — and flag-like text inside it (`--check`, `--json`, `--timeout`, an unknown `--whatever`) is prompt content, never a companion option. The same holds for `--prompt-file` and `--stdin` contents.

`--prompt` accepts a value that starts with `--` when it is a real sentence, meaning one that contains whitespace: `ask --prompt "--check means what?"` works. A flag-shaped value with no whitespace reads as a forgotten value and is rejected. `--` itself carries no special meaning; it parses as an unknown flag.

Value flags (`--conversation`, `--model`, `--effort`, `--timeout`, `--restrict`, `--prompt`, `--prompt-file`) require a value. A missing one, an empty one, and — apart from the `--prompt` sentences above — a flag-shaped one are all errors, so `--model ""` is an error.

Each flag is its own argument. Flags packed into a single quoted string (`review "--restricted Review PR #730"`) are an error that names the fix rather than a guess at where the flags end and the task begins.

## Review is prompt-based

`review` takes a subject description and gathers the evidence itself with the tools it has (`gh pr view`/`gh pr diff` for PRs, `git diff`/`git log` for refs and the working tree, reading files for patches). There is no flag that hands it a diff; describe the subject in the prompt instead:

```
review --prompt "Review PR #730"
review --prompt "Review the current working tree"
review --prompt "Review changes against master"
review --prompt "Review the patch at /tmp/change.patch"
```

An empty task string is an error — `review` needs a subject. If the subject is ambiguous, agy is instructed to report the ambiguity rather than guess at what you meant.

The review template itself is a neutral skeleton (reviewer stance, evidence discipline, guardrails). Everything flavor-specific — the evidence-gathering menu, review axes, severity ranking, and output format for code reviews; the multi-angle challenge framing for plan/decision reviews — travels in the task string, composed by the `reviewer` skill from `skills/reviewer/references/{code-review,general-review}.md`.

## State and background jobs

**Output split.** stdout carries the result and any guard warning about the working tree; the `[agy-staff]` telemetry line (mode, profile, model, duration, tokens, conversation id) goes to stderr, and for background jobs into `jobs/<id>.log`. Telemetry is metadata for the calling agent — it is not part of the deliverable and is not stored in `jobs/<id>.result.md`.

**Usage summary.** When AGY's own result carries token/duration/turn counts, a terminal job persists them on the job record (`usage` — `input_tokens`/`output_tokens`/`thinking_tokens`/`cache_read_tokens`, whichever were reported —, `duration_seconds`, `num_turns`), and `wait`/`result` render one compact line right under the delivered `# Job <id> (<mode>, <status>) — AGY worker: ...` header, e.g. `Usage: in 1,728,044 · out 12,301 · think 40,112 · cache 1,200,000 · 19m37s · 42 turns`. Missing parts are omitted, and the whole line is omitted for a job with no known telemetry at all (older records, or a terminal state whose payload never carried it — e.g. a crash before any result). The same fields also appear in `status <id>`'s job JSON and `observe`'s terminal snapshot (`usage`, `duration_seconds`, `num_turns`). Foreground `ask` already prints its own telemetry line on stderr and is unaffected.

`staffer`, `research`, `review` and `implement` return stable job handles promptly. Default flow: prepare the prompt, dispatch, wait for the final result, then validate as needed. While running, do not proactively observe, read logs or inspect intermediate artifacts, including for routine updates. Observe progress only when the user explicitly asks; diagnose after a failure or a result requiring intervention. Each detached worker continuously drains AGY `stream-json`, even with no observers. There is no additional daemon or scheduler.

- `wait [id] [--timeout <dur>] [--follow] [--until-done]` waits for completion or its wait timeout. Completion delivers the existing result; soft expiry returns a JSON observation snapshot directly and leaves execution running. Ordinary tool activity does not end the wait early. Bare wait defaults to 100s; skills recommend an explicit 10m wait. On exit 2, wait again for the same job without extra progress checks; the returned snapshot does not require intervention. `--follow` streams the job's steps to stderr while it waits — useful for a `wait` collected in a background shell, which otherwise shows nothing until it returns; wait stays silent by default, and stdout is unaffected either way. `--until-done` removes the timeout ceiling entirely and blocks until the job reaches a terminal state; see below for exit 2's guarantee and when to reach for `--until-done` instead.

#### Wait, exit 2, and `--until-done`

**Exit 2 always means the job is still alive and nothing was delivered.** stdout on a soft expiry is pure JSON (an observation snapshot, `"status":"running"` among its fields) — a caller that does `JSON.parse(stdout)` gets exactly that, unchanged, on every wait call whether it expires or delivers. Because of that, wait also writes one line to **stderr only** on a soft expiry: `STILL RUNNING — job <id>, <n>s elapsed. Exit 2: not delivered; call wait again.` (`<n>` is whole seconds since the job started). It never appears for a terminal job, and `observe`/`status` never print it either — only `wait`'s own soft-expiry path does, since only `wait` frames a running job as "you need to call again."

That line exists because stdout alone is not a safe signal: a real orchestrator piped `wait ... | tail`, the exit code was lost in the pipeline, and the plain JSON on stdout was read as a delivered result. **Never pipe `wait` without capturing its exit code** — `wait ... | tail` (or any pipe) loses it under a shell's default `pipefail`-off behavior; use `set -o pipefail` and check `${PIPESTATUS[0]}` (bash) or an equivalent, or avoid piping wait's output at all and read its file/variable capture instead.

`--until-done` is the alternative to re-arming a finite `--timeout` yourself: it blocks with no ceiling, polling at the same cadence an ordinary wait uses, and still detects a dead worker exactly as wait already does (a missing pid with no stored result ends the wait `crashed`, never hangs indefinitely). Where to use it depends on the host:
- **Hosts with background-job notifications (Claude Code's `run_in_background`)** — launch `wait <id> --until-done` as a background command and let the host's own completion notification wake the session; nothing has to poll or re-arm.
- **Hosts without that (Codex)** — a foreground `--until-done` call would pin the whole session with no way to interrupt or re-check; keep the existing pattern instead: `wait --timeout 10m`, and re-arm (call it again) on each exit 2.
- `observe [id]` always returns bounded JSON (at most 8 KiB): current progress while running; terminal status, result path/availability and collection instructions when finished. Error/canceled/crashed states include bounded diagnostic and recovery metadata, never the full report. It reads job state independently of any wait, without resetting deadlines or consuming another observer’s history.
- `status [id]` lists jobs or shows state and a bounded diagnostic log tail. `result [id]` reprints stored output.
- `cancel <id>` requests cancellation and returns success after the worker stores its report and publishes `canceled`. It preserves crash diagnostics and never signals an unverified stored PID. Legacy jobs without a cancellation channel fail explicitly. A cancellation error requires checking the job and logs; it does not establish that execution stopped. Interrupting a wait does not cancel the worker.
- `continue --job <id> --prompt "..."` resumes the known conversation with its original mode/model/profile and a linked new job. `continue --conversation <id>` also resolves configuration from that known conversation, never an unrelated last mode. If the resolved job ended `quota_exhausted` and the new run would reuse the same model, `continue` prints one warning to stderr before dispatching — it never blocks — naming the job, model and (when known) the reset window; see below.
- `restart <id>` explicitly relaunches the original task/configuration without a conversation, linked to the original job. Inspect partial workspace changes with `git status` and `git diff` before either recovery action. New runs regenerate workspace context. Legacy specifications label historical snapshots and append current context. `restart` has no `--model` of its own, so it always reuses the original job's model; it gets the same quota-window warning as `continue` when that job ended `quota_exhausted`.

Continuation/restart can be invoked from any directory within the same worktree and execute in the original cwd. Generic `continue` rejects unrecorded conversation IDs without launching AGY or searching other worktrees. Continuing a conversation whose job is still running (generic `continue`, or a mode's `--continue`/`--conversation`) is refused with exit 1 and the job ID and status; the follow-up is not queued, and the caller waits or cancels first. For continuation, explicit model/profile flags override the recorded values; otherwise those values are inherited. A new recovery budget defaults to 60m unless overridden.

Exit codes for wait/observe/status-with-id: **0** done, **2** running, **3** error/crashed, **4** canceled, **5** attention (resumable timeout, `implement_no_changes`, `implement_uncommitted`, `verification_incomplete`, or `gate_failed` — see below), **6** quota_exhausted (see below), **1** command error. `result` also exits 5 for attention; its legacy exit behavior for other states — including `quota_exhausted` — is unchanged: `result` exits **0** for every non-attention terminal status, so it never invents a 6. Observe exit 0 means the job is finished, not that its report was delivered. Collect an already pending wait session; otherwise call result. Wait/result keep their existing full-result contract. A `done` status means invocation and response delivery ended, not that the task was accepted. Successful calls with warnings include an 8 KiB log tail on stderr and the full-log path; native status and exit code are recorded in that log. The orchestrator assesses completion and inspects further only when needed. Intermediate tool errors are retained internally and are not automatically promoted to warnings in successful delivery. A running snapshot contains timestamps, elapsed time, the latest five tool activities with input/output excerpts and the latest response text merged by step. Unknown states, incomplete text and truncation are labeled; a tool finishing is not proof of useful progress. UTF-8 JSON budgets are 1 KiB per activity, 2 KiB for text and 8 KiB total. For a user-requested progress answer or diagnosis after failure/required intervention, read bounded `details` excerpts only if the returned information is insufficient.

**Quota exhaustion (`quota_exhausted`, exit 6).** A 429 from AGY itself (`RESOURCE_EXHAUSTED`, `code 429`/`429`, `quota exceeded`, `Individual quota reached`, or `rate limit` in AGY's own status/error field — never a mention of those words in the response body, so a task that merely discusses a 429 in someone else's bug report is not misclassified) ends the job `quota_exhausted` instead of `error`, and persists `model` and `resets_in` — the literal duration AGY printed after "Resets in" (e.g. `4h1m13s`), never a computed date, and omitted rather than invented when AGY didn't report one. A tool-level 429 the agent already recovered from (final status `SUCCESS`) stays `done`; timeouts, network errors, 401/403, an invalid model id, and a missing/unparseable result stay their own existing reasons — never `quota_exhausted`. The report — `result.md`, and what `wait`/`result` print — starts with `Quota exhausted: model <model>, resets in <resets_in>.` (or `(reset time not reported)` when unknown), followed by a recovery line: switch to another worker or model with headroom (`workers`) or wait for the reset — **never** `continue` on the same model before it. `resets_in` and the same recovery guidance surface in `diagnosticPacket`, `observe`'s terminal snapshot, `status <id>`'s job JSON, `wait`, and `result`. Exit codes follow each command's existing convention (`wait`/`status <id>`/`observe`: 6; sync `ask`: 6; `result`: 0, same as every other non-attention terminal status). Job records written before this status existed simply have no `resets_in` field and render normally.

**Continuing into a quota window.** `continue --job <id>` (or a bare/`--conversation` `continue` that resolves to the same job) and `restart <id>` check, before dispatching, whether the job they are resuming ended `quota_exhausted` on the same model the new run will use. If so they print one line to stderr — `agy-staff warning: job <id> ended quota_exhausted on model <model> (resets in <resets_in> from <finished time>); continuing on the same model will likely fail again — pass --model <other> or choose another worker (see workers).` — and still dispatch; this never blocks the call. When the reset window can be computed (a parseable `resets_in` and a `finished_at`) and has clearly passed, there is no warning. When it can't be computed (missing or unparseable `resets_in`, or no `finished_at`), the warning still fires, just without the `(resets in ...)` clause — same model right after a quota failure is reason enough. An explicit `--model` that differs from the job's model silences it (`restart` has no `--model` of its own, so it always reuses the job's model and always gets the check). Any status other than `quota_exhausted` is silent.

**Pending verification (`verification_incomplete`, exit 5).** A run that reports SUCCESS while its own text still admits a verification is in flight — "I have started `pnpm build` and am awaiting its completion", "waiting for the tests to finish", "the build is still running", PT "aguardando a conclusão do build", "à espera do build" — ends `attention` instead of `done`: a broken build has shipped this way in production, once from a sentence that was the *first* line of the report, so the check scans the whole response (capped at ~64 KiB; a longer report is scanned in head and tail windows), not just the tail. Patterns are conservative and tied to verification/build/test/background-process wording in English and Portuguese (pt-BR and pt-PT) — a generic "waiting" in unrelated prose (a design decision, "à espera de aprovação", a dev server left running) never triggers it. A pending mention followed later in the same report by explicit completion evidence ("build passed", "tests passed", "✓ Compiled successfully", "concluído com sucesso", "o build passou", …) is cleared and the job stays `done`. A mention inside a fenced code block or a blockquote line (`> ...`) is treated as a quotation, not the worker's own claim, and is ignored; nothing else is exempted, so past-tense narration is still flagged — the point of this check is precisely to not miss a report shaped like the incident above. It applies to the modes that deliver work — `implement` and `staffer` — regardless of `--restricted`/`--unrestricted`, since the claim itself is the signal. `research` and `review` are exempt because they routinely describe processes that are not theirs, and `ask` has no tools. Precedence: `verification_incomplete` never overrides `implement_no_changes`, `implement_uncommitted`, `quota_exhausted`, cancellation, hard timeout, or a plain error — a true no-op or an undelivered commit is the more fundamental problem and keeps its own reason even when the response also reads as pending. The report is prefixed with `Job needs attention: the worker declared a verification still pending — "<quoted evidence>". Run the pending verification yourself before accepting this work.`, followed by the worker's full original response (diff/conversation info preserved exactly as a `done` job would render it). The job record carries `reason: "verification_incomplete"` and `pending_evidence` (the quoted sentence), both surfaced in `status <id>`'s job JSON and `observe`'s terminal snapshot; `diagnosticPacket`'s recovery note points at running the pending verification, not at retrying.

**Partial work inventory (`## Partial work`).** Every non-`done` terminal report (`error`, `quota_exhausted`, `canceled`, `attention` from a hard/response timeout, `verification_incomplete`, `implement_uncommitted`, `gate_failed`) appends a deterministic `## Partial work` section after the message and before the JSON diagnostic packet: terminal state; `HEAD: <before> → <after> (moved: yes/no)` (or "unknown (not a git repo)"); dirty paths after the run (capped at 50, each marked `untracked`, `staged`, `new this run`, or — for a path already dirty before the run — `status changed` or `content change not tracked`, since this compares porcelain status, not file contents); commits made by the run (`git log --oneline`, capped at 20) when HEAD moved; the exact `git status --short; git diff; git diff --cached` inspect command (plus `git log <before>..<after>` when HEAD moved); a `Verification: not confirmed` line (never treat this work as accepted); and an inventory-completeness note whenever something is missing (no git, no before-snapshot, HEAD moved into a clean tree so `git diff` shows nothing, or a truncated list). `verification_incomplete` additionally notes that the agent reported finishing — the only unconfirmed step is verification. `implement_no_changes` (a true no-op) gets no section: there is nothing to inventory. A crashed job discovered later with no recorded snapshot gets "Inventory unavailable: worker exited before recording the workspace" plus the inspect commands, never invented data. The section is built from the same porcelain/HEAD snapshots the workspace guards already take — no separate snapshot mechanism, and it never copies file contents or environment values.

The worker passes the selected timeout to AGY and independently enforces an overall limit including initialization: default 60m, configurable up to 120m with launch `--timeout`. If response text arrived before hard-expiry cleanup, it is delivered with a warning; an empty or absent response needs attention when a conversation is known, otherwise it remains a failure. Wait/observe cannot renew it. Without a response, hard expiry produces `reason=hard_timeout`; an explicit TIMEOUT status or AGY's exact `ERROR` plus `timeout waiting for response` produces `reason=response_timeout`. A known conversation yields `status=attention` and exit 5; without one the status is `error`. Reports retain the last snapshot, logs, original configuration and pre-run/current workspace status (porcelain cannot detect content changes to an already dirty file; inspect diffs). Recovery metadata includes `requires_user_confirmation`, `suggested_timeout` (double the previous timeout, capped at 120m for background jobs) and an exact continuation command. At the ceiling, narrow the task. Calling agents must ask whether to continue or stop and inspect, and recover only after explicit user confirmation. Explicit recovery creates a linked new job with a fresh budget, preserving the old terminal record; the companion never retries automatically.

Wait is silent until completion or soft expiry. Only an explicit user progress question warrants observation while running; keep the pending wait open and do not turn the question into recurring checks. Host session collection (such as Codex `write_stdin`) retrieves the pending command’s output, which may include a soft-expiry snapshot; it does not independently read AGY progress. Prefer background completion delivery or a long supported blocking wait. Avoid short empty polls, sleep/observe loops and progress queries for routine updates.

Use one independent background wait per job where the harness supports it, never serialize multiple jobs in one shell. Otherwise use the longest practical wait within the host's tool-call limit. Completion ends an outstanding wait, but the outer harness controls when the model receives it. Bash + skills cannot universally wake an idle model; a timer instruction alone does not schedule another invocation.

Per-repository state lives in `<repo>/.agy-staff/`. `state.json` stores conversations, configuration history indexed by conversation ID (including foreground ask), and lifecycle records, protected by short write transactions; observation reads remain read-only. `config.json` holds optional permission policy. Each job has a spec, diagnostic log, result, final status sidecar, raw stdout (`.events.jsonl`) and atomically published bounded snapshot (`.progress.json`). Raw records may include unknown/malformed events. Missing activity files on legacy jobs yield a status-only snapshot.

After warning-free success, results and metadata become durable before the raw stream/snapshot are deleted. Failures, cancellation, hard timeout and warning results retain intermediates. Results, diagnostic logs, conversation metadata and AGY's own conversation storage are retained. Readers racing with cleanup recheck terminal state: observe returns terminal metadata; wait returns the result. Observe never reads result-file contents, even after successful intermediates have been deleted. Crash-without-result reports include dispatch/worker-start evidence, process IDs, log existence/size and next-inspection/recovery commands without copying prompts or environment values.

### Keeping `.agy-staff/` out of git

Automatic since 0.4: when the companion creates `.agy-staff/` for the first time in a repo, it appends `.agy-staff/` to `.git/info/exclude` (repo-local, untracked) unless the path is already ignored. It never touches the tracked `.gitignore` — the state directory is local scratch, and adding it to a shared, committed file would change the repo for everyone else.

## Troubleshooting

- **"agy reported an error (status ERROR)"** — the companion relays agy's own error verbatim, and appends a cause hint only when the error text actually matches one (invalid model id → run `agy models`; expired auth → run `agy` interactively once to re-login). If agy reported an error but still returned response text, the companion delivers the response anyway — exit 0, response on stdout, warning on stderr (`done_with_warnings`); a deadline with no response but a known conversation instead signals attention (exit 5). An exhausted model quota is its own terminal state, not this generic path — see [Quota exhaustion](#state-and-background-jobs) above (`quota_exhausted`, exit 6).
- **`operation not permitted` on `~/.gemini/...` / `bind: operation not permitted` / sudden "authentication failed" while `agy` works in your terminal** — check whether a harness command sandbox is blocking access. AGY needs its OAuth credentials and a localhost port for its internal language server; allowing workspace writes alone may not provide that access. Where those restrictions apply, use the host's authorization mechanism to run the companion in a context that supports AGY. Use the same permission context to start and manage a job.
- **False crash report on `wait`/`status` ("finished with status crashed and no stored result")** — the background job was started in one permission or sandbox context (e.g. unsandboxed) and collected from another (e.g. inside a command sandbox). The collector cannot see the worker PID across the sandbox boundary and misclassifies the running job as crashed. Run management commands (`wait`, `status`, `result`) in the same unsandboxed permission context as the job start; rerunning from the unsandboxed context resumes waiting or reporting normal status.
- **Empty response, "status SUCCESS"** — a restricted run may report success even when its tool calls were denied. Check whether the profile came from a flag, repository policy or an earlier conversation. Use `setup` to configure allowed commands, or pass `--unrestricted` explicitly if authorized; dropping `--restricted` alone does not override an inherited profile. Some native tools remain unavailable in restricted headless runs even with allow-rules. An empty response from unrestricted mode or tool-free ask needs a separate diagnosis; retain the diagnostics and report it.
- **"unknown flag --X: the whole string … arrived as a single argument"** — several flags, and usually the task, are quoted into one argument. Each flag is its own argument; the task belongs in `--prompt`. See [Task text](#task-text).
- **"task text exceeds the 200KB inline limit"** — the companion ultimately passes the complete prompt to AGY as one command-line argument. `--prompt-file` and `--stdin` simplify input but do not remove that limit. Shorten the task text by referring to a PR, branch or file, and let AGY read the material itself.
- **Workspace attachment** — foreground and background calls pass `--add-dir <repoRoot>` (the launch directory outside Git), including continuation and restart. Without explicit attachment, tested AGY print-mode sessions can start in `~/.gemini/antigravity-cli/scratch` even without `--sandbox`; inherited shell cwd or trusted-workspace settings alone do not attach the repo. The companion does not pass `--sandbox`. Workspace attachment grants scoped file reads; restricted commands still need their allow-rules.
- **Dirty workspace on implement** — `implement` can start even when the repo already has changes. The companion adds a capped status summary to agy's prompt so it knows those paths are pre-existing user work. If the task does not clearly include them, agy should ask before overwriting, cleaning, stashing, resetting, deleting, committing, pushing, or opening a PR with those changes.
- **"agy modified the working tree during this review"** — an unrestricted `research`/`review` run changed files it was asked to preserve. Inspect the listed paths to identify changes from this run before deciding what to revert, preserving pre-existing user work.
- **Project-scoped agy permissions** — agy has project-level rules ("highest priority") tied to its `--project` system; the settings-file path for those is undocumented and unverified, so setup only edits the global file. If a rule seems ignored, check agy interactively. See [Advanced: project-scoped permissions](#advanced-project-scoped-permissions).
- **Rules context** — agy auto-loads `AGENTS.md`/`GEMINI.md`/`.agents/rules/*.md` from the workspace; keep those files sane in repos where you delegate.

## Migration from 0.1

0.2 renamed the permission profiles, changed which profile the modes default to, and dropped the flags that 0.1 used to steer review and execution.

| 0.1 | 0.2 | Notes |
|---|---|---|
| `research`/`review` default to the strict (restricted) profile | `research`/`review`/`implement` default to `unrestricted` | 0.1 fail-closed research and review unless you ran setup first. 0.2 works out of the box and makes `--restricted` the opt-in hardening flag; `ask` still runs restricted (tool-free). |
| `--strict` | `--restricted` | Old name accepted as a deprecated compatibility alias; it warns on stderr. Same semantics. |
| `--loose` | `--unrestricted` | Old name accepted as a deprecated compatibility alias; it warns on stderr. Same semantics. |
| profile names "strict"/"loose" in output | "restricted"/"unrestricted" | Cosmetic rename; the telemetry line (stderr) now prints `profile=restricted` / `profile=unrestricted`. |
| `--diff-file <path>` | *(removed)* | Review is prompt-based: `review --prompt "Review the patch at /tmp/change.patch"`. |
| `--pr <num>` | *(removed)* | `review --prompt "Review PR #730"`. |
| `--target <ref>` | *(removed)* | `review --prompt "Review changes against master"`. |
| `--background` / `--wait` | *(removed)* | Execution style is fixed per mode: `ask` is synchronous, `research`/`review`/`implement` return a job id. Manage them with `status`/`result`/`cancel`. |

Removed flags fail fast with a message naming the replacement. The deprecated profile aliases remain accepted for compatibility; use `--restricted` and `--unrestricted` in new commands and scripts.

## Migration from 0.3

0.4 consolidated the two invocation layers (commands + skills) into a single skills layer with persona names, added the `staffer` mode, and made `.agy-staff/` hygiene automatic.

| 0.3 | 0.4 | Notes |
|---|---|---|
| `/agy:research` (command) + `/agy:agy-research` (skill) | `/agy:researcher` | one skill per persona; the command layer is gone |
| `/agy:review` + `/agy:agy-review` | `/agy:reviewer` | now routes two flavors: code review and general (plan/decision) review |
| `/agy:implement` + `/agy:agy-implement` | `/agy:implementer` | |
| `/agy:ask` + `/agy:agy-ask` | `/agy:ask` | unchanged name, single entry |
| *(none)* | `/agy:staffer` | new general-purpose mode with a minimal prompt |
| `/agy:status`, `/agy:wait`, `/agy:result`, `/agy:cancel`, `/agy:continue`, `/agy:setup` | the `jobs` skill (model-facing) | ask in natural language ("is the agy job done?"); the companion subcommands are unchanged |
| manual `.git/info/exclude` step | automatic on first run | |

## Migration from 0.4.4 (breaking)

0.4.5 removes positional task text. The companion parses the shell's argv once and never re-splits an argument, which is what makes flag-like text inside a task safe (see [Task text](#task-text)). The price is that the task must arrive through an explicit source.

| 0.4.4 | 0.4.5 | Notes |
|---|---|---|
| `ask "question"`, `review "Review PR #730"` (positional task text) | `ask --prompt "question"`, `review --prompt "Review PR #730"` | Positional text is removed, not deprecated: a positional argument on a run command is an error naming the three sources. `--prompt-file` and `--stdin` are unchanged. |
| one big string, e.g. `review "--restricted Review PR #730"` | `review --restricted --prompt "Review PR #730"` | The companion no longer splits an argument into flags. A flag name that still contains whitespace gets an error naming this fix. |

Management commands (`status`, `wait`, `result`, `cancel`, `setup`) are untouched: their positional arguments are ids and values, and `wait <id> --timeout 30s` works exactly as before.

## Migration from 0.4.5

0.5.0 updates all persona defaults and the `flash` alias/`--effort` shorthand from Gemini 3.7 Flash to Gemini 3.8 Flash while preserving each persona effort tier (`ask`: low; `staffer` & `reviewer`: medium; `researcher` & `implementer`: high).

If the installed `agy` CLI does not support Gemini 3.8 Flash, the companion fails clearly without silent fallback: it queries `agy models` and reports available models alongside the best same-effort compatible recommendation (e.g. `--model gemini-3.7-flash-high`), advising that updating `agy` is preferred to use the latest default.

## Windows support

Windows is supported on a best-effort basis and exercised by the `Tests (Windows)` CI job; it has not yet been validated against a real Windows `agy` installation. Subprocesses are spawned with `windowsHide: true` so no console windows appear during background execution. Job cancellation and process cleanup discover descendant processes via PowerShell (`Get-CimInstance Win32_Process`, with `CreationDate` in round-trip precision) and terminate each identified member individually; the leader falls to `taskkill /PID <pid> /F`, never `/T`. A parent link is only followed when the child was created after its parent: Windows keeps a dead parent's PID in `ParentProcessId`, so once that PID is reused an unrelated orphan (typically another job's detached worker) would otherwise look like a descendant and be killed. State locking retries transient Windows errors (`EPERM`/`EBUSY`/`EACCES`) when renaming or unlinking lock directories and marker files.

## Upgrading

Claude Code and Codex cache the plugin under a per-**version** directory (e.g. `cache/agy-staff/agy/0.4.0`) and key "is it current?" on that version string, not on the commit. Bump their manifests and `package.json` together when preparing a release. Pi's Git source instead follows the configured ref; local sources read the checkout directly.

- **Claude Code** — `claude plugin marketplace update agy-staff` refreshes the marketplace clone, then `claude plugin update agy@agy-staff` re-copies it into the cache. `install` is **not** the upgrade command: on an already-installed plugin it answers "already installed" and does nothing, whatever the version. And `update` only moves if the version string changed — on an unchanged version it answers "already at the latest version" and leaves the old commit in place. Force the current commit in with `claude plugin uninstall agy@agy-staff && claude plugin install agy@agy-staff`. Restart Claude Code afterwards either way — skills are registered at session start.
- **Codex** — bump the version, run `codex plugin marketplace upgrade` (or remove and re-add the marketplace entry), then restart the app.
- **Pi** — for an unpinned Git install, run `pi update --extension git:github.com/naldomadeira/agy-agent-staff`, then `/reload`. For local development, regenerate Pi skills (`npm run generate:pi`) and run `/reload`; no push is needed.

You can check which commit is actually installed: the `gitCommitSha` in `~/.claude/plugins/installed_plugins.json`, versus `git -C ~/.claude/plugins/marketplaces/agy-staff log -1` for what the marketplace clone has fetched.

## Repository layout

```
companion/agy-companion.mjs    command entrypoint, modes, job management and setup
companion/stream-worker.mjs    streaming execution, process cleanup and deadlines
companion/observation.mjs      event parsing, progress snapshots and output budgets
companion/state-lock.mjs       state-write locking and stale-lock recovery
templates/                    shared prompt templates (staffer/ask/research/review/implement) and harness-compatibility.md
.claude-plugin/               Claude Code plugin + self-hosting marketplace manifests
.codex-plugin/plugin.json     Codex plugin manifest
.agents/plugins/              Codex marketplace manifest
pi-skills/                    generated agy-* entrypoints/resources for Pi; do not hand-edit
scripts/generate-pi-skills.mjs generates Pi skills and checks for drift
package.json                  Pi manifest, npm file allowlist, and verification commands
skills/                       canonical personas + jobs (Claude/Codex entrypoints;
                              reviewer/ and jobs/ carry references/ for on-demand detail)
assets/                       design diagram + logo + badges
tests/                        offline regression tests and opt-in integration suites
docs/                         references, installation guide and release notes
```
