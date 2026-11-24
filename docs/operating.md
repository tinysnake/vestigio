# Operating vestigio

## The daemon

The daemon owns job scheduling, model calls and delivery. The extension, the CLI and the MCP adapter are clients of it. The first memory tool call starts it, and no client needs to start it by hand. There is no idle timeout, so closing pi does not stop the daemon.

The daemon keeps its runtime state next to the store, in `<store>.daemon/`:

| File | Content |
| --- | --- |
| `endpoint.json` | Port, bearer token, protocol version and instance id. Written with mode 0600. |
| `lock.sqlite` | Single-instance lock. |
| `jobs.sqlite` | Job queue and delivery state. |
| `daemon.log` | Daemon stdout and stderr. |

A client call reads `endpoint.json` and asks `http://127.0.0.1:<port>/v1/health` with the bearer token and a 500 ms deadline. If no live daemon answers, the client spawns a detached `node --import @vestigio/daemon/hook @vestigio/daemon/entry <store>` and waits for `endpoint.json` to appear. The daemon serves loopback only, and it answers 403 to any request whose `Host` header is not its own address or that carries an `Origin` header.

Stop it with:

```sh
vestigio stop
```

The command reads `endpoint.json`, asks that daemon to stop, and prints `stopped=true` or `stopped=false`. Use it rather than removing `endpoint.json`: the file is the only handle to the running process. If a start never became ready, the error names the log: `Vestigio daemon did not become ready. See <store>.daemon/daemon.log`.

The daemon reads the config file when it starts, and the model settings it uses are fixed for its lifetime. Stop it before you change a setting it reads. A client that finds a daemon speaking another protocol version fails with `Incompatible vestigio daemon version. Stop the running daemon before upgrading.` Stop the daemon before an upgrade, then start it again.

## Jobs

The daemon owns the work. The CLI exposes compatibility commands for callers that need to drive that work directly:

| Command | Purpose |
| --- | --- |
| `vestigio submit --source <s> --session-id <id> --kind maintenance\|detector\|search` | Queue one job. `--input` or `--input-file` carries the payload. |
| `vestigio get --job <jobId>` | Read one job. |
| `vestigio list --session-ref <n>` | List a session's jobs. |
| `vestigio cancel --job <jobId>` | Cancel a job. |
| `vestigio receive --session-ref <n>` | Claim terminal results for this process. |
| `vestigio watch --session-ref <n>` | Follow a session until its jobs end. |
| `vestigio jobs run --limit <1..20>` | Run a batch of pending jobs in this process. |

`submit` returns once the daemon has accepted the job, and the job continues without that process. `receive` and `watch` bind to the calling process: a result counts as delivered only after stdout has accepted the whole payload, so a write that fails leaves the result pending for a retry.

`--once` stops the daemon that this invocation started, after its work is done. It never stops a daemon another invocation started.

## Configuration

`~/.vestigio/config.json` holds the store path, the model endpoint and the retrieval budget. See [configuration.md](configuration.md) for every key.

## Activity panel

`/vestigio-log on` shows a panel above the editor with what memory did in the session. `/vestigio-log off` hides it. `/vestigio-log clear` empties it.

The on/off state is written to `logging.activity` in the config file, so it outlives the session. Two cases stay session-only, and the notification says which one applied: an explicit `VESTIGIO_ACTIVITY` outranks the file, and a missing config file cannot be written.

The panel is not drawn in print mode or JSON mode, where there is no editor to sit above.

## Observability audit

`eval/observability/audit.mjs` answers what happened at runtime from two places, the store tables and the JSONL streams in `<store>.observability/`. It only reads, opens the store read-only, and degrades to zeros when a table, a file or a column is missing, so it is safe to run against a live store.

```sh
node eval/observability/audit.mjs [--store <path>] [--obs-dir <dir>] [--json]
  [--since <iso>] [--project <id>] [--limit <n>] [--agent <name>] [--capacity <n>]
```

| # | Item | Question | Source |
| --- | --- | --- | --- |
| 1 | Agent runs | How many runs, how long, how many turns, which models | `agent-runs.jsonl` |
| 2 | Interface calls | Which routes the daemon served, what share succeeded, why it refused | `iface.jsonl` |
| 3 | Token spend | What the main agent and each internal agent spent | `agent-runs.jsonl`, `model.jsonl` |
| 4 | Duration | Wall time per run and per internal invocation | `agent-runs.jsonl`, `model.jsonl` |
| 5 | Memory injection | How often a memory reached a turn, and over which denominator | `turn_events`, `injection_receipts`, `project_activity`, `usage_events` |
| 6 | Memory and pool | Head revisions by state, the temporary ones, per-project occupancy | `memory_heads`, `memories`, `hotspot_memberships` |

Item 5 prints two probabilities. The turn-scoped one is `delivered / (turns - host_command)` for the rows the filters selected. The legacy one is `receipt_inputs / activity_seq` over the whole store, and it reads lower because the activity counter counts every input, including the ones deduped or unmatched. `--project` narrows the seq to the project.

`--since` reaches `agent-runs.jsonl`, `iface.jsonl`, `model.jsonl`, `turn_events` and `usage_events`. `injection_receipts` has no project column and `project_activity` has no time column, and item 6 is a snapshot. The report names every place a filter cannot reach in its notes block, so read those before comparing two filtered runs.

Item 3's internal-agent rows need `VESTIGIO_MODEL_LOG=1` on the daemon; without it that half reports no data, and the header lists every debug switch it checked. The main-agent total counts a run whose assistant message carried no `usage` under `incomplete_runs` instead of as zeros, so treat it as a lower bound.

Each stream rotates at 32 MiB per segment and 128 MiB per kind. The audit reads every `<kind>.jsonl` and `<kind>.N.jsonl` in the directory, so a segment already rotated away is simply absent from the totals.

A usage error exits 1. Missing data is a zero report, not a failure.

## Upgrade

```sh
pnpm install
vestigio stop
node scripts/deploy.mjs
```

Stop the daemon first, or the next client call fails on the protocol version.

## Uninstall

1. Remove the extension from pi. `deploy.mjs` installs it with `pi install packages/pi-extension` and records it in `~/.pi/agent/settings.json`. Remove it there, or with pi's own uninstall command.
2. Remove the `vestigio` command from the bin directory `deploy.mjs` linked it into, `/usr/local/bin` or `~/.local/bin`.
3. Remove the data. The store is at the `store` path in the config file, default `~/.vestigio/store.sqlite`, and its runtime state is in `<store>.daemon/`. The config file itself is `~/.vestigio/config.json`.

Step 3 deletes memory you have accumulated. There is no export command, so copy the SQLite file if you want to keep it.
