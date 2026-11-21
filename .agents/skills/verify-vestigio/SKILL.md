---
name: verify-vestigio
description: Verify Vestigio pi extension lifecycle, memory delivery, stale updates, CLI search and daemon lifecycle through the real binaries and isolated harnesses.
---

# Verify Vestigio

## Launch

Run `pnpm install --frozen-lockfile` from the checkout root once. Nothing is built: the CLI, daemon and extension run from source through their hook files.

- CLI: `./packages/cli/bin/vestigio --help`. It is a bash wrapper; do not run it through `node`.
- Daemon: start it through the CLI (`get --job <missing>` is enough); it writes `<store>.daemon/`.
- pi harness: it starts its own loopback provider and real pi RPC process on an ephemeral port and prints `Pi scratch: <path>`. Two runs can proceed at once; keep them serial only when you compare timings.

## Doctor

Run `node scripts/verify-doctor.mjs` first whenever anything looks off. It is read-only: node/pnpm versions, CLI `--help`, pi version, `VESTIGIO_STORE`, daemons leaked by earlier checkouts, a leftover `<store>.daemon/endpoint.json`, a running `obelisk`, and worktree dirt. Warnings keep exit 0; missing tools exit 1.

`obelisk` must not run while a pi harness run is in flight. The harness asserts the real Obelisk index mtime is unchanged, and any other Obelisk command rewrites it. `scripts/verify-all.mjs` refuses to start the pi gate in that case.

## Drive

The harness copies `eval/pi/agent/` into a per-run scratch directory and rewrites `baseUrl` to the port it bound, so the real `eval/pi/agent/models.json` only needs to stay loopback-shaped. `VESTIGIO_OBELISK_HOME` must point at the empty harness home, never the real user home.

- One pi scenario: `cd eval/pi && node --import ./hook.mjs ./run.mjs --only new_session`.
- All pi scenarios: omit `--only`. The exact filter names are `new_session`, `stale`, `request`, `search_recovery`; `compound` runs only as `--only compound` and is a measurement, not a gate.
- CLI search and read: [cli-search.md](features/cli-search.md).
- Daemon lifecycle: [daemon-lifecycle.md](features/daemon-lifecycle.md).
- Every local gate: `node scripts/verify-all.mjs` (add `--fast` to skip the pi harness, `--only test,smoke` for a subset, `--pi-filter stale` for one scenario).

An unknown `--only` filter can otherwise execute no feature assertions. `--dump new-session` uses a hyphen; the filter uses an underscore.

## Evidence

`scripts/verify-all.mjs` prints a log directory under the system temp dir and keeps one log per gate; those logs are the proof. For a pi run, capture stdout/stderr and exit status into a unique directory outside the printed scratch path, such as `/tmp/vestigio-proof-<run-id>`. A pass requires the requested scenario assertions to appear, not merely `ALL CHECKS PASSED`. The harness captures actual provider request bodies and pi decision logs; inspect stored pending events/revisions for stale transitions and acknowledgement. Unit tests alone do not establish lifecycle delivery.

For the CLI journey, keep the two `--json` bodies (search and read). Mocking the external model provider is allowed; do not replace pi hooks or the extension with a mock.

## Cleanup

The pi harness closes its mock server and the pi children it started; confirm its command exited. `scripts/daemon-smoke.mjs` removes its own temp store and stops its daemon. For a daemon you started by hand, run `./packages/cli/bin/vestigio stop --db <store>`.

Do not kill by process name and do not remove the proof directory. Leaked daemons from earlier checkouts show up in the doctor output; report them instead of managing them. The printed pi scratch directory keeps its stores, decision logs and sessions for inspection; the next run gets a different one. The harness checks the real Obelisk index mtime before and after without opening it.

## Helpers

- `node scripts/verify-doctor.mjs` — read-only preflight described under Doctor.
- `node scripts/verify-all.mjs` — runs typecheck, test, memory, compare, daemon smoke and the pi harness, with per-gate logs and a timing table.
- `node scripts/daemon-smoke.mjs` — the daemon journey from start to `stop`.
