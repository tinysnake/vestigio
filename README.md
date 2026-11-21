# vestigio

Low-cost layered memory system for coding agents. v1 plugs into
[`pi-agent`](https://github.com/earendil-works/pi) (pi 1.5.2). The main agent
queries memory when it needs to; the system keeps verifiable historical sources
and bounds the cost of organizing and reading them.

This checkout holds the whole v1 path: the frozen core contracts and SQLite
store, the retrieval and staleness logic, the background daemon, the CLI, and
the pi extension that injects a reminder and exposes the memory tools.

## Layout

```
packages/core/                 store, layered search, hotspots, stale events, resolver
packages/daemon/               job scheduler, memory handlers, process lifecycle
packages/client/               daemon client: lazy start, health, jobs, events
packages/cli/                  vestigio search/read/resolve/jobs + daemon adapters
packages/pi-extension/         pi tools, injection, lifecycle hooks
eval/fixtures/                 synthetic retrieval corpus (JSONL)
eval/baseline/                 no-memory vs Obelisk resource ledger
eval/memory/                   offline recall/injection eval with baseline diff
eval/requests/                 actual-model free-choice eval for operator-approved saves
eval/pi/                       real pi lifecycle harness with a loopback provider
scripts/daemon-smoke.mjs       CLI to daemon to stop, against a temporary store
docs/contracts.md              the frozen shapes, rules and compatibility range
docs/*.md                      requirements, plan and research notes
```

## Requirements

- Node `>=22.5` (verified on v26.13.0, the node that runs pi 1.5.2)
- pnpm (verified on 10.33.0)

SQLite at runtime comes from the Node built-in `node:sqlite` (PR-02); there is
no third-party SQLite driver. `packages/core` has **zero runtime
dependencies**.

## Quick start

```sh
pnpm install
pnpm test && pnpm typecheck
node scripts/daemon-smoke.mjs     # CLI creates a store, daemon starts, stop works
```

The supported install registers the package with `pi install`. `-e` loads one
file for one run and caches it under `~/.pi/agent/tmp/extensions/`, so it is
not an install and the deploy script does not accept it as one.

`VESTIGIO_STORE`, or `store` in the config file, is the only required setting;
without it the extension stays inert. Memory retrieval and saving do not need a model, and staleness
detection and cold-search recovery stay off until `VESTIGIO_MODEL_BASE_URL` and
`VESTIGIO_MODEL_ID` are set.

```sh
VESTIGIO_STORE=$HOME/.vestigio/store.sqlite \
VESTIGIO_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
VESTIGIO_MODEL_ID=auto/deepseek-v4.1-flash \
pi -e packages/pi-extension/src/extension.ts
```

The first memory tool call starts the daemon. Its state, job database and log
live beside the store, in `<store>.daemon/` (`daemon.log`, `endpoint.json`,
`jobs.sqlite`). Stop it with `packages/cli/bin/vestigio stop --db <store>`.
There is no idle timeout: closing pi does not stop the daemon.

## Deploy locally

```sh
node scripts/deploy.mjs --model-base-url http://127.0.0.1:11434/v1 \
  --model-id auto/deepseek-v4.1-flash
```

Steps, each printed as `ok`, `skip`, `warn` or `FAIL`: `pnpm install`, write
`~/.vestigio/config.json` (keeps existing keys, adds `store` and
`logging.activity: false`), `pi install` the extension package and verify the
entry landed in the pi settings `packages` list, and link `vestigio` into
`/usr/local/bin` or `~/.local/bin`. `--dry-run` prints the plan, `--config`
and `--pi-settings` point it at another machine layout, and `--skip-install`
or `--skip-link` drop a step. A cached `-e` copy only produces a warning;
the install is confirmed by reading the settings file, not by trusting the
command's exit code.

## Activity panel

Above the editor, the extension keeps a short log of what memory did during
the session: what was injected and how large the block was, which memory a
read resolved with which revision, detector findings, stale marks and
repairs. The newest event is last. It shows only identifiers, titles, counts
and timings, the same fields as the decision log.

The panel starts hidden. `/vestigio-log on` shows it, `/vestigio-log off`
hides it, and `/vestigio-log clear` empties it; the on/off state is written to
`logging.activity` in the config file, so the next session keeps it.
`VESTIGIO_ACTIVITY` wins over the file for that session. In print mode (`-p`)
and JSON mode there is no panel.

## Configuration file

Every entry point reads the same file, `~/.vestigio/config.json`. It fills the
`VESTIGIO_*` settings below. A command-line flag, then an environment
variable, then the file, then the built-in default decides each value.

```json
{
  "version": 1,
  "store": "~/.vestigio/store.sqlite",
  "model": {
    "base_url": "http://127.0.0.1:11434/v1",
    "id": "auto/deepseek-v4.1-flash",
    "api_key": null,
    "thinking": "low"
  },
  "retrieval": { "budget_bytes": 4096, "max_memories": 3, "min_score": 1, "pool_capacity": 32, "timeout_ms": 1000 },
  "history": { "obelisk_home": null, "obelisk_cli": null },
  "logging": { "decision_log": null, "activity": false }
}
```

`VESTIGIO_CONFIG` points at a different file, and an empty value disables the
file. A relative path in the file resolves against the file's directory.
Unknown keys and wrong types are errors. Requests to `model.base_url` carry a
`user-agent` naming the caller (`vestigio/resolver`, `vestigio/extraction`,
`vestigio/detector`, `vestigio/nav`), so a gateway can attribute usage per
agent. A process reads the file when it
starts, so a running daemon keeps the values it started with; `vestigio stop
--db <store>` and the next tool call pick up an edit.

## Commands

```sh
pnpm install
pnpm -C packages/core test        # vitest
pnpm -C packages/core typecheck   # tsc --noEmit
pnpm test                         # workspace-wide, includes the compare gate
```

Baseline harness (writes `eval/baseline/out/`):

```sh
node eval/baseline/run.mjs --question "记得之前定过记忆层用哪个 SQLite 驱动吗"
```

Memory eval (runs 99 labeled cases, then diffs against the committed baseline):

```sh
cd eval/memory
node --import ../pi/hook.mjs ./run.mjs && node ./compare.mjs baseline.json out/report.json
```

`compare.mjs` exits 1 on a regression and 2 when the reports are not comparable
(different dataset or catalog, a missing or added case id, duplicate ids). Pass
`--exploratory` to print the diff without enforcing those input checks.

Write coverage of a store the product filled, using the durable rows in
`coverage.jsonl`:

```sh
cd eval/memory
node ./coverage-store.mjs --store ~/.vestigio/store.sqlite --project "$PWD/.." --out out/coverage-store.json
```

It copies the store to a temp directory first, because the CLI opens stores
read-write and runs migrations. Your live file is never touched; a mistyped
path fails instead of creating a new empty store.

`resolution.mjs` pins the resolver's own branches with a scripted judge (seven
cases, no network). Model-backed evals in the same directory: `usage.mjs` (was
the injected memory used?), `rescue.mjs` (does query expansion recover a lexical
miss?), `trace.mjs` (one joined record per turn: trigger, hotspot, delivery,
usage, cost), `trigger.mjs` (does the agent look things up at all, and does it use
what it was given?), `strategies.mjs` (what would a gather fallback buy?), and
`shadow.mjs` (a real session's decision log, joined into one trace per turn — ids
and hashes only, no query text), `stability.mjs` (how often a scenario flips
between repeats, read from an existing trigger report).

## Contracts

`docs/contracts.md` is the reference. In short: every boundary shape has a
`parse*` function that rejects malformed data with a `ValidationError`; medium
bodies are 500–1000 non-whitespace Unicode code points; nav text is at most 200
code points; enums reject unknown strings; injection receipts dedupe on
`(session,, branch_ref, input_id, memory_id)`; usage event ids are deterministic
from the event's own fields.
