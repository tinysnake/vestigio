# Vestigio live evaluation harness (milestones 1 and 2: F1/F2 and F5 repair)

Runs the real `pi` coding agent, with only this repository's Vestigio extension loaded and
only the extension's memory tools enabled, against the real magpie gateway. There is **no mock
provider**: every agent turn, and every extension-side model call the detector makes, goes to
the configured endpoint and costs real tokens. The F1/F2 scoring is deterministic and computed
from the stored stale-event `producer` field and the per-turn store state. Milestone 2 adds
**F5**: when a corpus carries a `session2` block, the harness runs a second, genuinely new
session against the same store and measures whether the retrieval path repaired the stale body
correctly — determined partly by deterministic checks and partly by one LLM judge call per
repeat (so F5 costs tokens too).

The design contract is `docs/live-eval.md`; read it before changing the harness or the corpus.
Two methodology points below deliberately go further than that document, and the harness README
is the authority where they differ: the agent's toolset is memory-only, and `false_mark_rate`
counts `READ` turns (see "Metric definitions").

## What it measures

The agent under test must do all of its work through the memory API. It has no `bash`, `read`,
`edit` or `write` tool, so it cannot read the store, the corpus, the extension source, the
environment, or the seeded project files. A score therefore describes the product, not the
harness.

Eight milestone-1 metrics, per repeat and as a median across repeats:

| metric | formula | better |
| --- | --- | --- |
| `system_recall` | `CHANGE` turns with ≥ 1 new event (any producer) ÷ `CHANGE` turns | high |
| `handled_rate` | `CHANGE` + `MULTI` turns whose stated changes each have a recorded event ÷ `CHANGE` + `MULTI` turns (see below) | high |
| `agent_mark_rate` | `CHANGE` turns with ≥ 1 new event whose `producer` is `agent` ÷ `CHANGE` turns | high |
| `detector_catch_rate` | `CHANGE` turns the agent did *not* mark but the detector did ÷ `CHANGE` turns the agent did *not* mark | high |
| `false_mark_rate` | `READ` + `CONFIRM` + `HYPOTHESIS` + `FAILED` + `UNRELATED` + `OLD_SOURCE` + `INJECTION` turns with ≥ 1 new event ÷ all turns carrying those labels | ideal 0 |
| `multiplicity` | `MULTI` turns whose count of **distinct** recorded event ids equals `expected_events` (2) ÷ `MULTI` turns | high |
| `revision_correctness` | marked events whose `observed_revision` equals the head revision shown that turn ÷ all marked events | ideal 1 |
| `cost` | agent tokens in/out per turn, detector calls per turn, wall time | lower |

Metric definitions in detail:

- **New event** — a stale event for the seeded memory that did not exist before the turn. The
  harness diffs `store.listStaleEvents(memoryId)` before and after each turn.
- **Handled** (`handled_rate`) — a change is handled when a producer recorded an event for it
  and nothing was left silently unrecorded: every change the turn stated must have its own
  event. A plain `CHANGE` turn states one change; a `MULTI` turn states `expected_events` of
  them (two for this corpus), and the harness compares the count of **distinct** recorded event
  ids against that number. The agent cannot rewrite a stored memory, so a change is handled by
  recording a stale event, never by advancing the head revision: the old body-check branch is
  gone. `handled_rate` therefore includes `MULTI` turns in both the numerator and the
  denominator, which is what makes it stricter than `system_recall` — a `MULTI` turn that
  records one event for two stated changes is recalled but not handled. The harness cannot
  attribute an individual event to a single stated fact, so the distinct-id count is the proxy;
  `multi_turns` in `metrics.json` keeps the stated facts, the recorded count and each reason so
  the attribution can be audited by hand. `system_recall` is unchanged: it is the strict
  new-event measure over `CHANGE` turns, and it is reported alongside `handled_rate` so a run
  always shows both. (`docs/live-eval.md` carries the same definitions; this README is the
  operator-facing copy.)
- **`false_mark_rate` includes `READ`** — a `READ` turn surfaces the memory so the detector may
  inspect it. Any event there is a false positive and is counted. (The earlier revision of the
  harness excluded `READ`; that let a detector firing on the very question that restates the
  stored fact go unpunished. `docs/live-eval.md` still describes the old denominator.)
- **`detector_catch_rate` is conditional** — it only has a denominator when the agent missed a
  change. A missed change the detector also misses shows up in `system_recall` /
  `handled_rate`, not here.
