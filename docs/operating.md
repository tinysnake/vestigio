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
