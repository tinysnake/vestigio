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

`cases.jsonl` has one case per line, 99 of them at `CATALOG_VERSION` 6. The
sixteen `search-near-miss-*` rows were promoted from `candidates.batch-3.jsonl`
after a hand check: each shares vocabulary with a memory and asks about
something else, and each currently comes back `not_found`, so they exist to give
a fallback strategy a real denominator rather than to test today's query.
Coverage by category: `negative` 38, `implicit-recall` 33, `composition`
11, `cross-project` 4, `stale` 3, `explicit-recall` 2, `conflict` 2,
`source-gap` 2; by surface: `inject` 51, `search` 44.
`catalog.mjs` holds the fixed 20-memory, 2-project catalog, `seedStore` (which
also records one pending stale event on `mem-stale-ttl`), and
`HISTORY_SCENARIOS` + `scriptedHistoryPort` for the history surface. Changing the catalog means bumping `CATALOG_VERSION`
and regenerating a baseline.

Case fields:

| field | meaning |
| --- | --- |
| `id` | stable case id, used by `compare.mjs` |
| `surface` | `inject` or `search` |
| `project_id` | project scope; a memory in another project must not surface |
| `text` | the query, indexed the same way the store would index a user turn |
| `expected_memory_ids` | ids that must appear; several ids are an AND (a composition question is only answered when all of them surface, otherwise the case is a `miss` and the rest are listed in `missing_expected_ids`); empty means "nothing specific, only the forbidden set matters" |
| `forbidden_memory_ids` | ids that must not appear; `["*"]` forbids any surfaced id |
| `expected_source_refs` | `{session_id, message_id}` history excerpts that must surface |
| `expected_stale_ids` | surfaced ids whose `freshness.is_stale` must be true |
| `forbidden_source_refs` | excerpts that must not surface (used to prove foreign-project filtering) |
| `expected_status` | optional status: `LayeredSearchStatus` for search (`partial`, `conflicted`, `not_found`, ...), `injected` / `not_injected` for inject |
| `include_history` | enable the history layer for this case |
| `history_scenario` | key into `HISTORY_SCENARIOS`; defaults to `none` |
| `rank_ignored` | presence only, no rank credit or penalty (conflict cases, where order carries no information) |
| `expected_only` | assert "these and nothing else": any other injected id scores `false_positive` and is listed in `extra_ids` |
| `category` | `explicit-recall`, `implicit-recall`, `negative`, `cross-project`, `conflict`, `source-gap`, `stale`, `composition` |
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
| `expectation_hit_rate` | cases that should deliver something (ids, refs or a stale flag) |
| `quiet_rate` | cases that should stay quiet (no expectation, but a forbidden id or an `expected_status`) |

The last two come out of the report's `confusion` block, which splits the set into
the two classes the labels actually define:

| | delivered / quiet | missed | leaked |
| --- | --- | --- | --- |
| should deliver (56) | 49 | 7 | 0 |
| should stay quiet (39) | 38 | 0 | 1 |

A case with no expectation, no forbidden id and no `expected_status` is counted
apart as `unlabelled` and left out of both sides, so an unlabelled row cannot be
read as a pass. Note that `false_positive_rate` divides by every scored case
(4/99 = 0.040) while the matrix divides by the 42 quiet cases (4/42 = 0.095): the
same leak, diluted differently, so say which denominator you mean.

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

- The judge sees only what the agent saw. `usage-cases.jsonl` rows carry nav
  summaries, and a row may add `body_text` for a memory the agent actually read
  (the bridge below does). Without it `used` means the answer restated
  nav-level content, not that it recovered the full decision.
- Verdict stability is about one in twelve on a 12-case run. Agreement on the
  committed labels is 0.833 and 0.750 across two runs, so this is a trend
  instrument, not a gate. `usage-cases.jsonl` is labelled by hand precisely so
  the judge can be wrong and be seen being wrong.

`usage-stale-ttl-*` rows are the Stale Misuse side of the proposal: same memory,
`is_stale` true, answers that heed it, ignore it, or treat it as current.

### A coverage gap the trigger harness found