- **`multiplicity`** is defined on **distinct recorded event ids**, not on the number of
  events the agent claimed or on repeats of the same event. A `MULTI` turn passes only when the
  set of new `event_id`s recorded for the memory that turn has exactly `expected_events`
  members (2 for this corpus). One event for two distinct facts scores 0, and two identical
  events recorded twice also score 0. `metrics.json` keeps the detail per repeat under
  `multi_turns`, and the table prints the recorded/expected totals as `multi_events`.
- **Tool-outcome counters** — `mark_stale_recorded` / `mark_stale_rejected` count
  `memory_mark_stale` calls that returned `-> recorded` versus `rejected …`. `update_saved` /
  `update_rejected` and their per-turn means are kept for the same shape, but they count
  `memory_update` calls and are **always 0** now: the extension no longer exposes a writer, so
  neither variant can call it. These are cost/UX signals, not correctness; a `memory_mark_stale`
  the detector variant attempts is blocked before it runs and shows up only in
  `agent_tools.blocked_counts`, never in `observed_counts`.

## What it measures (milestone 2: F5 repair)

A `session2` block turns the corpus into a two-session scenario. After the last turn of session
1 and its detector grace, the harness closes the first `pi`, starts a second `pi` with the same
store, project cwd, `VESTIGIO_*` env and extension but a fresh session directory, and sends
exactly `session2.question` as the only prompt — same `--tools` allowlist as the variant under
test, so no variant ever gets a writer. Nothing is marked by hand in that session: the memory is
stale and already carries pending events, so the harness is measuring whether *retrieval* drives
the repair. The store is snapshotted before and after and every tool call of the second session
is recorded.

Deterministic F5 checks, per repeat, computed from those two snapshots and the tool calls:

| metric | formula | better |
| --- | --- | --- |
| `repair_rate` | second sessions whose head revision advanced ÷ repeats with a `session2` | high |
| `pending_drained` | second sessions ending with an empty pending-event set ÷ repeats | high |
| `repaired_in_place` | second sessions ending with `countMemories() == 1` ÷ repeats | high |
| `fact_fidelity` | second sessions whose new body carries every `required_strings` entry, the path token of every `stable` string, and 500–1000 non-whitespace code points ÷ repeats | high |
| `retrieval_drove_repair` | repaired second sessions in which `memory_resolve` or `memory_read` ran before the head advanced ÷ repeats | high |
| `navigation_updated` | repaired second sessions whose `nav.source_revision` equals the new head ÷ repeats | high |
| `published_after` | second sessions ending with the memory's state `published` ÷ repeats | high |
| `searchable_after_repair` | second sessions after which one store-level `layeredSearch` for `session2.search_query` returns the memory ÷ repeats | high |
| `judge_pass` | second sessions the judge accepted (`verdict == "pass"`) ÷ repeats | high |

`fact_fidelity` uses the same path-token rule as `seedStore`: the whitespace token containing
`/` inside each `stable` string must appear in the new body. Two retrieval paths repair a memory
now: `memory_read` folds the pending events in and publishes the new head inline, and
`memory_resolve` repairs the same way but leaves the navigation job for `vestigio jobs run` when
the product has not published it yet. Session 2 therefore reports which tool ran
(`repair_trigger`: the first call whose result reports the new head revision, `null` when no
repair happened), and `published_after` / `searchable_after_repair` separate the two outcomes.

**No nav drain.** The harness no longer runs `vestigio jobs run` between the two sessions or after
session 2. A repair is a product write: it must end with the new revision published and a
navigation summary bound to that revision, or the memory is invisible to `memory_search` and
`memory_resolve`. Draining the queue here would hide exactly that defect, so `published_after`,
`searchable_after_repair` and `navigation_updated` observe the store as the product left it. The
seeded memory is still written published and admitted before session 1, so session 2 starts from
a searchable memory.

**The judge.** One non-streaming chat completion per repeat, sent through the same recording
proxy and counted against the same budget. Inputs are the new body, the corpus `expected` facts,
`superseded`, `stable`, and the changes session 1 was told about; it is asked for JSON only:
`{"verdict":"pass"|"fail","current_values_correct":true|false,"stale_shown_as_current":[],"invented":[],"dropped_stable":[],"reasoning":"…"}`.
The reply is parsed tolerantly (code fences stripped); a missing or unparsable reply is a
failure and the raw reply is kept. The judge is a pinned GPT-6 Sol checkpoint
(`codex/gpt-6.2-sol`), while the agent and extension run the DeepSeek family. It must differ because a model judging
repairs its own family wrote shares that family's blind spots and preferences, so a repair and
its score would not be independent measurements. The harness refuses to start when
`judge_model` equals `agent_model` or `extension_model`, so the judge is never the model under
test. A corpus without a `session2` block reports every F5 metric as `null`, never `0`.

