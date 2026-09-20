# agy vs. codex — when to dispatch which

Back to the [README](../README.md).

Source: a single real orchestration run — 30 tasks across two repositories (a Next.js panel and a
NestJS API sharing one Postgres instance), dispatched in series across roughly 20 background jobs,
each result verified independently against the actual repos rather than trusted from the
executor's own report. It ended in 5 merged PRs with green CI. This page keeps the part of that
run that changes how you decide *what to dispatch where*; it does not restate the feature spec that
was executed.

## The honest comparison

Not a competition — different profiles, and the difference is what should drive the allocation.

| | agy | codex |
|---|---|---|
| Code delivery | volume, fast | slower, denser |
| Commits without being told to | no | yes |
| Reports a limit instead of working around it | rare | five times, all correct |
| Stops to ask for authorization | no | yes, three times |
| Setup cost | long prompt | long prompt |

## The point that matters, stated plainly

codex stopped five times mid-task to say "this doesn't close" — and every one of those stops was a
real defect, not a false alarm: a `NOT NULL` column blocking the new flow, two fields that didn't
cross the boundary between the two repositories, a currency scale that didn't exist where it went
looking for it, a table that was missing. That behavior is worth more than raw speed, because the
alternative — improvising past the gap — leaves the defect buried instead of surfaced.

agy delivered more code per unit of time in the same run, and it made no wrong design decisions.
Where it failed was **process**, not judgment: doing the work and not committing it, and idling on
a background test run instead of running it in the foreground and reading the result.

## Practical allocation

- **agy** — well-scoped work with a clear acceptance criterion, where the spec itself can be
  trusted and the job is to execute it correctly and quickly.
- **codex** — work where the spec itself might be wrong, and the run needs someone who will notice
  and say so instead of coding around it.

## Allocation by model weight, inside agy's own pool

- **Pro** (`gemini-3.1-pro`, high effort) for judgment calls: a migration touching a production
  table, and anything crypto-related.
- **Flash** (`gemini-3.8-flash`, high effort) for mechanical refactors and focused, well-defined
  fixes.

That split held in practice: no flash-tier delivery in the run needed rework over a wrong decision
— only over the process failures described above, which are orthogonal to model weight.

## Why this lives here and not upstream

This page describes one operator's personal environment: several named agy pool profiles
(`agy2`…`agy5`) and more than one named codex account (`kratos`, `zeus`), run by a single person
across two repositories at once. That's intentional — this fork is personal, and this allocation
guidance is not meant to land in the upstream `agy-agent-staff` project.
