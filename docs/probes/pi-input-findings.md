# pi-input probe findings — can an extension append to the end of a user input?

Probe of `@earendil-works/pi-coding-agent` **1.5.2** (`pi --version` -> `1.5.2`).
Goal: decide whether vestigio v1 can append a matched short summary to the **end of each
user input**, in the same user turn, without touching the system prompt.

Answers below come from the **actual HTTP request body the model receives**, captured by a
local OpenAI-completions mock server (`mock-server.mjs`) that pi is pointed at through an
isolated `models.json`. That is a real artifact Pi produced, not a log the extension wrote.
The extension's own `source`/`streamingBehavior` log is used only as a secondary label for
which capture belongs to which path.

## Configuration used

- Isolated config dir `PI_CODING_AGENT_DIR=<probe>/agent` (`settings.json`, `models.json`,
  `extensions/append-summary.ts`, `prompts/`, `skills/probe-skill/SKILL.md`).
- Isolated `PI_CODING_AGENT_SESSION_DIR=/tmp/vestigio-probe/sessions`.
- `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1`.
- Provider: custom `mock` -> `http://127.0.0.1:8799/v1`, `api: openai-completions`,
  model `mock-1`. No real provider, no real credentials, no real model call needed; the
  mock server records each request body and streams a fixed `OK`.
- The operator's real `~/.pi/agent` was never read or written; no git commands were run.
- Probe extension: an `input` handler returning
  `{ action: "transform", text: `${event.text}${append}` }` with `append` default
  `"\n\n[VESTIGIO_PROBE_MARKER]"`.

Canonical run (print/interactive path):

```sh
cd /tmp/vestigio-probe/cwd
PI_CODING_AGENT_DIR=<probe>/agent PI_CODING_AGENT_SESSION_DIR=/tmp/vestigio-probe/sessions \
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
pi -p --provider mock --model mock-1 --no-context-files --no-mcp --no-extensions \
  -e <probe>/agent/extensions/append-summary.ts \
  --prompt-template <probe>/agent/prompts --skill <probe>/agent/skills \
  "PROBE_PRINT_HELLO"
```

Observed wire user message (`inspect_requests.py`, evidence `requests-pty.jsonl` /
session `evidence/sessions/...`):

```
[user] [{"type": "text", "text": "PROBE_PRINT_HELLO\n\n[VESTIGIO_PROBE_MARKER]"}]
```

## Q1 — does the rewritten text reach the model as the same user message, at its end?

**Yes.** The transform result becomes the user message body; the append is at the end of the
text block. One user message content array: `[{type:"text", text:"<input><append>"}, ...images]`.
Appending never alters the system message (the system prompt in every capture is byte-for-byte
the stock pi prompt; the `input` result type has no `systemPrompt` field — `InputEventResult`
in `dist/core/extensions/types.d.ts` only carries `action` / `text` / `images`).

Path in source: `dist/core/agent-session.js` `_preparePrompt` -> `_runInputHandlers` (emits
`input`, applies `transform`) -> `_expandSkillCommand` -> `expandPromptTemplate` ->
`return { messageType:"user", prompt: expandedText }`; `_prepareRun` builds
`content: [{type:"text", text: trigger.prompt}, ...images]`.

## Q2 — does it hold per input source?

All verified from captured wire requests; `source`/`streamingBehavior` from the extension log:

| Input path | `event.source` / `streamingBehavior` | Append at end? | Evidence |
|---|---|---|---|
| Plain interactive TUI typing (real PTY) | `interactive` / undefined | **yes** | `requests-pty.jsonl`, `events-pty.jsonl` |
| Print-mode prompt (`session.prompt`, same default source) | `interactive` / undefined | **yes** | `evidence-print-*`, `requests-prompt.jsonl` |
| RPC `prompt` | `rpc` / undefined | **yes** | `requests-prompt.jsonl` |
| Steer (mid-stream) | `rpc` / `steer` | **yes** | `requests-steer.jsonl`, `events-steer.jsonl` |
| Follow-up (queued until idle) | `rpc` / `followUp` | **yes** | `requests-followup.jsonl` |
| Extension (`pi.sendUserMessage`) | `extension` / undefined | **yes** | `requests-extsend.jsonl` |
| Skill command `/skill:probe-skill hello` | `interactive` | **yes, at end** | `evidence-print-C_skill.jsonl` |
| Prompt template that does NOT interpolate args | `interactive` | **no — append is dropped** | `evidence-print-B_template.jsonl` |
| Prompt template that interpolates `$@` | `interactive` | partially — inside template text, not at end | `evidence-print-B2_template_args.jsonl` |
| Extension command `/cmd` | (input event skipped) | n/a — no model turn | source: extension commands are checked before `input` |

Key expansions:

- Skill: `/skill:probe-skill hello` + `"\n\n[MARKER]"` becomes
  `<skill ...>SKILL_BODY...</skill>\n\nhello\n\n[VESTIGIO_PROBE_MARKER]` — append survives at end.