## How to run

```sh
cd eval/live
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3
```

`--import ../pi/hook.mjs` is required: it maps the `@vestigio/core*` bare specifiers and the
NodeNext `./x.js` imports onto the workspace TypeScript, so the extension is driven directly
from source.

Flags:

- `--only <corpus>[,<corpus>…]` — run one or more corpora by name, comma-separated (default: every file in `corpus/`).
- `--repeat <n>` — repeats per corpus, each with a fresh store and session dir (default `3`).
- `--variant agent|detector` — which scenario variant to measure (default `agent`).

Exit codes: `0` ok, `2` harness error, `3` aborted by the budget guard, `4` the real
`~/.obelisk/obelisk.sqlite` changed.

## Scenario variants

Both variants run the same corpus, the same seeded memory and the same seeded workspace. They
differ only in the `--tools` allowlist, so a difference in the numbers is attributable to what
the agent is allowed to do, not to the scenario.

**`agent` (default).** The read tools plus marking. The agent may report a memory as stale
(`memory_mark_stale`), but it cannot rewrite one: no writer tool is enabled, so repair only
happens later on the retrieval side. This is the same invocation as before:

```sh
cd eval/live
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3
```

**`detector`.** The agent keeps only the read tools, so it can surface a memory but cannot
mark it or repair it. Any event recorded during a turn is therefore the extension detector's
own catch — measuring the detector alone, with no agent marking in the way:

```sh
cd eval/live
node --import ../pi/hook.mjs ./run.mjs --only f1f2 --repeat 3 --variant detector
```

Each invocation writes its own timestamped `runs/<timestamp>/` directory, so the two variants
land side by side in `runs/`. `run.json` records `variant` (top level and inside `agent_tools`)
and the effective `agent_tools.allowlist`, so a run directory is self-describing.

Why the variant is needed: in the `agent` variant the agent marks the change itself, so nothing
is ever left pending for the detector to find and `detector_catch_rate` has an empty
denominator (`n/a`). The `detector` variant forces the change to remain unmarked, which is the
only way to observe the detector's own decisions. In the `detector` variant `agent_mark_rate`
is 0 by construction and `detector_catch_rate` is the loaded metric; the two tables are reported
separately and never averaged together. The detector's model call gets one retry when its reply
cannot be parsed (`invalid` output, or a client `invalid_response`); the branch checkpoint still
only advances after a clean run, so a run that fails both attempts leaves the evidence for the
next turn.

## Agent toolset

The `agent` variant launches `pi` with this explicit allowlist:

```
--tools memory_search,memory_read,memory_resolve,memory_mark_stale
```

There is no writer tool. `memory_update` was removed from the extension, so it is not in the
universe of names a variant can enable; the agent's only way to act on a change is to report it
as stale, and the summary is repaired by the next `memory_resolve` that hits the stale memory.
The `detector` variant uses the read-only subset:

```
--tools memory_search,memory_read,memory_resolve
```

`tools` in `config.example.json` / `config.local.json` holds the agent-variant list; it is a
documented default in `run.mjs`, not a hidden constant. For the `detector` variant the harness
hardcodes the read-only list and ignores `tools`, so a config edit cannot silently re-enable
marking for a detector measurement. `run.mjs` refuses to start when the flag is missing, when
the list is empty, when it contains a name outside the known memory tools, when the variant's
required tools are missing, when an `agent` variant enables a writer (`memory_update`), or (for
`detector`) when a writer or `memory_mark_stale` is present. The effective allowlist and the
observed per-tool call counts
are written to `run.json` under `agent_tools` together with `variant`: `observed_counts` are
the calls that actually ran, `attempted_counts` every tool the model tried to call, and
`blocked_counts` the attempts pi refused with `Tool <name> not found` because they were not in
the allowlist. `non_allowlisted` is computed from `observed_counts`, so a blocked attempt in the
`detector` variant is reported but is not an allowlist violation — it never executed. Any
tool that *did* run outside the allowlist also prints a `WARNING`. A run whose
`agent_tools.non_allowlisted` is non-empty is invalid as a measurement.

Because every tool call the agent can make is a memory call, a `READ` turn it cannot satisfy by
running `find`, dumping the session log, reading the store with `sqlite3`, or grepping the
extension source. That was the flaw in the first run: the numbers measured how well the agent
could find the harness.

## Configuration

Defaults (endpoint `http://127.0.0.1:3425/v1`, provider `magpie`, the toolset above, model
`auto/deepseek-v4.1-flash`, thinking `low`, plus budget caps) are in `run.mjs`. To override,
copy `config.example.json` to `config.local.json` (gitignored) and set any field; `null` or an
omitted field keeps the default. The extension's own model calls use `extension_model` /
`extension_thinking`; the agent uses `agent_model` / `agent_thinking`.

