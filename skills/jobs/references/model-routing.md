# Choosing a model

Every persona that reaches agy (`ask`, `staffer`, `researcher`, `reviewer`, `implementer`) accepts
`--model <id>` and `--effort low|medium|high`, each with its own default. This is the shared
guidance for when to leave the default alone and when to override it.

## Get the live list, not this file

The model roster changes over time; this file does not enumerate it and would go stale in silence
if it tried. Run `agy models` for the current ids and their labels — it is what `handleUnsupportedModel`
in the companion consults too, so the list you see here is the same one a rejected `--model` falls
back to.

```bash
agy models
```

Reading the output: an id is `<family>-<tier>`. Flash families (`gemini-3.8-flash`,
`gemini-3.7-flash`, `gemini-3.6-flash`, ...) take `high`/`medium`/`low`; `gemini-3.1-pro` takes only
`high`/`low` (the companion falls back to `high` if you ask it for an effort it does not have,
with a note on stderr). The Anthropic and GPT-OSS ids carry a fixed suffix instead of a chosen
effort (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`) — pass them as-is,
`--effort` does nothing for them. The bare aliases `flash` and `pro` resolve to the current default
flash family and to `gemini-3.1-pro`, respectively, combined with `--effort` if given.

## Routing rules

- **Flash is the default and serves the volume.** Reading, sweeps, well-scoped tasks with a clear
  answer shape — leave the persona's default model alone. Most delegated work is this.
- **`gemini-3.1-pro` and the Claude ids are for the hard cases**: architecture decisions, a fix
  that already failed once and needs the actual cause understood before a second attempt, a diff
  wide enough that the consequences need reasoning through rather than pattern-matching. Reach for
  these when the task itself demands it, not as a default upgrade for "important" work.
- **Anthropic quota is scarcer than the Gemini families.** Use `claude-sonnet-4-6` or
  `claude-opus-4-6-thinking` when they are what resolves the task — not out of habit, and not
  because the task merely seems important. If a flash tier or `gemini-3.1-pro` would do, prefer it.
- **Try `--effort` before you switch families.** It is the cheaper lever: `--effort high` on the
  current family often closes the gap that made a heavier model seem necessary. Escalate to a
  different family only once effort alone does not.
- **An unsupported model id is not a silent failure.** The companion validates pre-flight where it
  can, and `handleUnsupportedModel` catches the rest by querying `agy models` and reporting the
  available ids plus a same-effort recommendation before dying. If a `--model` you pass gets
  rejected, relay that message — do not guess a substitute yourself.

## Continuations

`--continue` / `--conversation <id>` inherit the model recorded on that conversation unless you pass
an explicit override. The rules above apply to new tasks and to any override on a continuation.
