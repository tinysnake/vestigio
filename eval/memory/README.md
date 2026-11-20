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
| `expected_only` | assert "these and nothing else": any other injected id scores `false_positive` and is listed in `extra_ids` |
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
8. `expected_only` when the question is narrow enough that a neighbour appearing
   is itself the defect (a specific port, one migration step). Do not set it
   where a human would welcome related context.
9. Record in `note` the mechanism, not the verdict: which token or reference
   made the case pass or fail.
10. `expected_stale_ids` claims only that the pipeline marked the memory stale
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

## Candidate batches

`generate-candidates.mjs` drafts cases with the same judge model, three per
call (this model truncates longer JSON arrays mid-object), validates every id
against the catalog, dedupes by surface and text, and marks each row
`status: "candidate", needs_review: true`.

```sh
node --import ../pi/hook.mjs ./generate-candidates.mjs          # drafts candidates.jsonl
node --import ../pi/hook.mjs ./run.mjs --cases candidates.jsonl --out out/candidates.json
node ./generate-candidates.mjs --review out/candidates.json --out ../../docs/memory-eval-candidates-review.md
```

The third step is the point: it sorts every disagreement between the draft
label and what the pipeline did, so a reviewer reads causes instead of rows.

- `precision-leak` — labelled none, injected anyway. The interesting bucket.
- `recall-gap` — labelled hit, nothing surfaced.
- `matcher-weak` — natural-language search under the conjunctive matcher, the
  documented property above, not a labelling question.
- `label-question` — the draft contradicts the text it wrote.

Batch 1 is 45 rows from 8 memories for about $0.009. Its first pass produced 3
precision-leaks; the pool-frequency rule above removed the nginx-upstream one,
and the remaining 2 are label mistakes (a git `回滚` that is not a database
migration, and a `deploy-port` question asked inside the project that owns that
memory). Current tally: 33 agree, 2 precision-leak, 2 recall-gap, 8
matcher-weak. The committed sheet is
`docs/memory-eval-candidates-review.md`.

Nothing flows back automatically. A candidate becomes a real case only when a
human moves it into `cases.jsonl` and fixes the label, so re-running the draft
cannot quietly rewrite the dataset — and the drafts are never used as labels.

The catalog, not the model, is what limits batch size: six candidates per
memory means twenty memories cap a batch near one hundred and twenty. Growing to the proposal's
100–200 rows means adding memories first.

## Usage evaluation

`usage.mjs` is the only part of this directory that calls a model. It takes
`(query, injected nav summaries, answer)` triples from `usage-cases.jsonl`, asks
a judge for one of `used` / `partial` / `ignored` / `misused`, and reports how
often the judge agrees with the hand-written label.

```sh
node ./usage.mjs            # 12 cases, roughly $0.002 and half a minute
node ./usage.mjs --dry      # print the prompts, spend nothing
```

The judge defaults to `magpie/auto/deepseek-v4.1-flash:low` (borrowed from the
`feature, refactoring` row of `~/.pstack/models.md`; `--model` overrides). It
runs through `pi -p --no-tools`, so a report records real `duration_ms`, input
and output tokens, and `cost_usd` per call: cost per verdict is measured, not
assumed.

Two things to keep in mind before trusting a number:

- The judge sees only what the agent saw — nav summaries, never the body. So
  `used` means the answer restated nav-level content, not that it recovered the
  full decision.
- Verdict stability is about one in twelve on a 12-case run. Agreement on the
  committed labels is 0.833 and 0.750 across two runs, so this is a trend
  instrument, not a gate. `usage-cases.jsonl` is labelled by hand precisely so
  the judge can be wrong and be seen being wrong.

`usage-stale-ttl-*` rows are the Stale Misuse side of the proposal: same memory,
`is_stale` true, answers that heed it, ignore it, or treat it as current.

`experiments/nl-cases.jsonl` is the same dataset with the six card queries phrased
as natural questions. It exists to show why the matcher is conjunctive: under the
production `AND` mode five of six miss, and under `OR` recall returns while six of
the twenty memories enter the same result list.

