# PR-06 resolver evaluation harness

Live evaluation for `memory.resolve` — the budgeted, model-backed layered
history retrieval added by PR-06. It runs the real `vestigio resolve` CLI, the
real `@vestigio/model-client` OpenAI-compatible client, and the real Obelisk
history port; nothing is mocked.

## Live is opt-in

The harness contacts a paid gateway, so it does nothing unless you ask for it:

```sh
cd eval/resolver
VESTIGIO_RESOLVER_LIVE=1 node --import ./hook.mjs ./run.mjs
```

Without `VESTIGIO_RESOLVER_LIVE=1` it prints a `live: false` ledger and exits 0,
so nothing that runs it by accident reaches the network.

## Configuration

The gateway is read at run time from `~/.pi/agent/models.json` (override with
`VESTIGIO_MODELS_FILE`): the `magpie` provider's `baseUrl`, `apiKey`, the
`auto/deepseek-v4.1-flash` model entry and its `cost` table. The key is passed
to child processes through the environment (`VESTIGIO_MODEL_API_KEY`) and is
never printed, written into a report, or committed; the ledger records only its
length. Thinking level is `low`.

## What it checks

| Scenario | Question | Expected |
| --- | --- | --- |
| a | Active memory answers directly | `resolved`; Active matched; the historical layer is skipped |
| b | Only an archived memory answers | `resolved`; Active empty; Archived matched; no raw-history search |
| c | A candidate matches the words but not the question | the walk descends and raw-history excerpts surface |
| d | Nothing anywhere | `not_found`, a null answer and a stated gap |
| e | Two memories disagree | `conflicted` (or non-empty `conflicts`), never a flat answer |
| f | The caller cancels mid-flight | the in-flight model call is cancelled |

Scenario c uses a fixture that already exists for PR-03/PR-04:
`eval/fixtures/obelisk/build_fixture.sh` builds an isolated Obelisk home for
`/tmp/x_a` containing a `zqleak` session; a lexical decoy memory matches the
word but not the question, so the checks assert the walk descends into the raw
history instead of answering from the decoy.

The perf block runs the same question through `vestigio resolve` and through
PR-04's zero-LLM `vestigio search` three times each and records request total,
median wall clock, gather/model/source-read times, input and output tokens, cost
and the number of primary-Agent tool calls (one process invocation each).

## Output

Ledgers land in `eval/resolver/out/latest.json` and `out/run-<timestamp>.json`.
They include every scenario's raw payload, the pass/fail checks, the perf
numbers, and `/Users/snake/.obelisk/obelisk.sqlite`'s mtime and size before and
after — the read path can refresh its derived index, and any change is recorded
rather than hidden. The harness exits non-zero when a check fails.
