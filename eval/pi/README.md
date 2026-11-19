# eval/pi — PR-05 hotspot reminder harness

Drives the real `pi` binary (1.5.2) against a local mock provider and asserts on
the **wire request bodies** — the final user message text pi actually sent — not
on the extension's own logs.

Everything it writes lives under `/tmp/vestigio-pi`:

- `agent/` — an isolated `PI_CODING_AGENT_DIR`, so the operator's own
  extensions, settings and sessions are never loaded (`--no-extensions` is passed
  too, and the extension under test is loaded explicitly with `-e`).
- `sessions/`, `run.sqlite`, `seed.sqlite`, `decisions-*.jsonl`,
  `obelisk-home/` — the session dirs, the isolated memory store, the isolated
  history home, and one decision log per scenario.

The operator's real history index (`/Users/snake/.obelisk/obelisk.sqlite`) is
only ever `stat`-ed for its mtime; the run asserts the mtime is unchanged. The
extension is given an explicit `VESTIGIO_OBELISK_HOME` (the equivalent of
`--obelisk-home`) pointing at an empty temp directory, so it can never fall back
to the real index.

No real provider is contacted: `models.json` points the `mock` provider at
`http://127.0.0.1:8799/v1`, which the harness serves in-process.

## Run

```sh
cd eval/pi
node --import ./hook.mjs ./run.mjs              # all scenarios + performance
node --import ./hook.mjs ./run.mjs --only new_session # memory delivery only
node --import ./hook.mjs ./run.mjs --only stale # complete stale lifecycle
node --import ./hook.mjs ./run.mjs --only steer # steering only
node --import ./hook.mjs ./run.mjs --dump new-session   # raw wire bodies
VESTIGIO_HARNESS_DEBUG=1 ...                    # print every RPC event type
```

The harness resolves the source checkout from its own location, so it also works
inside a worktree. Run one copy at a time; the scratch directory and mock-provider
port are shared. Unknown `--only` filters fail instead of reporting a pass with no
scenario assertions.

`hook.mjs` maps `@vestigio/core*` onto the workspace source and rewrites
NodeNext `./x.js` specifiers to `.ts`, so the harness needs no `node_modules` of
its own. `seed.mjs` writes the fixture store:

```sh
node --import ./hook.mjs ./seed.mjs <store.sqlite> <project_id> <perf_project_id>
```

`env.sh` exports the same environment for ad-hoc `pi` runs.

## What is asserted

| Scenario | Assertion |
| --- | --- |
| `new_session` | block injected at the tail of the user message; no medium body, no cross-project content; system prompt unchanged; repeat turn injects nothing; exactly one block per session |
| `continue` | resumed session (`--continue`) does not re-inject |
| `compaction` | post-compaction turn does not re-inject |
| `prompt-template` | template expansion intact, no block, decision reason `slash_command` |
| `skill-command` | skill expansion intact, no block, decision reason `slash_command` |
| `queued` | a `follow_up` while streaming injects its own memory, never the base one |
| `steer` | a `steer` while streaming injects its own memory at the tail |
| `handler-error` | a second extension throwing from `input` still lets the block through intact; no truncated or duplicated block |
| `stale` | completed tool evidence triggers `agent_end` marking; the same pass absorbs the change; explicit marking resolves real entry IDs; a change that arrives after the pass defers its read, and a later session reads the repaired memory without another repair |
| `perf-*` | baseline with the extension disabled, matching-off cost, full-match p50/p95, added tokens per turn, zero repeated blocks |