The 24-turn run left one cold turn as a retrieval miss: the question about
naming a container image reached both `memory_search` and `memory_resolve` and
was shown nothing, while the memory that answers it (`mem-docker-image`) was in
the store. The reason is vocabulary, not ranking: that memory was written about
镜像标签 and said nothing about 容器 or 打包, so no lexical layer could connect
the user's words to it, and the judge had nothing to rewrite toward.

Adding 容器 to that memory's keywords (`CATALOG_VERSION` 5) turns the same
scenario green: `--only cold-image-tag --repeats 2` goes from
`miss (retrieval_miss)` to `hit hit`, and the offline baseline of the time is
unchanged because no offline case asked that way. The general lesson is the one
`Memory Coverage` exists for: for a lexical retriever, the words a memory is
written with decide whether it can ever be found, and that is a formation
question rather than a matcher one.

### Judging real answers

Hand-written answers cannot show whether the judge agrees with reality, so
`usage-from-trigger.mjs` turns a trigger run's real answers into judge rows. It
reconstructs the memory each recall turn had in context (the hotspot plan for
warm turns, a fact-to-memory table for cold ones), attaches the body the agent
could have read, and labels each row by the objective check the trigger harness
already makes: does the answer carry the memory's fact.

```sh
node --import ../pi/hook.mjs ./trigger.mjs          # produces out/trigger.json
node --import ../pi/hook.mjs ./usage-from-trigger.mjs
node --import ../pi/hook.mjs ./usage.mjs --cases out/usage-from-trigger.jsonl
```

Two prompt rules came out of the first run at 0.688 agreement, where every
disagreement was `expected=used judge=misused`: an answer that names a superseded
value as 改动前 / 早期约定 while stating the current one is `used`, and an answer
that adds caveats the memory did not contain is still `used` if it restated the
memory. With those rules the same 16 real rows reach 0.938 ($0.006, p50 2.4 s)
and the hand set stays at 0.833, so the rules fixed a judge habit rather than the
test.

The one remaining disagreement is a definitional edge worth keeping visible: the
stale session-timeout answer reports the pending change (15 minutes) as the
current value, and the judge calls that misuse of a stale memory. Whether
"taking a pending change as current" is use or misuse is a product decision, not
a prompt bug.

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

## Resolution surface

`run.mjs` measures what retrieval delivers; `resolution.mjs` measures what the
resolver makes of it. It scripts the judge, so every case pins one branch of the
walk instead of a model's mood — no network, no cost, same answer every time.

```sh
node --import ../pi/hook.mjs ./resolution.mjs   # 7 cases, writes out/resolution.json
```

| case | asserts |
| --- | --- |
| `res-accept-first-gather` | an accepting judge resolves on the first gather and stops there |
| `res-refuse-without-followup` | evidence judged insufficient with no `next_queries` stops after one call, `missing` = `evidence_insufficient` |
| `res-requery-recovers` | a refusal that names a rewrite term re-gathers, and the second judge call resolves |
| `res-empty-gather-not-found` | every layer empty with a model present still spends one judge call, and `missing` carries both the verdict and `no_candidates_gathered` |
| `res-zero-llm-no-candidates` | no model configured: zero calls, `missing` = `model_not_configured` |
| `res-zero-llm-with-candidates` | same degradation with a candidate hit: status stays `partial` |
| `res-malformed-judge` | an unparseable judge reply is retried once, then `missing` starts with `model_malformed_output` |

What it found, and what it fixed: an empty gather is not free — with a model
configured the resolver calls the judge anyway, and the entry it recorded
(`evidence_insufficient`) was the judge's verdict about a set that had nothing in
it. A question whose memory exists but never matched therefore read exactly like
a question whose memory does not exist. `stopAssembly` in
`packages/core/src/resolver/resolver.ts` now appends `no_candidates_gathered`
when a whole walk produced neither a card nor a history excerpt, keeping `reason`
first so `missing[0]` (what the extension reports as `degraded_reason`) is
unchanged and the agent sees `missing: evidence_insufficient;
no_candidates_gathered` — which is the difference between "the index never
reached this memory" and "the model would not accept what it read".

