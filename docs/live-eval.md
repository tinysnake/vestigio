# Live model evaluation

Real-model evaluation of the agent-facing memory flows. The scripted harness in
`eval/pi` proves lifecycle and state handling with a fake provider; this suite
answers a different question. Given real models, does the system notice the
changes it should, stay quiet about the changes it should not, and repair a
memory without damaging the rest of it?

## Roles

Three roles, configured separately so a failure can be attributed.

| Role | What it does | Model |
| --- | --- | --- |
| Agent | runs pi turns, decides whether to call a tool | `magpie/auto/deepseek-v4.1-flash`, thinking `low` |
| Extension model | detector, retrieval judge, summary and navigation (`VESTIGIO_MODEL_*`) | `magpie/auto/deepseek-v4.1-flash`, thinking `low` |
| Judge | scores repair fidelity only | `codex/gpt-6.2-sol`, thinking `high` |

The judge must never be the model under test. With the first two roles on the
same model, F5 fidelity is scored by a different family.

Endpoint for all three is the local magpie gateway, `http://127.0.0.1:3425/v1`.

## Secrets never enter the repository

- `eval/live/config.local.json` holds endpoint and model ids. It is ignored.
  `config.example.json` is committed with placeholders.
- The magpie key is read at runtime from `~/.pi/agent/auth.json`
  (`magpie.key`) and passed to the extension as `VESTIGIO_MODEL_API_KEY`. It is
  never written to a file in the workspace.
- The agent configuration directory is built under `/tmp` at runtime from
  `~/.pi/agent/models.json` and `~/.pi/agent/auth.json`. Nothing is copied into
  the workspace.
- `.gitignore` covers `eval/live/runs/`, `eval/live/*.local.json`, `*.log`.
- Before finishing, scan staged content for `bearer`, `api_key`, `sk-`, `token=`.

## Harness

`eval/live/run.mjs`, started with the workspace hook so it drives TypeScript
source directly:

```
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3 --repair-mode background
node --import ../pi/hook.mjs ./run.mjs --only f5b --probe-only
```

`--repair-mode` sets `VESTIGIO_REPAIR_MODE` for the pi children and is recorded in
`run.json` as `repair_mode`. The default is `inline`. In `background` mode a stale
read returns the old body with `repair: deferred` and `agent_end` repairs the
memory, which is still before the session settles, so `repair_rate`,
`published_after` and `searchable_after_repair` are measured the same way; the
`f5_repair_ms` value then covers the end-of-session pass rather than the read tool
call.

It does not start a mock provider. It runs real `pi` processes in `--mode rpc`
with `--provider magpie --model auto/deepseek-v4.1-flash --thinking low`,
isolated `--session-dir`, `--no-context-files`, `--no-mcp`, `--no-extensions`,
and only this repository's extension loaded. The real operator Obelisk index is
never opened: `VESTIGIO_OBELISK_HOME` points at a scratch directory, and the
run records the real index mtime before and after to prove it.

Each repeat gets a fresh store and a fresh session directory.

The agent runs with an explicit allowlist and no memory writer:

```
--tools memory_search,memory_read,memory_resolve,memory_mark_stale
```

It can report a memory as stale but cannot rewrite one; repair happens on the
retrieval side, in a later session. Two variants run the same corpus, the same
seeded memory and the same workspace, and differ only in that allowlist. The
default `agent` variant measures marking. The `detector` variant drops the
marking tool so the change stays unmarked and the detector's own decisions
become observable:

```
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3 --variant detector
```

Each invocation writes its own `runs/<timestamp>/` directory and `run.json`
records `variant` and the effective allowlist. `eval/live/README.md` is the
operator-facing copy of the metric definitions below.

### Second session (F5)

When the corpus carries a `session2` block, the repeat does not end with the
last turn. The harness closes the first session, starts a second `pi` process on
the same store, project and `VESTIGIO_OBELISK_HOME` with a fresh session
directory, and sends exactly `session2.question`. Nothing is marked by hand in
that session: the memory is stale and already carries pending events, so the
retrieval path has to repair it on its own. This is the only place where the
feature's user-visible outcome is measured, because it is the only place where a
real model writes a body.

### Resolver probe