`judge_model` (default `codex/gpt-6.2-sol`, GPT-6 Sol family) and `judge_thinking` (default
`high`) select the F5 judge. The judge only runs for corpora that carry a `session2` block. The
harness throws at startup if `judge_model` equals `agent_model` or `extension_model`, so the
judge is never the model under test and its verdict is not a self-assessment by the same family
that wrote the body. Pin one concrete checkpoint: `magpie/auto/gpt-6.1-sol` answers 404 on this
gateway, `remote-magpie/auto/gpt-6.1-sol` answers 502, `auto/gpt-6.1-sol` is switched off, and
the `group/auto-gpt-6-sol` routing group returned `pass` and `fail` for the same prompt on
different calls, which makes a verdict unreproducible.

## Secrets and isolation

- The magpie key is read at runtime from `~/.pi/agent/auth.json` (`magpie.key`) and passed to
  the extension through the child process env only. It is never written into the workspace.
- A throwaway agent config dir is built under `/tmp/vestigio-live/agent` from
  `~/.pi/agent/models.json` (with `baseUrl` rewritten to the local proxy) and `~/.pi/agent/auth.json`.
- Every repeat gets a fresh store, session dir, project cwd and `VESTIGIO_OBELISK_HOME`, all
  under `/tmp`. Nothing touches the real project or its store.
- The project cwd is seeded from the corpus's `workspace` map before `pi` starts, so the
  scenario has real files even though the agent cannot open them.
- The harness records the real `~/.obelisk/obelisk.sqlite` mtime before and after and asserts
  it is unchanged.
- Every log line passes through the redactor (literal key, `Bearer …`, `sk-…`, `token=…`)
  before it is written. After a run, grep the run directory for the key and expect zero hits:

  ```sh
  key=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pi/agent/auth.json","utf8")).magpie.key)')
  grep -RIl -- "$key" eval/live/runs/ ; echo "exit=$?"
  ```

## Cost