Honest limit: because the judge is scripted, a case pins the resolver's own
behaviour, not the model's. The re-query case is the clearest example — mutating
`MAX_LAYER_GATHERS` or `MAX_LAYER_REQUERIES` in
`packages/core/src/resolver/resolver.ts` did not change its outcome, so what it
proves is "a judge-named term is re-searched and can resolve", not that either
constant is load-bearing. The malformed case does go red when the retry is
disabled (`judged.retryable && !retryUsed` → `&& false` gives
`FAIL res-malformed-judge judge_calls=1`).

## Trigger evaluation

Everything above runs offline and cannot see the failure the proposal calls a
Trigger Miss: the agent answering from general knowledge when the question needs
the project's own history. `trigger.mjs` measures it against the real provider.

```
node --import ../pi/hook.mjs ./trigger.mjs --repeats 2
```

Each turn is a real `pi -p` run with the extension loaded, an isolated store
seeded from `catalog.mjs`, and `--no-context-files --no-mcp --no-session` so the
only project knowledge available is memory. Fourteen scenarios:

- four **warm** — deploy port, migration rollback, cache invalidation, a timeout
  that changed. The hotspot layer injects a block, so answering means reading it.
- four **cold** — a connection limit, log retention, an image tag, secret
  rotation, all phrased so that `planInjection` matches nothing. Only a
  deliberate search can answer them.
- five **quiet** — rename a heading, explain an index, hello world, an ENOENT
  error, and installing nginx in a container. Any memory call here is noise.
- one **conflict** — the deploy port, where the injection plan hands over
  `mem-deploy-port` next to two 端口约定 memories that disagree.

Every scenario may also declare `contaminated_by: <memory-id>`, which grades what
an unnecessary delivery did to the answer, or `decided_fact: <value>`, which asks
the judge whether the answer committed to one value instead of listing
candidates; `--stale-port-rule` additionally records the supersession the two
端口约定 memories are missing. See "What a wrong or irrelevant delivery costs the
answer" and "Can the agent settle a contradiction?".

A turn counts as a hit when it calls `memory_search`, `memory_resolve`,
`memory_read` or `memory_mark_stale`.

Calling a tool is not the same as answering from it, so each recall scenario also
names a `fact` taken from the memory body (`18080`, `第五步`, `删缓存`, `15`, `20`,
`14`, `哈希`, `90`). The answer is compacted (whitespace removed, so `15 分钟` and
`15分钟` both count) and searched for that fact:

| outcome | meaning |
| --- | --- |
| `hit` | called a memory tool and the answer carries the fact |
| `usage_miss` | called a memory tool, answered without the fact |
| `miss` | called a memory tool, then said it found nothing (the answer matches a refusal: 没有找到 / 查不到 / 无结果 / 记忆库为空 / no matching memory) |
| `trigger_miss` | never called a memory tool |
| `over_trigger` | a quiet scenario called one |
| `clean` | a quiet scenario stayed quiet |

`miss` is deliberately not `usage_miss`: a search that returns nothing and a
search whose result was ignored are different failures with different owners.

Each turn also records whether any memory URI ever reached the model — the
injected block arrives as a user message, tool results as their own messages, so
the harness scans every non-assistant message for `memory://`. That is what turns
the proposal's four-way split into per-turn attribution, printed as
`failures: trigger N retrieval N usage N`:

| condition | attribution |
| --- | --- |
| no memory tool called | `trigger_miss` |
| called, but no memory URI ever reached the model | `retrieval_miss` |
| a memory reached the model, but the answer lacks the fact | `usage_miss` |
| (Resolution Miss is not attributed here — it needs the resolver's own outcome, which the harness does not see) | — |

The distinction has already paid for itself: a cold image-tag turn that called
both `memory_search` and `memory_resolve` and was shown nothing reads as a
retrieval miss, not as a model that ignored what it was given (see "A coverage
gap the trigger harness found").

`memory_resolve` needs a model to rewrite a question into index terms, so the
harness points the extension at the local gateway by default
(`VESTIGIO_MODEL_BASE_URL`, `VESTIGIO_MODEL_ID`, `VESTIGIO_MODEL_API_KEY`,
`VESTIGIO_MODEL_THINKING`, see `packages/pi-extension/src/config.ts`). It is
configured unconditionally rather than probed, because a reachability probe turns
a busy gateway into a silently degraded run. `--no-resolve-model` keeps the
zero-LLM path measurable, and both runs report which mode they used.

### What the resolver is worth

Twelve turns per run, same scenarios and same empty-result hint in the extension:

| metric | degraded (`--no-resolve-model`) | with the resolver model |
| --- | --- | --- |
| should-recall rate | 0.500 | 0.875 (0.938 over 24 turns) |
| of those, active retrieval | 0.875 | 0.750 (0.813 over 24 turns) |
| usage-miss rate | 0.125 | 0.125 (0.000 over 24 turns) |
| over-trigger rate | 0.250 | 0.250 (0.125 over 24 turns) |
| p50 / p95 | 8.7 s / 21.3 s | 13.4 s / 89.7 s |
| cost | $0.0120 | $0.0111 |

Degraded, the cold turns search the question verbatim, get zero cards and answer
that nothing was found; with the model, the resolver rewrites the question and
three of four cold turns answer from the memory. The price is latency, not
tokens: p50 roughly doubles and p95 grows fourfold when the resolver descends.
Over-trigger splits by scenario, not by chance. The generic ENOENT question
called `memory_search` once in four of the last four samples of it: the agent
appears to ask whether this project has seen the error before, which the "quiet"
label calls unnecessary. The heading-rename question triggered in some runs and
not others and stays noise. `cold-conn-limit` is likewise the only cold scenario
that has been observed both answering and giving up in the same configuration.
Non-deterministic by construction: same model, same prompts, different calls.
p50 was 9–10 s per turn with a 29–40 s outlier, and the answer text is not
judged here — correctness still needs `usage.mjs` or a human.

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

That left the baseline at zero false positives on the cases of the time, which is a small
set: treat it as a floor to defend, not as proof of precision.

### Known gaps in the baseline

The 99-case baseline is not clean, and the misses are the point:

- Three more false positives joined on batch 4, hand-checked and kept as tracked
  precision debt rather than fixed on the spot, because each names a mechanism
  the matcher cannot yet tell apart: `inject-neg-feature-flag-refactor`
  ("把这个 feature flag 的开关逻辑抽成工具函数") is `feature flag` split into two
  ASCII tokens and so two independent signals; `inject-neg-conn-timeout-debug`
  ("数据库连接老是超时") shares the two everyday words 连接 and 超时;
  `inject-neg-monorepo-ci-cache` ("这个 monorepo 的 CI 缓存老失效") gets one
  signal from monorepo and one from 缓存, so both `mem-monorepo` and `mem-cache`
  are injected. Together with the docker case they price the "two independent
  tokens" rule at 4 in 99 instead of 1 in 95.
- `inject-neg-docker-image`: "容器里怎么装 nginx" injects `mem-docker-image`,
  because 容器 is a whole keyword and the query opens with it, so the
  keyword-alone rule lets it decide. This is the first labelled false positive
  since the three precision fixes, and it is the same rule that keeps
  "迁移失败后先做什么" working — the rule cannot tell 容器 as a topic from 容器
  as one word in a different task.
- `search-comp-migration-port` ("迁移 端口") and `search-comp-cache-timeout`
  ("缓存 超时") find nothing: the index is AND-combined, so naming two topics
  in one query requires a single memory carrying every token. Gathering across
  topics needs one search per topic, which the runner does not yet model.
- The five older misses still stand: three inject composition rows
  (`hand-b3-comp-port-deploy`, `hand-b3-comp-monorepo-i18n`,
  `hand-b3-comp-log-stale`) and two search rows
  (`hand-b3-scomp-deploy-port-rule`, `hand-b3-scomp-pool-timeout`).

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

### Should the gather step fall back when the conjunction finds nothing?

A whole-sentence query matches nothing, and the proposal's diagnosis table has a
row for exactly that (「查询了但没命中 → 检索策略不足」). `strategies.mjs` prices the
candidate answers on every labelled row, without touching production:

```
node --import ../pi/hook.mjs ./strategies.mjs
node --import ../pi/hook.mjs ./strategies.mjs --source cases.jsonl --out out/strategies-cases.json
```

`and` is today's behaviour; `or` is the same search with `mode: "any"`; `split`
searches each whitespace-separated term alone and unions the hits; the
`and_then_*` rows only fall back when the conjunction returns nothing, and the
`hotspot` variants fall back to the matcher the inject surface already uses
(`matchHotspots` over the project pool, `min_score` shown in the name). "Noise
beside a hit" counts ids dragged in next to a hit, which is what a user
notices as clutter even when nothing was forbidden.

Every labelled row (297 positive, 117 negative):

| strategy | all expected | noise beside a hit | negative leaks | fallback fired | search calls |
| --- | --- | --- | --- | --- | --- |
| and | 99/297 | 10 (9 rows) | 0/117 | 0 | 414 |
| or | 283/297 | 2070 (265 rows) | 95/117 | 0 | 414 |
| split | 140/297 | 79 (48 rows) | 18/117 | 0 | 920 |
| and_then_split | 138/297 | 42 (23 rows) | 18/117 | 116 | 920 |
| and_then_or | 281/297 | 1507 (180 rows) | 94/117 | 116 | 414 |
| and_then_hotspot | 269/297 | 52 (49 rows) | 19/117 | 116 | 414 |
| and_then_hotspot_2 | 266/297 | 52 (49 rows) | 17/117 | 116 | 414 |
| and_then_hotspot_3 | 248/297 | 20 (19 rows) | 11/117 | 116 | 414 |

Hand-confirmed rows only (`--source cases.jsonl`, 54 positive, 38 negative):

| strategy | all expected | noise beside a hit | negative leaks | fallback fired | search calls |
| --- | --- | --- | --- | --- | --- |
| and | 21/54 | 0 (0 rows) | 0/38 | 0 | 92 |
| or | 54/54 | 396 (51 rows) | 32/38 | 0 | 92 |
| split | 28/54 | 9 (6 rows) | 3/38 | 0 | 176 |
| and_then_split | 27/54 | 8 (5 rows) | 3/38 | 37 | 176 |
| and_then_or | 53/54 | 265 (31 rows) | 31/38 | 37 | 92 |
| and_then_hotspot | 50/54 | 8 (8 rows) | 6/38 | 37 | 92 |
| and_then_hotspot_2 | 47/54 | 8 (8 rows) | 5/38 | 37 | 92 |
| and_then_hotspot_3 | 46/54 | 3 (3 rows) | 2/38 | 37 | 92 |

Four things this says, and one thing it does not:

1. `or` is not a retrieval strategy. It answers 32 of 38 negative rows with a
   memory, because "any token" makes near-miss questions look like hits — a
   memory that shares 日志 with a question about log levels now gets delivered.
2. A fallback fires on 37 of 38 negative rows, and that is structural rather
   than a tuning problem: negatives are negative precisely because they share no
   whole token with a memory, so the conjunction is empty on all of them and any
   fallback gets to decide. Falling back means deciding *without* the evidence
   the AND query relies on.
3. The best fallback is a real offer, not a strawman: `and_then_hotspot_3`
   recovers 25 of the 33 literal misses (21/54 → 46/54) while leaking 2 of 38
   negatives (5.3%) and adding 3 noise ids. That is the trade the proposal's
   「检索策略不足」 row is actually about, stated as a rate: one question in
   nineteen that should have stayed quiet gets a memory, in exchange for more
   than doubling what the agent can find by itself.
4. It still does not land, and the reason is now a specific missing number
   rather than a preference: the decision needs the cost asymmetry — what a
   wrong delivered memory costs the agent versus what a missed one costs — and
   nothing here measures that. What the set does say is that 22 hand-checked
   negatives could not separate 0/22 from 11/117 while 38 can show the rate is
   about one in twenty, so the label set was the deciding instrument and it
   still needs the harm side. In the meantime the shipped path is the one that
   spends on a second attempt instead of on a looser first one: the model-driven
   rewrite in "Query expansion" recovers 50 of 52 literal misses for $0.0103,
   only on turns that came back empty, and the empty-result hint tells the agent
   to retry with 1-3 words before it gives up.

The first two rows of the hand-confirmed table are also worth reading as a
precision statement: `and` finds 21 of 54, so a third of this dataset cannot be
answered by the lexical layer at all — that is the denominator the resolver is
filling, and why its expansion was measured separately rather than assumed.

### What a wrong or irrelevant delivery costs the answer

Counting a leak says retrieval delivered something it should not have. It does not say whether the answer got worse, and that is the half of the gather-step trade the section above could not supply. `trigger.mjs` measures it end to end: a scenario may name `contaminated_by: <memory-id>`, and after the turn the judge is shown the question, the answer and the memory that was in context, and asked for `{"carried": bool, "harmed": "yes"|"no"|"unclear", "why": ...}`. `carried` means the answer reused the memory's content; `harmed` means that reuse made the answer incorrect or misleading, while merely adding an irrelevant line is `unclear`. The judge never sees a label, one call per graded turn is spent, and `--no-judge` turns it off.

| scenario | shape | turns | carried | harmed=yes | unclear | cost |
| --- | --- | --- | --- | --- | --- | --- |
| `quiet-docker-nginx` (容器里怎么装 nginx？) | near-miss, unrelated subject | 8 | 3 | 0 | 2 | $0.0089 |
| `conflict-deploy-port` (部署脚本默认端口是多少？) | conflicting values, same subject | 3 | 3 | 0 | 0 | $0.0056 |

`quiet-docker-nginx` is the one false positive the hotspot layer produces on the labelled set (`inject-neg-docker-image`), because the question starts with 容器, a whole keyword of `mem-docker-image`, so the memory is injected before the agent speaks. `conflict-deploy-port` injects `mem-deploy-port` together with both 端口约定 memories, which disagree about 8080 against 18080.

Readings:

1. A near-miss delivery does not turn into a wrong answer on its own: the model ignored it in 5 of 8 turns, and where the judge saw the content reused it was a closing paragraph about image tags, not a corrupted answer. So the 1-in-19 leak rate above is a noise rate, not a correctness rate.
2. The expensive shape is a same-subject conflict, but the cost is a refusal rather than a wrong value: all 3 turns answered that the port could not be confirmed, because the two records are parallel and carry nothing (time, commit, revision) that would let one supersede the other. `mem-deploy-port` was in the same context. This is the 多条记忆冲突 → Conflict Resolution row of the diagnosis matrix. It is not a matching question; the experiment below settles whether it is a presentation question or a data one.
3. The `fact` check is a substring test, so all 3 conflict turns count as `hit` with `used=true` (18080 appears in the answer). Only the judge shows that the conclusion was "unknown". Read the two together; a `hit` alone does not mean the question was answered.

Both shapes are method plus baseline: 8 and 3 turns cannot set a rate.

### Can the agent settle a contradiction?

The reading above left one question open: with two memories disagreeing about the
same subject, is the gap in what the agent is shown (no ordering evidence in the
block) or in what the store knows (nobody ever recorded which value superseded
which)? The product already has a place to record that — a pending stale event —
so the experiment is to record the supersession and ask the same question again.
`--stale-port-rule` does exactly that: it marks the older `mem-port-rule-a`
stale with the later evidence (「2026-11-18 的评审把端口约定改成 18080，旧的 8080
仅保留一周」) and leaves everything else — retrieval, injection, the question —
unchanged. `decided_fact` is what makes the outcome visible: a scenario may name
it, and the judge is asked whether the answer committed to one value or listed
candidates and gave up, because a substring test cannot tell those apart.

| arm | turns | committed to 18080 | refused (no single value) |
| --- | --- | --- | --- |
| no supersession recorded | 3 | 0 | 3 |
| supersession recorded (`--stale-port-rule`) | 3 | 2 | 1 |

```sh
node --import ../pi/hook.mjs ./trigger.mjs --only conflict-deploy-port --repeats 3 --out out/decide-baseline.json
node --import ../pi/hook.mjs ./trigger.mjs --only conflict-deploy-port --repeats 3 --stale-port-rule --out out/decide-stale.json
```

The two committed answers are not guesses; each one lays out the evidence
(`mem-port-rule-b` 18080 现行, `mem-port-rule-a` 8080 with **STALE** and the recorded
later evidence, `mem-deploy-port` recording only that the two must change
together) and then treats the stale event as the later fact that supersedes the
older record: 「这是一次已生效的后续变更，按规则它取代较早的 8080」. The third turn
still refused, and its answer explains why in a way that is itself a finding: it
reports the freshness of `mem-deploy-port` (current, no pending) and never
mentions `rule-a`'s stale event, so it either read the wrong memory or ignored
the marker — reading the pending detail is a second, separate decision.

What this is worth: the fix for a same-subject contradiction is in the data, not
in presentation — record which record superseded which (the stale event does it
today, without new schema) — and the retrieval layer's `conflicted` status plus
per-entry freshness is enough for the agent to reason about it once the data says
so. What it is not: a rate. Three turns per arm, one question, one day, and
gateway contention made the latencies in these two reports useless (p50 ≈ 260 s);
do not quote a timing from them. A follow-up worth having is the same A/B on a
sharper question where the answer cannot be reasoned out from the rules alone,
and a cheaper variant that asks the agent only to read the memory and report its
freshness.

### Archived memories

`mem-archived` is reachable on the search surface even without
`include_archived`: once Active comes back empty the Archived layer runs as
`fall_through` and can return a card (`status=partial`). Injection never
surfaces an archived memory. A query that overlaps an archived nav text only
through non-adjacent bigram fragments — the fragment `旧版格式` against
`旧版配置格式` — matches nothing, which is the overlap rule, not an archive
policy.

## One trace per turn

`trace.mjs` joins the three real-turn artifacts into one record per agent turn:
what the hotspot layer would have offered (`replay.mjs` reconstructs it), what
the agent did (`out/trigger.json`), and what the judge said about the answer
(`out/usage.json`, optional). The result is the chain the proposal describes —
trigger, hotspot, delivery, usage, cost — as a single JSON per turn, plus the
rescue rate measured on real turns rather than on a fixture.

```sh
node --import ../pi/hook.mjs ./trigger.mjs --repeats 2   # 24 turns
node --import ../pi/hook.mjs ./usage-from-trigger.mjs
node --import ../pi/hook.mjs ./usage.mjs --cases out/usage-from-trigger.jsonl
node --import ../pi/hook.mjs ./trace.mjs
```

A 24-turn run on `CATALOG_VERSION` 5, `magpie/auto/deepseek-v4.1-flash` with the
resolver model wired:

| reading | value |
| --- | --- |
| turns / recall turns | 24 / 16 |
| hotspot injected | 8 (the four warm scenarios, twice) |
| delivery reached the model | 15 (8 warm + 7 of 8 cold) |
| rescue rate over the 8 cold turns | 0.875 |
| attributed failures | trigger 0, retrieval 1, usage 0 |
| should-recall / active retrieval | 0.938 / 0.813 |
| usage-miss rate | 0.063 |
| over-trigger rate | 0.500 |
| cost | $0.024278 total, $0.001619 per hit |
| p50 / p95 | 16.1 s / 39.2 s |
| stale misuse | 0.000 over 2 graded turns |

The rescue rate answers the proposal's question about `Archived`/`Obelisk` rescue
on the real pipeline: the hotspot layer offered nothing on eight turns and seven of
them still ended with the fact in the answer, because the agent looked it up. And
the one retrieval miss is a cold turn where both `memory_search` and
`memory_resolve` were called and nothing ever reached the model — with the same
question succeeding on other runs, so it is resolution variance rather than a
permanent gap (the image-tag coverage gap that used to live here was fixed by
giving that memory the words users say; see "A coverage gap the trigger harness
found").

The stale row is the proposal's Stale Misuse question measured on the agent.
`mem-stale-ttl` carries 30 minutes while a pending event moves it to 15: both
stale-timeout turns called `memory_read`, read the pending detail, and answered 15
while saying 30 was superseded, so the ⚠ marker plus the read tool do carry the
newer value end to end. Naming the superseded value is not counted as misuse —
only an answer that carries 30 *instead of* 15 is.

The over-trigger rate is the least stable number in this directory, because it
moves with the scenario mix and the sample size. Measured one scenario at a time,
three repeats each:

| quiet scenario | over-trigger |
| --- | --- |
| `quiet-readme-heading` (rename a heading) | 1/3 |
| `quiet-explain-index` (explain an index) | 0/3 |
| `quiet-hello-world` (hello world) | 1/3 |
| `quiet-enoent` (raw ENOENT error) | 1/3 |
| total | 3/12 = 0.250 |

Every trigger was a single `memory_search` on a question the store cannot answer,
so the cost is one wasted round trip rather than a wrong answer. Two caveats for
anyone reading these runs: their p95 numbers (117–202 s) are contaminated by three
harness runs sharing one gateway at the same time — latency belongs to a solo run
— and 8 of these 12 turns produced a full answer, so `clean` means "did not
search", not "was fast".

## Shadow view of a real session

The sections above score cases someone wrote down. A real run knows something
the labelled set cannot: what the agent did with the block it was handed. The
extension already writes that to `VESTIGIO_DECISION_LOG`
(`packages/pi-extension/src/decision-log.ts`) whenever the path is set, and the
log is diagnostics-only by construction — ids, counts, statuses and timings,
never query text or memory bodies, and a failing write stops after five attempts
instead of touching the turn. `shadow.mjs` reads that file and joins each turn's
plan, tool calls and results into one trace:

```
node ./shadow.mjs --log ~/.vestigio/decisions.jsonl --sample 0.1
```

`--sample` keeps a deterministic subset (sha256 of `session:input_id`), and
`--max-turns` caps the number of turns reported, so both the sampling rate and
the report size are knobs on the reader — production neither knows nor waits.

What it reports needs no label: whether a turn with a delivered block then called
a tool, whether it read a body, whether a turn with nothing delivered searched
anyway, the share of gather calls that returned nothing, resolver statuses and
degradation, the most-injected memories, and the `input` handler's p50/p95.

Measured on three real turns produced by `trigger.mjs --decision-log <path>`:

```
3 turns (3 sessions, sample 1): 1 injected
  after injection: tools 100.0%, body read 100.0%
  nothing injected: unprompted search 50.0%; reasons {"no_match":2}
  gather calls 2 (search 1, resolve 1 / degraded 0), zero-hit 50.0%
  injected most: mem-docker-image×1
  input handler p50 5.77ms p95 6.37ms
```

The cold turn's trace shows the whole chain in a production artifact:
`no_match → tool_search(not_found, cards=0) → tool_resolve(resolved, mem-conn-pool)
→ tool_read(=mem-conn-pool)`. The injected turn is the false positive described in
"What a wrong or irrelevant delivery costs the answer" (容器里怎么装 nginx), and
it shows a cost that counting a leak cannot: because the block was delivered, the
agent spent an extra `memory_read` pulling the irrelevant body into context. So a
false positive can be priced as one extra read plus its tokens, independently of
whether the judge thinks the answer got worse.

Limits: `shadow.mjs` has no labels, so it reports no recall — that stays with
`run.mjs` and `trace.mjs`; the three turns above validate the pipeline, not a
rate; and a decision log only exists when the operator opts in.

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

`--baseline=<git-ref>` skips the first step by reading
`eval/memory/baseline.json` out of that revision with `git show`, so the current
worktree can be diffed against any commit without checking it out:

```sh
node --import ../pi/hook.mjs ./run.mjs --out out/report.json
node ./compare.mjs --baseline=HEAD~1 out/report.json
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

Three of those belong to the other two harnesses rather than to this one: agent
turns and Trigger Miss are `trigger.mjs`'s job (including `usage_miss`,
`stale_misuse` and per-turn latency and cost), and a real session's own trace is
`shadow.mjs`'s — see "Trigger evaluation" and "Shadow view of a real session".