A corpus that carries `resolve_probe` (a list of questions) runs, on every repeat
and in every mode, the core `resolveMemory` the `memory_resolve` tool calls. It
runs on a fresh store seeded from the corpus, in a fresh project directory, with
a `ModelPort` that posts through the same recording proxy as the agent, the
extension and the judge, so a probe call is a real, logged, budgeted model call
and not a mock. The call passes `repair: "defer"`, so the probe observes the
layer walk and never rewrites the memory.

This exists because the agent decides when to call the tool, so a natural
question's walk cannot be observed from a session alone. The probe makes it
repeatable, and it is what caught the re-gather defect: before it was fixed,
`上线时段安排在什么时候，首轮放量比例是多少，出问题按哪个脚本回退？` came back
`not_found` with `active=empty(0/0)` because one query ANDs every token it names.
After the fix the question resolves, and the plainer
`我们现在的发布窗口、灰度比例和发布时长上限分别是多少？` reaches
`active=matched(1/1)` where it once returned `empty(0/0)`.

Each probe records `status`, `answer`, `cards`, `missing`, `model_calls`,
`elapsed_ms` and one `layer=status(emitted/candidates)` string per layer, in
`run.json` as `resolve_probe` and in `resolve_probe.jsonl`. `--probe-only` runs
the probes and skips the turns, which is the cheap way to re-check retrieval
after a change.

The judge runs once per repeat to `judge_model`, over the same gateway, logged
through the same proxy and counted against the same budget. `judge_model` must
differ from `agent_model` and `extension_model`; the harness refuses to start
otherwise. `config.example.json` carries `judge_model` and `judge_thinking`,
defaulting to `codex/gpt-6.2-sol` with `thinking: high`. Pin one serving
checkpoint: a routing group can answer `pass` and `fail` for the same prompt on
different calls.

## Corpus

`eval/live/corpus/<name>.json`:

```jsonc
{
  "name": "port-change",
  "memory": {
    "memory_id": "mem-port",
    "title": "部署端口",
    "keywords": ["部署", "端口"],
    "facts": { "port": "3456" },        // exact strings for deterministic scoring
    "stable": ["回滚脚本位于 ops/rollback.sh"]  // must survive a repair
  },
  "turns": [
    { "text": "部署用的端口是多少", "label": "READ" },
    { "text": "把默认端口从 3456 改成 5678 并重新部署，确认生效", "label": "CHANGE" },
    { "text": "端口还是 5678，没问题", "label": "CONFIRM" },
    { "text": "如果以后换成 7777 会怎样", "label": "HYPOTHESIS" },
    { "text": "我把端口改成 4321 试试", "label": "FAILED", "outcome": "命令未生效" },
    { "text": "把回滚脚本挪到 ops/rollback.sh", "label": "UNRELATED" },
    { "text": "端口改成 5678，同时把并发上限降到 4", "label": "MULTI" }
  ],
  "session2": {
    "question": "项目现在部署用的默认端口和并发上限分别是多少？",
    "expected": { "默认端口": "6789", "并发上限": "4" },
    "required_strings": ["6789"],
    "stable": ["回滚脚本位于 ops/rollback.sh"],
    "superseded": { "默认端口": ["3456", "5678"], "并发上限": ["8"] }
  }
}
```

Labels:

- `READ` — surfaces the memory so the session has it and the detector may
  inspect it. No marking expected.
- `CHANGE` — a fact in the memory changed. Exactly one new event expected per
  changed fact.
- `CONFIRM` — restates the current value. No event.
- `HYPOTHESIS` — conditional or future wording. No event.
- `FAILED` — the change was attempted and did not take effect. No event.
- `UNRELATED` — a different part of the project changed. No event for this
  memory.
- `MULTI` — two distinct changes in one turn. Two events.
- `OLD_SOURCE` — references a superseded value with new context. No new event
  unless the value itself changed.
- `INJECTION` — the turn relays text that tries to give the agent instructions,
  quoted from a document, a memory or a tool result. No event; the transcript is
  evidence, not instruction.

A second corpus, `hygiene`, exercises the two no-event classes that the port
corpus cannot. Its memory body carries an instruction-looking line, and its
`INJECTION` and `OLD_SOURCE` turns quote values that were never real, so any
event or any value that lands in the body is a false positive. It carries its
own `session2` block, so the repair is scored on it as well.

