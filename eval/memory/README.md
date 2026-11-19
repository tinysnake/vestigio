# Offline memory evaluation

Per labeled case: did the right memory surface, and did a forbidden one leak?
Two surfaces, both the real production code against a seeded throwaway store —
no mocks, no model call, no network.

- `inject`: `recordProjectInput` + `planInjection` (the extension's input path).
- `search`: `layeredSearch` with a project scope and `limit: 10`.

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
That order is why the first baseline can carry a known gap.

A full check of a change:

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs && node ./compare.mjs baseline.json out/report.json
```

## Dataset

`cases.jsonl` has one case per line; `catalog.mjs` holds the fixed 5-memory,
2-project catalog and `seedStore`. Case fields: `id`, `surface`, `project_id`,
`text`, `expected_memory_ids`, `forbidden_memory_ids`, `category`, `note`.
Changing the catalog means bumping `CATALOG_VERSION` and regenerating a baseline.

## Scoring

`surfaced_ids` is `plan.injected` memory ids for inject, and card `memory_id`s in
rank order for search. `rank` is the 1-based position of the first expected id.

Status precedence (`false_positive` outranks `miss`):

1. `error` — the surface call threw
2. `false_positive` — any forbidden id surfaced
3. `miss` — expected ids were labeled and none surfaced
4. `clean` — no expected ids labeled and nothing forbidden surfaced
5. `hit` — otherwise

Metrics use non-error cases only. `recall_at_K` and `inject_hit_rate` require a
non-empty expected set; `false_positive_rate` is over every non-error case. A
zero denominator yields `null`, never NaN.

## Known gaps in the baseline

`inject-negative-near-miss` reports `false_positive`: "旧配置的字段名" injects
`mem-deploy-port`, because the two share the bigram 配置 and the hotspot matcher
admits on that alone. The injected block is a nav hint, not a body, so the cost
is one line; it is still a precision miss and is counted in
`false_positive_rate`. Raise the case count or the match floor before treating
that rate as stable.

## Query wording

The store's default search mode is conjunctive over the normalizer's output:
unigrams and bigrams for CJK, whole words for Latin. A question fails unless
*every* one of its adjacent pairs occurs in the memory, so natural-language
questions mostly match nothing. Search cases therefore use short phrases taken
from the indexed text. This is a property of the matcher, not of the eval.

## Compare two runs

```sh
node ./compare.mjs baseline.json out/report.json
```

Matches by `case_id`, lists regressions (`hit`/`clean` → `miss`/`false_positive`/
`error`) first, then fixes, other status changes, missing and added cases. Exit
1 on any regression. Reads only the two JSON files; no store, no network.

## What this does not measure

- Model behaviour: nothing is generated, so answer quality is out of scope.
- History excerpts and the read tool: `include_history` stays off.
- Latency: `elapsed_ms` is recorded but never thresholded.
- Multi-turn dedup and concurrency: each inject case gets a fresh `InjectionLedger`
  and each run a fresh store, with fixed seeded activity, so recency stays constant.
