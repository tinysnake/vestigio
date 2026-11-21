# Daemon lifecycle

## Sub-features

Lazy start on the first job command, `<store>.daemon/endpoint.json` and `daemon.log`, `get --job` replies, and `stop`.

## How to get to it (user POV)

An operator points the CLI at a store and runs a job by id; the daemon starts itself, then `stop` shuts it down.

## Driving it with the CLI

Run the repo helper:

```
node scripts/daemon-smoke.mjs
```

It creates a temporary store, proves `search` creates it, `get --job smoke-missing-job` exits 1 with `Unknown job` after starting the daemon, checks the endpoint and log files, and proves `stop` prints `stopped=true` and removes the endpoint. A pass ends with `daemon smoke passed: <store>` and exit 0.

## Gotchas

The smoke uses its own temporary store, so it never touches real project memory. `stopped=true` without endpoint removal, or an endpoint file left behind, means cleanup failed. `node scripts/verify-doctor.mjs` lists daemons leaked by earlier checkouts; report them, do not kill by process name, and stop only a daemon you started with `vestigio stop --db <your store>`.