The two false-positive rates share one denominator on purpose. For inject cases
the pool can admit noise that the budget then drops, so `candidate` (from
`plan.matched`) and `injection` (from `plan.injected`) answer different
questions: is retrieval admitting noise, and does the budget hide it. When the
two numbers are equal the cap is not saving anything, and `budget_rescued` says
how often it did.

A zero denominator yields `null`, never NaN.

## Precision history

Two cases started life as labelled false positives, and both are now clean:

- `inject-negative-near-miss`: "旧配置的字段名" used to inject `mem-deploy-port`
  on the shared bigram 配置.
- `inject-near-miss-port-rule`: "部署脚本默认端口" used to inject both
  `mem-port-rule-a` and `mem-port-rule-b` on the shared token 端口, which was
  only a fragment of their alias 端口约定.

Three rounds of fixes live in `matchHotspots` (packages/core/src/hotspots/match.ts),
each one forced by a case that injected noise:

1. A hit needs a whole one-token alias, a contiguous alias phrase, or two
   independent tokens — a lone shared summary token is not enough. Fixed 配置 and
   the 端口 fragment of 端口约定.
2. Overlapping bigrams count once: 的默 and 默认 are the word 默认 seen twice.
   Fixed a neighbour entry matching a single 默认.
3. A keyword alone decides only when the query is that word (3 tokens or fewer)
   or opens with it. Chinese questions name their topic first, so
   迁移失败后先做什么 is about migrations while 把部署章节的截图换成新版 is about a
   screenshot that happens to mention deployment. Fixed the batch-2 leak on
   部署, and left 迁移 working.

Candidate batch 2 measured the effect: precision leaks fell from 9 to 6 of 119
drafts, and the 18-case baseline stayed at 11 hit / 7 clean / 0 false positive,
so no labelled recall was traded away for it. The six that remain are
same-topic-different-question drafts (a Cache-Control header, a token column,
pool leak debugging, an i18n upgrade) — a lexical matcher cannot separate
those, and two of them run in the other project's scope where the injected
memory is the right one anyway.

That leaves the baseline at zero false positives on 18 cases, which is a small
set: treat it as a floor to defend, not as proof of precision.

The floor itself is still 1, and the baseline records what moving it costs.
Setting `DEFAULT_MIN_MATCH_SCORE` to 2 keeps false positives at 0.000 but turns
`inject-implicit-migration` into a miss (one shared token is all it has), taking
`inject_hit_rate` to 0.800 and Recall@1 to 0.889. On 18 cases that is a sweep,
not evidence for a threshold change.

## Query wording

The store's default search mode is conjunctive over the normalizer's output:
unigrams and bigrams for CJK, whole words for Latin. A question fails unless
*every* one of its adjacent pairs occurs in the memory, so natural-language
questions mostly match nothing. Search cases therefore use short phrases taken
from the indexed text. This is a property of the matcher, not of the eval; the
extension's `memory_search` tool documents the same expectation, and
`memory_resolve` is the natural-language path.

### Query expansion

`memory_resolve` does not bypass that matcher: it searches the same index and
relies on the judge's `next_queries` to name phrasings the matcher can use.
`rescue.mjs` measures that step on its own:

```
node --import ../pi/hook.mjs ./rescue.mjs --cases candidates.batch-2.jsonl
```

For every labelled candidate it runs the literal text, and for each miss asks
the model (`magpie/auto/deepseek-v4.1-flash:low`) for up to three short
retrieval phrasings, then searches again. Measured on batch 2 (84 labelled
cases):

| step | cases |
| --- | --- |
| found by the literal query | 32 |
| recovered by one expansion | 42 |
| still missing | 10 |

50 of the 52 literal misses are recoverable at the gather step, for $0.0103
across 52 calls. So the lexical matcher is not the whole recall story: the
resolver's expansion is what makes a natural-language question work, and it
only works when the model names a phrase that shares whole words with the
memory. The measurement is a proxy for that one step — it does not run the
judge, the descent, or the archived/history layers.

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
