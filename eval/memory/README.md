# Offline memory evaluation

Per labeled case: did the right memory surface, did a forbidden one leak, and
did the retrieval layer report the status the case claims? Three surfaces, all
the real production code against a seeded throwaway store — no mocks, no model
call, no network.

- `inject`: `recordProjectInput` + `planInjection` (the extension's input path).
- `search`: `layeredSearch` with a project scope and `limit: 10`.
- `search` with `include_history: true`: the same call plus
  `scriptedHistoryPort(...)`, which returns fixed Obelisk-shaped hits.

## Run

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs
```

`../pi/hook.mjs` maps `@vestigio/core/*` onto `packages/core/src`; it is the same
hook `eval/pi` uses. Do not copy it here.

| flag | default | meaning |
| --- | --- | --- |
| `--cases <path>` | `cases.jsonl` | dataset to run |
| `--out <path>` | `out/report.json` | report path, parent dirs created |
| `--store <path>` | fresh `mkdtemp` store | reuse/extend a specific store; never deleted |
| `--keep` | off | keep the temp store and print its path for inspection |

Exit code is 1 only when a case is `error` (the harness itself broke). `miss`
and `false_positive` are printed to stderr and counted in the report; quality is
gated by comparing against the committed baseline, not by an absolute zero.
That order is why the first baseline can carry known gaps.

A full check of a change:

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs && node ./compare.mjs baseline.json out/report.json
```

Two runs of the same dataset are byte-identical apart from `generated_at`, so a
baseline diff is never noise.

## Dataset

`cases.jsonl` has one case per line. `catalog.mjs` holds the fixed 8-memory,
2-project catalog, `seedStore` (which also records one pending stale event on
`mem-stale-ttl`), and `HISTORY_SCENARIOS` + `scriptedHistoryPort` for the
history surface. Changing the catalog means bumping `CATALOG_VERSION`
and regenerating a baseline.

Case fields:

| field | meaning |
| --- | --- |
| `id` | stable case id, used by `compare.mjs` |
| `surface` | `inject` or `search` |
| `project_id` | project scope; a memory in another project must not surface |
| `text` | the query, indexed the same way the store would index a user turn |
| `expected_memory_ids` | ids that must appear; empty means "nothing specific, only the forbidden set matters" |
| `forbidden_memory_ids` | ids that must not appear; `["*"]` forbids any surfaced id |
| `expected_source_refs` | `{session_id, message_id}` history excerpts that must surface |
| `expected_stale_ids` | surfaced ids whose `freshness.is_stale` must be true |
| `forbidden_source_refs` | excerpts that must not surface (used to prove foreign-project filtering) |
| `expected_status` | optional status: `LayeredSearchStatus` for search (`partial`, `conflicted`, `not_found`, ...), `injected` / `not_injected` for inject |
| `include_history` | enable the history layer for this case |
| `history_scenario` | key into `HISTORY_SCENARIOS`; defaults to `none` |
| `rank_ignored` | presence only, no rank credit or penalty (conflict cases, where order carries no information) |
| `category` | `explicit-recall`, `implicit-recall`, `negative`, `cross-project`, `conflict`, `source-gap`, `stale` |
| `note` | why the label is what it is |

## Annotation rules

The dataset is the ground truth, so the rules matter more than the runner.

1. Label from the raw evidence (memory body and source session), never from the
   runner's output. If the runner disagrees with the label, the label wins and
   the case becomes a finding.
2. A case asserts one claim. If two claims can fail independently, split them:
   one case for "the right memory surfaces", another for "the archive-only
   memory stays out".
3. `expected_memory_ids` empty is a claim too — it means the surface should stay
   quiet. Do not fill it with "something related".
4. Forbid only memories that a reasonable reader would call noise for this
   query. A same-subject sibling that a human would want to see is not a
   forbidden id; a sibling that only shares one token is.
5. Keyword-shaped `text` for `search` cases is required by the conjunctive
   matcher (see below), not a way to make cases easier. Write the shortest
   phrase a user would plausibly type that still contains the indexed words.
6. `expected_status` is optional and only set when the status itself is the
   claim (`conflicted`, `not_found`). Omit it where the layer's status is an
   implementation detail, e.g. a foreign-only history hit that must be dropped.
7. `rank_ignored` only for cases whose surfaced set is unordered by nature
   (two memories claiming the same subject). Never use it to hide a real
   ranking regression.
8. Record in `note` the mechanism, not the verdict: which token or reference
   made the case pass or fail.
9. `expected_stale_ids` claims only that the pipeline marked the memory stale
   when it surfaced it. It cannot claim the agent respected the flag, which is
   why a stale case never replaces a usage judgment.

## Scoring

`surfaced_ids` is `plan.injected` memory ids for inject, and card `memory_id`s in
rank order for search. `candidate_ids` is `plan.matched` for inject (everything
retrieval admitted, before budget and dedup) and empty for search, where the
cards already are the final set. `surfaced_refs` is `session_id/message_id` for history
excerpts that survived filtering. `rank` is the 1-based position of the first
expected id.

Inject results also carry `injection_reason` from `InjectionPlan.reason` (`no_match`,
`over_budget`, `all_deduped`, ...). It is a diagnosis channel, not a scored
field: it says why the pipeline stayed silent, which is what separates "nothing
matched" from "matched but the budget dropped it". On this set only `no_match`
and the injected `null` appear.

Status precedence (`false_positive` outranks `miss`):

1. `error` — the surface call threw
2. `false_positive` — a forbidden id or forbidden ref surfaced
3. `miss` — `expected_status` disagreed, or expected ids/refs were labeled and
   did not surface
4. `clean` — nothing was expected and nothing forbidden surfaced
5. `hit` — otherwise

Metrics use non-error cases only:

| metric | denominator |
| --- | --- |
| `recall_at_K` | cases with expected ids, minus `rank_ignored` ones |
| `inject_hit_rate` | the same set, restricted to `inject` |
| `false_positive_rate` | every non-error case |
| `candidate_false_positive_rate` | `inject` cases that name a forbidden id |
| `injection_false_positive_rate` | the same set: forbidden ids that reached `plan.injected` |
| `budget_rescued` | count of cases where the cap dropped a leaked candidate |
| `source_gap_rescue_rate` | cases with `expected_source_refs` |

The two false-positive rates share one denominator on purpose. For inject cases
the pool can admit noise that the budget then drops, so `candidate` (from
`plan.matched`) and `injection` (from `plan.injected`) answer different
questions: is retrieval admitting noise, and does the budget hide it. When the
two numbers are equal the cap is not saving anything, and `budget_rescued` says
how often it did.

A zero denominator yields `null`, never NaN.

## Known gaps in the baseline

Both are precision misses in the hotspot matcher, and both are counted in
`false_positive_rate`:

- `inject-negative-near-miss`: "旧配置的字段名" injects `mem-deploy-port`
  because the two share the bigram 配置 and `DEFAULT_MIN_MATCH_SCORE` is 1.
- `inject-near-miss-port-rule`: "部署脚本默认端口" injects both
  `mem-port-rule-a` and `mem-port-rule-b` alongside `mem-deploy-port`, on the
  shared token 端口. Three memories for one narrow question is noise even
  though each is topically adjacent.

The injected block is a nav hint, not a body, so the cost is a line each; these
are still real precision misses. Raise the case count or the match floor before
treating the rate as stable.

Both live at the current floor of 1, and the baseline records the cost of moving
it. Setting `DEFAULT_MIN_MATCH_SCORE` to 2 makes both clean and drops
`false_positive_rate` to 0.000, but turns `inject-implicit-migration` into a miss
(one shared token is all it has), taking `inject_hit_rate` to 0.750 and
Recall@1 to 0.875. At 3 and 4 another inject case is lost. On 18 cases that is a
sweep, not evidence for a threshold change; shrinking this known-gaps list is
what a larger dataset should decide.

## Query wording

The store's default search mode is conjunctive over the normalizer's output:
unigrams and bigrams for CJK, whole words for Latin. A question fails unless
*every* one of its adjacent pairs occurs in the memory, so natural-language
questions mostly match nothing. Search cases therefore use short phrases taken
from the indexed text. This is a property of the matcher, not of the eval; the
extension's `memory_search` tool documents the same expectation, and
`memory_resolve` is the natural-language path.

## Compare two runs

```sh
node ./compare.mjs baseline.json out/report.json
```

Prints both commits and a metric table (baseline, candidate, delta) built from
the two reports, then matches by `case_id` and lists regressions (`hit`/`clean` →
`miss`/`false_positive`/`error`) first, then fixes, other status changes, missing
and added cases. Exit 1 on any regression. Reads only the two JSON files; no
store, no network.

If `dataset_sha256` or `catalog_version` differ between the two reports, the
metric table is preceded by a warning, because deltas across different datasets
or catalogs do not mean what they look like. The case list is still printed.

Comparing two commits therefore takes two runs and one diff:

```sh
node --import ../pi/hook.mjs ./run.mjs --out out/baseline.json   # at the old commit
node --import ../pi/hook.mjs ./run.mjs --out out/candidate.json  # on the new one
node ./compare.mjs out/baseline.json out/candidate.json
```

## What this does not measure

- Model behaviour: nothing is generated, so answer quality is out of scope.
- Whether the agent should have queried at all (Trigger Miss): this harness
  calls the surface directly and never observes an agent turn.
- Real Obelisk contents: the history port is scripted. What is measured is how
  the layer classifies, filters and attributes excerpts, not what the adapter
  returns — `eval/pi` covers the adapter.
- Latency and token cost: this harness makes no model call and does no index
  work, so it reports no timing. Both belong to a harness that runs the real
  pipeline.
- Whether stale memory is *used*: `expected_stale_ids` only proves the pending
  event reached the surface (the card and the ⚠ hint). Misuse Rate needs the
  agent's answer, so it is out of scope here.
- Multi-turn dedup and concurrency: each inject case gets a fresh
  `InjectionLedger` and each run a fresh store, with fixed seeded activity, so
  recency stays constant.
