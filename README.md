# vestigio

Low-cost layered memory system for coding agents. v1 plugs into
[`pi-agent`](https://github.com/earendil-works/pi) (pi 1.5.2). The main agent
queries memory when it needs to; the system keeps verifiable historical sources
and bounds the cost of organizing and reading them.

This checkout currently contains **PR-01**: the frozen core contracts and the
repo scaffold that every later stage is verified against. There is no storage
engine or pi extension yet.

## Layout

```
packages/core/src/contracts/   type shapes, boundary parsers, identity helpers
packages/core/test/            contract tests
eval/fixtures/                 synthetic retrieval corpus (JSONL)
eval/baseline/                 no-memory vs Obelisk resource ledger
eval/memory/                   offline recall/injection eval with baseline diff
eval/requests/                 actual-model free-choice eval for operator-approved saves
docs/contracts.md              the frozen shapes, rules and compatibility range
docs/*.md                      requirements, plan and research notes
```

## Requirements

- Node `>=22.5` (verified on v26.13.0, the node that runs pi 1.5.2)
- pnpm (verified on 10.33.0)

SQLite at runtime comes from the Node built-in `node:sqlite` (PR-02); there is
no third-party SQLite driver. `packages/core` has **zero runtime
dependencies**.

## Commands

```sh
pnpm install
pnpm -C packages/core test        # vitest
pnpm -C packages/core typecheck   # tsc --noEmit
pnpm test                         # workspace-wide
```

Baseline harness (writes `eval/baseline/out/`):

```sh
node eval/baseline/run.mjs --question "记得之前定过记忆层用哪个 SQLite 驱动吗"
```

Memory eval (runs 12 labeled cases, then diffs against the committed baseline):

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs && node ./compare.mjs baseline.json out/report.json
```

## Contracts

`docs/contracts.md` is the reference. In short: every boundary shape has a
`parse*` function that rejects malformed data with a `ValidationError`; medium
bodies are 500–1000 non-whitespace Unicode code points; nav text is at most 200
code points; enums reject unknown strings; injection receipts dedupe on
`(session,, branch_ref, input_id, memory_id)`; usage event ids are deterministic
from the event's own fields.
