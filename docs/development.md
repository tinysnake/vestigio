# Development

## Layout

```
packages/
  core/           memory model: storage, retrieval, hotspots, stale, contracts, jobs
  config/         config file, defaults and environment variables
  model-client/   OpenAI-compatible client used for vestigio's own calls
  source-obelisk/ Obelisk history port
  daemon/         job daemon, scheduler and HTTP service
  client/         client library that starts the daemon and talks to its endpoint
  cli/            `vestigio` command, and the MCP entry point
  pi-extension/   the pi extension: tools, command, activity panel
scripts/          deploy and verification scripts
eval/             evaluation harnesses (see below)
docs/             this documentation set
```

`packages/core` has no runtime dependencies. Every other package depends on it by workspace name, except `packages/client`, which depends on `packages/daemon`. `packages/pi-extension` declares `@earendil-works/pi-coding-agent` as a peer and pins it to `1.5.2` for development, the version this tree is tested against. See [contracts.md](contracts.md) for the compatibility range and the frozen boundary shapes.

## Requirements

Node 22.5 or newer and pnpm. Windows, macOS and Linux all work: the scripts choose the platform's CLI invocation and process listing on their own. Install once from the repository root:

```sh
pnpm install
```

## Commands

| Command | Does |
| --- | --- |
| `pnpm lint` | Runs `node scripts/lint-daemon-lifecycle.mjs`. |
| `pnpm typecheck` | Type-checks every package. |
| `pnpm test` | Runs every package's tests, then `node --test eval/memory/compare.test.mjs`. |

## Verification

```sh
node scripts/verify-all.mjs            # every gate
node scripts/verify-all.mjs --fast     # skip the pi harness
node scripts/verify-all.mjs --only test,smoke
node scripts/verify-all.mjs --pi-filter stale
```

The gates run in this order: `lint`, `typecheck`, `test`, `memory`, `compare`, `smoke`, `pi`.

| Gate | Runs |
| --- | --- |
| `test` | `pnpm test`. |
| `memory` | `eval/memory/run.mjs`, the offline labeled evaluation. |
| `compare` | `eval/memory/compare.mjs baseline.json out/report.json` against the committed baseline. |
| `smoke` | `scripts/daemon-smoke.mjs`, the daemon lifecycle check. |
| `pi` | `eval/pi/run.mjs`, the pi harness. |

Logs land in a fresh directory under the system temp dir and survive the run. `--only` takes gate names. `compare` reads the report the `memory` gate wrote, so name both or run them in order.

The `pi` gate drives a real pi against a local mock provider and asserts the wire request bodies. It also asserts that the operator's real Obelisk index is untouched, so `verify-all.mjs` refuses to start it while another Obelisk process is alive:

```
an obelisk process is running; the pi gate asserts the real index is untouched, so wait for it to exit
```

Two standalone checks:

```sh
node scripts/verify-doctor.mjs   # read-only: is this checkout worth driving?
node scripts/daemon-smoke.mjs    # temp store. start on search, stop removes the endpoint
node scripts/verify-deploy.mjs   # deploy leaves a runnable command behind (a .cmd shim on Windows)
```

For scripted verification of a running app, use [.agents/skills/verify-vestigio/](../.agents/skills/verify-vestigio/SKILL.md). It names the harness for each user-facing feature and what a proof has to capture.

## Evaluation harnesses

| Harness | Runs against | Command |
| --- | --- | --- |
| `eval/memory` | Nothing. Offline and seeded. | `cd eval/memory && node --import ../pi/hook.mjs ./run.mjs` |
| `eval/pi` | Real pi 1.5.2, local mock provider. | `cd eval/pi && node --import ./hook.mjs ./run.mjs --only <scenario>` |
| `eval/requests` | Real pi, real coding model. | `cd eval/requests && node --import ../pi/hook.mjs ./run.mjs --dry-run` first, then without the flag |
| `eval/resolver` | Real CLI, real model client, real Obelisk. Opt-in. | `cd eval/resolver && VESTIGIO_RESOLVER_LIVE=1 node --import ./hook.mjs ./run.mjs` |
| `eval/live` | Real pi over the gateway, no mock. Opt-in. | `cd eval/live && node --import ../pi/hook.mjs ./run.mjs --only <scenario>` |
| `eval/baseline` | Recorded runs, one question at a time. | `node eval/baseline/run.mjs --question "<question>"` |

`eval/memory` fails only when a case errors. Quality is judged by `compare.mjs` against `baseline.json`, not by an absolute threshold. Its `usage.mjs` is the one part of that directory that calls a model, and it takes `--dry`. `eval/requests`, `eval/resolver` and `eval/live` spend real tokens against a paid gateway, so they are opt-in, and `eval/requests` and `eval/resolver` each have a dry run. Every one of them isolates its stores, sessions and Obelisk homes under a scratch directory and leaves the operator's real index alone. Keep it that way when you add a scenario.

`eval/live` reads its gateway key at runtime, from `~/.pi/agent/auth.json`, and takes its non-secret settings from `eval/live/config.local.json`, which is ignored by git. `config.example.json` is the committed template. `eval/live/runs/` and `*.log` are ignored too.

Every harness that drives pi uses `--import ./hook.mjs` or `--import ../pi/hook.mjs` to load a resolution hook. Without it, the harness runs against installed packages instead of this checkout.

## Conventions

- Keep the docs in their Diátaxis role: this page and [contracts.md](contracts.md) are reference, [operating.md](operating.md) is a how-to. Do not turn a reference page into a walkthrough.
- Prove runtime behavior with one of the harnesses above, not with a unit test over an internal setter. `scripts/verify-all.mjs` is the gate that decides whether the change is honest.