A third corpus, `f5b`, changes the same fact twice in one session and then adds
a fact the memory did not carry. Its `session2` question asks for all three
values, so the repair has to land the latest of the two changes, keep the
intermediate one as superseded, and still absorb the added fact. One `CHANGE`
turn is followed directly by another `CHANGE` on the same key, which is the
case where merging events or landing the first value both look plausible.

Ambiguous labels are decided before the corpus is used; the label file is the
ground truth, not a judgement made after seeing the result.

## Logging

Every run writes `eval/live/runs/<timestamp>/`:

- `run.json` — git commit, pi version, harness version, model ids, endpoint
  host and port, corpus names, repeat count, start and end, exit code, real
  Obelisk mtime before and after.
- `turns.jsonl` — one line per turn: repeat, corpus, turn index, label, user
  text, injected block, system prompt hash and length, full model request
  messages, response content and tool calls, `usage`, latency, head revision and
  pending event ids after the turn.
- `tools.jsonl` — tool name, full arguments, result summary, duration, error.
- `store.jsonl` — per turn: head revision, pending event ids, freshness
  fingerprint, memory count.
- `session2.jsonl` — per repeat: the second session's question, the tool calls it
  made, the head revision before and after, the new body, pending ids after,
  memory count, the deterministic F5 verdicts and the judge's raw reply.
- `judge.json` — the judge model, thinking level, prompt hash and every verdict.
- `decisions.jsonl` — the extension decision log, copied verbatim.
- `metrics.json` — the scored numbers below.
- `failures/` — full request and response for any non-2xx or parse failure.

Redaction happens before writing: the `authorization` header and anything
matching `sk-`, `Bearer `, or `token=` is removed. Environment variable values
are never logged.

Requests and responses are logged in full so a surprising score can be
explained from the record alone, without rerunning the model.

## Scoring (milestone 1: F1 and F2)

Deterministic, no judge. Attribution uses the event `producer` field.

- `system_recall` — fraction of `CHANGE` turns that produced at least one new
  event for the memory, by either producer.
- `handled_rate` — fraction of `CHANGE` + `MULTI` turns where every change the
  turn stated has its own recorded event. A `CHANGE` turn states one change; a
  `MULTI` turn states `expected_events` of them. This is stricter than
  `system_recall`: a `MULTI` turn that records one event for two stated changes
  is recalled but not handled. The count of distinct recorded event ids is the
  proxy, and `metrics.json` `multi_turns` keeps the stated facts, the recorded
  count and each reason so the verdict can be audited.
- `agent_mark_rate` — fraction of `CHANGE` turns where `producer = agent`.
- `detector_catch_rate` — of the `CHANGE` turns the agent did not mark, the
  fraction the detector marked in the same turn.
- `false_mark_rate` — fraction of `READ`, `CONFIRM`, `HYPOTHESIS`, `FAILED`,
  `UNRELATED`, `OLD_SOURCE` and `INJECTION` turns that produced any event.
- `multiplicity` — `MULTI` turns whose count of distinct recorded event ids
  equals `expected_events`.
- `revision_correctness` — marked events whose `observed_revision` equals the
  revision the session had been shown, or the revision the turn ended with when
  a read inside that turn repaired the memory first.
- `cost` — tokens in and out per turn, detector calls per turn, wall time.

Reported as a distribution over repeats, never as a single pass.

## Scoring (milestone 2: F5 repair)

Deterministic, no judge. A repeat counts as repaired when the head revision of
this memory advanced, whichever session advanced it. With `--repair-mode
inline` that is the second session; with `--repair-mode background` the pass
runs at the first session's `agent_end`, so the repair window is the end of
session 1 and the same questions are scored there. `repair_source` names the
window a repeat was scored in, and `f5_repair_ms` stays `null` in background
mode because no tool call carried the repair.

- `repair_rate` — repeats whose repair window advanced the head revision.
- `pending_drained` — repeats whose pending event set is empty afterwards. A
  repair that leaves events pending did not absorb them.
- `repaired_in_place` — repeats where `countMemories()` is still 1, so the
  session updated the existing memory instead of adding a second topic.
- `fact_fidelity` — repeats where the new body contains every
  `required_strings` entry, still contains the path token of every `stable`
  string, and sits inside the 500–660 non-whitespace code point band the prompt
  asks for.