The model is chosen for cost, but this is a live end-to-end run. Per repeat expect roughly
7 turns × (1–3 agent requests + 1 detector request), plus one judge request when the corpus has
a `session2` block (each judge call carries the gateway's ~4 k-token system prompt). A
`--repeat 3` acceptance run is on the order of 1 M input tokens, 50 k output tokens and several
minutes. A budget guard aborts and reports rather than running away: `max_model_calls`
(default 200), `max_total_tokens` (default 2 000 000) and `wall_clock_ms` (default 1 200 000).

## Corpus format

```json
{
  "name": "f1f2",
  "expected_multi_events": 2,
  "memory": {
    "memory_id": "mem-deploy-port",
    "title": "…",
    "keywords": ["…"],
    "facts": { "默认端口": "3456", "并发上限": "8" },
    "stable": ["回滚脚本位于 ops/rollback.sh"],
    "context": ["这套服务用 deploy.sh 发布到测试和生产两套环境，改端口时要同时确认反向代理和健康检查。", "并发上限决定单个实例同时处理的请求数，调整前先在测试环境观察一段时间。"]
  },
  "workspace": {
    "deploy.sh": "#!/usr/bin/env bash\nPORT=3456\n…",
    "ops/rollback.sh": "#!/usr/bin/env bash\n…"
  },
  "turns": [
    { "text": "…", "label": "READ" },
    { "text": "…", "label": "CHANGE", "fact_after": "5678" },
    { "text": "…", "label": "MULTI", "expected_events": 2, "facts": ["默认端口: 3456 -> 6789", "并发上限: 8 -> 4"] }
  ],
  "session2": {
    "question": "项目现在部署用的默认端口和并发上限分别是多少？",
    "search_query": "默认端口 并发上限",
    "expected": { "默认端口": "6789", "并发上限": "4" },
    "required_strings": ["6789"],
    "stable": ["回滚脚本位于 ops/rollback.sh"],
    "superseded": { "默认端口": ["3456", "5678"], "并发上限": ["8"] }
  }
}
```

- `workspace` (optional) seeds the scratch project cwd. Keys are relative paths; `.sh` files are
  written executable. The seeded files must agree with the memory: `run.mjs` throws when
  `deploy.sh` does not contain the first stored fact, or when a path named in a `stable` fact is
  not seeded.
- `facts` (on `MULTI` turns) lists the changes the turn states, one string each. It is copied to
  `turns.jsonl` as `stated_facts` and surfaced per repeat under `metrics.json` `multi_turns`, so
  the `handled_rate` and `multiplicity` verdicts can be audited against what was actually said.
- `context` is two or three realistic sentences about the memory's topic, composed into the
  seeded body after `facts`. The composed body (title line, facts, context, stable strings and
  one closing line) must be 500–1000 non-whitespace code points; the harness throws a corpus
  error naming the file, the measured length and the distance from the band instead of padding
  with filler. Filler would reach the floor but the judge would count it as invented content.
- `session2` (optional) turns the corpus into the F5 two-session scenario. `question` is the
  only prompt the second session gets; `search_query` is the short, user-typed query the harness
  runs itself through store-level `layeredSearch` after session 2 (`searchable_after_repair`);
  `expected` are the current values the repaired body must state; `required_strings` are literal
  substrings the body must contain; `stable` are facts the repair must not drop (the path token
  of each, the whitespace token containing `/`, must appear in the body); `superseded` lists the
  values that must no longer be shown as current, keyed by fact. Without this block every F5
  metric and `judge_pass` is reported as `null`.
- `fact_after` (on `CHANGE` turns) is the exact new value the body check looks for.
- A turn must be answerable with the memory tools alone. Turns that ask the agent to run,
  deploy, verify or edit files are invalid for this corpus.

The memory is seeded into a fresh scratch store as a published project memory with a
navigation summary bound to the same revision, and the body is composed from the corpus title,
facts, context and stable strings to 500–1000 non-whitespace code points so it satisfies the
core contracts. Labels are the ground truth and are fixed before a run: `READ`, `CHANGE`,
`CONFIRM`, `HYPOTHESIS`, `FAILED`, `UNRELATED`, `MULTI`, `OLD_SOURCE`, `INJECTION`.

## Output

Each run writes `eval/live/runs/<timestamp>/`:

- `run.json` — environment, models, `variant`, effective agent toolset (with `variant`,
  `observed_counts`, `attempted_counts`, `blocked_counts`) and observed tool counts, corpus
  list, repeat count, exit code, real-Obelisk mtime check, `judge_model` and `judge_thinking`.
- `turns.jsonl` — per turn: label, turn start/end, injected block, system prompt hash/length,
  full model request messages, response content and tool calls, usage, latency, head revision
  before/after, `fact_after` and whether the new body carries it, pending event ids, new events
  with producer/reason/observed_revision, detector observation.
- `store.jsonl` — per-turn store snapshot (head revision, pending ids, freshness fingerprint,
  memory count).
- `tools.jsonl` — every `tool_execution_start`/`end` pair, with `ran` (`false` when pi
  refused the call as not in the allowlist). For `memory_mark_stale` it also carries `status`
  (`ok` / `rejected` / `blocked`) and the `rejection_reason` parsed from the tool text; `null`
  for every other tool and for a call with no result. (`memory_update` no longer exists, so its
  `update_saved` / `update_rejected` counters stay 0.)
- `decisions/` + `decisions.jsonl` — the extension decision log, verbatim (redacted). Detector
  runs are `kind: "tool_read", status: "detector_run"` with
  `detail: "status=… candidates=… evidence=… detected=… recorded=…"`.
- `requests.jsonl` — every proxy request and response, full, redacted.
- `metrics.json` — the eight F1/F2 metrics per repeat plus the median distribution, the
  tool-outcome counters (`update_saved`, `update_rejected`, `mark_stale_recorded`,
  `mark_stale_rejected` and the per-turn means), the F5 metrics
  (`repair_rate`, `pending_drained`, `repaired_in_place`, `fact_fidelity`,
  `retrieval_drove_repair`, `navigation_updated`, `published_after`,
  `searchable_after_repair`, `judge_pass`; `null` for a corpus without a
  `session2` block), and `multi_turns` with the per-`MULTI`-turn stated facts, recorded/expected
  counts, recorded event ids and each event's reason.
- `session2.jsonl` — one line per repeat that ran a second session: the question, the second
  session's tool calls with arguments, `ran`/`is_error` and outcomes, head revision and memory
  state before and after, `nav_source_revision`, the new body, pending event ids after, memory
  count, `repair_trigger` (the tool call whose result first reports the new head, `null` when no
  repair happened), `repair_failed` (whether a `repair_failed` line came back in a tool result or
  on stderr), the `searchable_after_repair` query and result, the deterministic verdicts, the
  judge prompt hash, the judge's raw reply and its parsed verdict (plus `status`/`error` when the
  reply was missing or unparsable).
- `judge.json` — the judge model, thinking level, and one entry per repeat with the prompt hash,
  the parsed verdict fields and the raw reply.
- `failures/` — full request and response for any non-2xx or unparseable call.