- Skill, no args, `append="\n\n[MARKER]"`: expansion **breaks** — `_expandSkillCommand` finds
  `text.indexOf(" ") === -1`, so the skill name is parsed as `probe-skill\n\n[MARKER]`, the
  skill is not found, and the raw text `/skill:probe-skill\n\n[VESTIGIO_PROBE_MARKER]` is sent
  (skill body missing). Using a leading-space append `" [MARKER]"` fixes it:
  `</skill>\n\n[VESTIGIO_PROBE_MARKER]`. **vestigio must insert a delimiter that keeps the
  command name parseable** (a space works; a bare newline does not).
- Prompt template `/probe hello` (body `... ${1:-noarg} ...`) + append: wire text is
  `TEMPLATE_BODY_START hello TEMPLATE_BODY_END` — **marker absent**. `/probe2 hello` (body
  interpolates `${@:-noarg}`): `TEMPLATE2_START hello [VESTIGIO_PROBE_MARKER] TEMPLATE2_END`
  — present but not at end. So for `/template` inputs the append is consumed as template
  arguments before it becomes a message; it only survives if the template body emits them.
  This is a genuine limitation: the `input` event fires **before** skill/template expansion.

## Q3 — the final user message exactly as the model receives it

From the mock server's recorded request body (real artifact). Example (RPC):

```
POST /v1/chat/completions
messages:
  [system] "You are a coding assistant running inside pi, ..."   (stock prompt, unchanged)
  [user]   [{"type":"text","text":"RPC_PROMPT hello\n\n[VESTIGIO_PROBE_MARKER]"}]
```

The persisted session JSONL agrees (same text, `role:"user"` entry). Raw bodies:
`evidence/requests-*.jsonl` (one JSON line per request, full `messages` array).
Note the append sits at the end of the **text block**; if images are attached, image blocks
follow it in the same content array. No separate user message is created.

## Q4 — compaction, and a throwing handler

- **Compaction:** with `settings.json` `{"compaction":{"enabled":false,"reserveTokens":0,"keepRecentTokens":1}}`,
  RPC `compact` summarized `COMPACT_ONE`. The summarization request body contained
  `[User]: COMPACT_ONE\n\n[VESTIGIO_PROBE_MARKER]` — the append is part of the history
  compaction sees, so it is summarized like the rest of the text. The post-compaction request
  kept the marker at the end of retained messages (`COMPACT_TWO`, `COMPACT_POST three`).
  So: retained messages keep the append verbatim; summarized messages carry it into the
  summarizer (what survives is whatever the summarizer emits). Evidence: `requests-compact.jsonl`,
  `out-compact.txt`.
- **Handler throws:** with `PROBE_THROW=1` the handler threw `PROBE_HANDLER_THROW`. pi logged
  `Extension error (...append-summary.ts): PROBE_HANDLER_THROW`, the run completed (exit 0),
  and the wire message was sent **unchanged** (`THROW_TEST hello`, no marker). `emitInput`
  catches per-handler and falls back to the previous text; other handlers still run. A
  throwing handler cannot corrupt or block the prompt.

## Mechanism / hook choice

Only the `input` handler can rewrite the user prompt. `before_agent_start` cannot: its result
type (`BeforeAgentStartEventResult`) allows only `message` (a new custom message) or
`systemPrompt` (replacing the system prompt) — there is no field for the user prompt, and the
user message is built from the already-expanded `trigger.prompt`. So vestigio's append must be
an `input` handler that returns `{action:"transform"}`.

## What remains unverified / caveats

- Not verified with a **real provider** end to end; verification used a local
  OpenAI-completions mock. A real-provider replay that changes nothing about the request body
  is: `pi --provider <real> --model <cheap> -p "hello"` with the same extension and inspecting
  the persisted session JSONL (`PI_SESSION_FILE`).
- Not verified: skill/template inputs in **RPC** or **extension** source (only the interactive
  path was exercised for expansion). Same `_preparePrompt`/`_queueUserInput` code path, but not run.
- Not verified: auto-compaction (threshold) — only manual `compact` was run; the retroactive
  trigger uses the same summarizer, but not observed here.
- Not verified: behaviour when the append itself is longer than the input, or when the input
  is only images (no text).
- Not verified: `>200 KB` request bodies (the mock logs the parsed body regardless).

## Evidence index (`eval/probes/pi-input/evidence/`)

- `requests-*.jsonl` — raw captured model request bodies per path (prompt/steer/followup/extsend/compact/pty).
- `events-*.jsonl` — extension-recorded `source` / `streamingBehavior` (secondary labels only).
- `evidence-print-*.jsonl` — print-mode captures (plain, skill, skill no-arg newline/space, templates).
- `out-*.txt` — driver stdout (wire + input events).
- `sessions/` — persisted session JSONL copies corroborating the same user text.