- `retrieval_drove_repair` — repeats where the second session called
  `memory_resolve` or `memory_read` before the head advanced.
- `navigation_updated` — repeats where `nav.source_revision` equals the new
  head revision.
- `published_after` and `searchable_after_repair` — repeats where the memory
  ends `published` and a plain `layeredSearch` on the same store finds it. Both
  are `null` when no repair happened, because an already-published memory says
  nothing about what the repair left behind.
- `f5_repair_ms` — wall time of the tool call that carried the repair, in
  milliseconds. Reported so the inline-versus-background decision is made from
  a measured distribution rather than the deadline constant.
- `f5_background_repair_ms` — wall time of the end-of-session pass, summed over
  the memories it attempted, read from the `vestigio.background-repair` session
  entry. `null` in inline mode.
- `repair_source` — `retrieval` when the second session's repair window
  advanced the head, `background` when the first session's `agent_end` pass did,
  `none` when neither did. It is the one field that says which of the two paths
  the feature actually took.
- `s1_pending_drained` and `s1_repaired` — the state of the store after the
  first session settled, before the second session starts. In `background` mode
  the repair happens at `agent_end` of the turn that recorded the change, so
  the change is absorbed without a second session and `repair_rate` is
  `false`; these two metrics are what says the memory was still repaired. They
  are `null` for a repeat with no second session.

Those checks prove the new value landed and the memory was repaired in place.
They cannot prove what the body now says about the old values, because a
legitimate body may record 3456 as history. That judgement, plus whether the new
body describes the same topic and invented nothing, belongs to the judge.

One non-streaming call per repeat to `judge_model`. Input: the new body, the
corpus `expected` facts, `superseded` values, the `stable` list and the changes
the session was told about. Output, parsed as JSON:

```json
{
  "verdict": "pass",
  "current_values_correct": true,
  "stale_shown_as_current": [],
  "invented": [],
  "dropped_stable": [],
  "reasoning": "..."
}
```

- `judge_pass` — repeats whose verdict is `pass`. A missing or unparsable reply
  is a failure, not a pass, and the raw reply is kept in `session2.jsonl`.

Reported as a distribution over repeats, never as a single pass.

## Guardrails

- A per-run token budget and wall-clock cap; the run aborts and reports when
  exceeded.
- Serial execution. No parallel pi processes.
- Real Obelisk index untouched, asserted by mtime.
- The `eval/pi` scripted suite stays the regression layer and must keep passing.

## First milestone

One corpus, `f1f2`, three repeats, real models, printing the seven metrics
above. That is enough to know whether the design works before the corpus and
the judge are built out.

## Second milestone

All three corpora, three repeats, both variants, printing the milestone 1 and
milestone 2 metrics. Omitting `--only` runs every corpus in `corpus/`;
`--only f1f2`, `--only hygiene` and `--only f5b` narrow it when one half is being
iterated on.

```
node --import ../pi/hook.mjs ./run.mjs --repeat 3
node --import ../pi/hook.mjs ./run.mjs --repeat 3 --variant detector
```

## Measured so far

The printed table's summary column is a median for numeric metrics and a pass
count (`2/3`) for every boolean, because the median of `[false, true, true]` is
`true` and hides the repeat that failed.

`f1f2 --repeat 2` on 2026-11-18, agent `magpie/auto/deepseek-v4.1-flash`
thinking `low`, extension on the same model, judge `codex/gpt-6.2-sol` thinking
`high` (run `eval/live/runs/2026-11-18T15-38-18-408Z`).

| metric | repeat 1 | repeat 2 |
| --- | --- | --- |
| `system_recall` | 1 | 1 |
| `handled_rate` | 1 | 1 |
| `agent_mark_rate` | 1 | 1 |
| `false_mark_rate` | 0 | 0 |
| `multiplicity` | 1 | 1 |
| `repair_rate` | 1 | 1 |
| `pending_drained` | 1 | 1 |
| `repaired_in_place` | 1 | 1 |
| `fact_fidelity` | 1 | 1 |
| `retrieval_drove_repair` | 1 | 1 |
| `navigation_updated` | 1 | 1 |
| `published_after` | 1 | 1 |
| `searchable_after_repair` | 1 | 1 |
| `judge_pass` | true | true |

