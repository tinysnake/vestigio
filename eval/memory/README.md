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

`cases.jsonl` has one case per line, 52 of them at `CATALOG_VERSION` 4.
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
`miss (retrieval_miss)` to `hit hit`, and the 52-case offline baseline is
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
only project knowledge available is memory. Twelve scenarios:

- four **warm** — deploy port, migration rollback, cache invalidation, a timeout
  that changed. The hotspot layer injects a block, so answering means reading it.
- four **cold** — a connection limit, log retention, an image tag, secret
  rotation, all phrased so that `planInjection` matches nothing. Only a
  deliberate search can answer them.
- four **quiet** — rename a heading, explain an index, hello world, an ENOENT
  error. Any memory call here is noise.

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

That left the baseline at zero false positives on the 18 cases of the time, which is a small
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
