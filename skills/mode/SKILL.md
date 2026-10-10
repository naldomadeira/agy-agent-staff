---
name: mode
description: Show or set how much work goes to the AGY worker pool (agy-first, mixed, off). Use when the user says /agy:mode, "usa o agy como prioritário", "prioritize the agy pool", "save Claude tokens", "my weekly quota is low", or asks which delegation mode is on.
argument-hint: '[agy-first|mixed|off]'
allowed-tools: Bash(node:*)
---

# agy mode

The mode says how much of the session's work the host hands to the pool. The companion stores it in
`~/.config/agy-staff/mode.json` (or under `$XDG_CONFIG_HOME`) and shows it on `status --line`. The
companion never acts on it: you, the host, read it and route work accordingly.

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" mode            # show
node "<skill-dir>/../../companion/agy-companion.mjs" mode agy-first  # set
```

Set it only when the user asks. If the user only complains that the host's own quota is low, suggest
`agy-first` and let them decide.

## What each mode asks of you

- **`agy-first`.** Implementation, research and review go to the pool by default, routed with
  `--model auto` (and `--class` when the mode's default class does not fit). You keep user
  communication, integration, the final review of what workers delivered, and any decision whose
  reason you can name, such as an architectural one. Doing a delegable task yourself needs a stated
  reason. "It is faster" is not one when accounts are open.
- **`mixed`.** Check `status --line` or `workers --suggest --class <c>` before each round. Send to
  the pool what fits a routed class while its accounts are open, and keep the rest. When both sides
  have quota, prefer the pool for long, well-scoped work and yourself for short, context-heavy work.
- **`off`.** Use the pool only when the user asks for it.

In every mode, dispatch through `lead`/`pool` and collect through `jobs`. Never accept a worker's
"done" without reading its diff and gate output.