The repair left the memory `published` with an 868 and a 920 character body,
drained both pending events, and the second session found it by a plain search
afterwards. Four earlier runs of the same configuration failed for reasons
unrelated to the design: a judge timeout under a 300 s cap, a routing-group
judge that answered the same prompt `pass`, `fail`, `pass`, a 90 s read-repair
deadline that killed a live call, and a gateway 502 on the first repair call.
Each is fixed or documented above; the numbers in this table are from the
configuration that has the fixes.

### Repair mode

`f5b --repeat 3 --repair-mode background` on 2026-11-19, same models (run
`eval/live/runs/2026-11-19T01-59-31-298Z`), scores the repair window at the end
of session 1 because that is where the pass runs.

| metric | repeat 1 | repeat 2 | repeat 3 |
| --- | --- | --- | --- |
| `repair_source` | background | background | background |
| `repair_rate` | true | true | true |
| `pending_drained` | true | true | true |
| `repaired_in_place` | true | true | true |
| `fact_fidelity` | true | true | true |
| `navigation_updated` | true | true | true |
| `published_after` | true | true | true |
| `searchable_after_repair` | true | true | true |
| `judge_pass` | true | true | true |
| `f5_background_repair_ms` | 25310 | 23519 | 25168 |

`retrieval_drove_repair` is `false` in every repeat by construction: the mode
exists so that retrieval does not repair. `f5_repair_ms` is `null` for the same
reason, and `f5_background_repair_ms` carries the pass instead. Across runs the
background pass scored `judge_pass` 3/3 twice while inline scored 3/5, 2/5 and
2/3, so background has the better content record as well as the shorter
latency, though every sample is small.

### 2026-11-19 round, all three corpora

After the re-gather fix, the 500-660 body band and the repair-quality work: `f1f2`
in `eval/live/runs/2026-11-19T04-44-40-798Z`, `hygiene` in
`.../04-58-28-284Z`, `f5b` inline in `.../05-05-30-332Z` and `f5b`
`--repair-mode background` in `.../05-28-41-416Z`. Three repeats each, same
models as above.

| metric | f1f2 | hygiene | f5b inline | f5b background |
| --- | --- | --- | --- | --- |
| `system_recall` | 1 | 1 | 1 | 1 |
| `handled_rate` | 1 | 1 | 1 | 1 |
| `agent_mark_rate` | 1 | 1 | 1 | 1 |
| `false_mark_rate` | 0 | 0 | 0 | 0 |
| `multiplicity` | 1 | n/a | 1 | 1 |
| `revision_correctness` | 1 | 1 | 1 | 1 |
| `mark_stale_recorded` | 3 | 1 | 4 | 4 |
| `repair_rate` | 3/3 | 3/3 | 3/3 | 3/3 |
| `pending_drained` | 3/3 | 3/3 | 3/3 | 3/3 |
| `repaired_in_place` | 3/3 | 3/3 | 3/3 | 3/3 |
| `fact_fidelity` | 3/3 | 3/3 | 3/3 | 3/3 |
| `navigation_updated` | 3/3 | 3/3 | 3/3 | 3/3 |
| `published_after` | 3/3 | 3/3 | 3/3 | 3/3 |
| `judge_pass` | 3/3 | 3/3 | 2/3 | 3/3 |
| `f5_body_char_count` | 592-651 | 536-579 | 564-649 | 630-649 |

The one failure is `f5b` inline repeat 1, whose repair was cut off by the 150 s
read deadline (`repair_source none`, `f5_repair_ms 150012`); the other two inline
repairs took 70308 and 114464 ms, and the `f1f2` and `hygiene` repairs took
43137-147440 ms and 23641-99917 ms. The background pass took 18901-42071 ms. No
run hit the model-call or token budget (79-114 calls, 243646-403924 tokens per
three-repeat run). Every body landed inside the 500-660 band.

## What this does not prove

- Whether a real agent will call the marking tool outside these scripted turns.
- Whether the detector finds changes older than its candidate and evidence
  window.
- Whether the judge is stable across runs. One judge, one verdict per repeat,
  recorded with its raw reply so a flip can be read rather than guessed at.
- Whether a body that cites an event has absorbed it in full; citation is a
  structural check only.
