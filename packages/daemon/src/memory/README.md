# Daemon memory surface

The three Vestigio agents, moved behind the daemon's job queue. The daemon owns
the store, the model calls and every write; the client owns the session identity,
the evidence it gathered and the ledger it carries.

`contract.ts` is the public wire schema — operation names, per-operation inputs
and validators — with **no runtime imports**, so a client can import it without
loading `@vestigio/core`, `@vestigio/model-client` or `@vestigio/source-obelisk`.
`index.ts` re-exports it together with `createMemoryHandler(storePath)`, the
factory `entry.ts` calls.

## Operation table

| operation | job kind | legacy pi equivalent | writes |
| --- | --- | --- | --- |
| `memory.search` | search | `memory_search` tool | no |
| `memory.read` | search | `memory_read` tool | no |
| `memory.resolve` | search | `memory_resolve` tool | no |
| `request.status` | search | `memory_request_status` tool | no |
| `hotspot.plan` | search | `input` hook, plan half | no |
| `detector.run` | detector | `agent_end` stale detector | no |
| `stale.publish` | maintenance | `memory_mark_stale` tool + detector publication | yes |
| `resolve.persist` | maintenance | `memory_resolve` persistence half | yes |
| `nav.run` | maintenance | inline `publishRevision` | yes |
| `repair.memory` | maintenance | read-time repair (`read-repair.ts`) | yes |
| `repair.memories` | maintenance | `agent_end` background repair | yes |
| `request.write` | maintenance | `memory_request_write` tool | yes |
| `request.process` | maintenance | `agent_end` request processing | yes |
| `hotspot.commit` | maintenance | `input` hook, commit half | yes |
| `session.input` | maintenance | `input` hook, plan + commit in one job | yes |
| `usage.search_hits` | maintenance | `recordSearchHits` after a search | yes |
| `usage.memory_read` | maintenance | `recordMemoryRead` after a read | yes |

`OP_KINDS` is the source of truth; `kindOfOp(op)` returns it and the handler
rejects a job whose `kind` cannot carry its operation.

## Reads, writes and deferred dependencies

A read or a detector never writes. Every write it would otherwise perform comes
back as a deferred dependency in the result:

```json
{ "op": "memory.search", "kind": "search",
  "result": { "...": "the search outcome" },
  "text": "memory_search(...) -> ...",
  "deferred": [{ "op": "usage.search_hits", "kind": "maintenance",
                 "status": "enqueued", "jobId": "…", "input": { "...": "..." } }],
  "notes": [] }
```

The handler receives `(job, signal, control?)`.

- With a control plane, `control.defer(kind, input)` submits a **durable child
  job** under the parent; the parent records its own result, yields its slot, and
  finishes after the children settle. A slow write therefore never widens the
  read or detector slot's concurrency, and never blocks the parent's answer.
- Without a control plane the dependency is still reported: a dependency raised
  from inside an already-serialized maintenance job runs **inline** (`status:
  "inline"`); one raised from a read or a detector stays **unscheduled**
  (`status: "pending"`, `jobId: null`) so a caller can enqueue it itself.

`inline` is a classification, not a convenience: only the maintenance slot is a
legal place to write, so a read and a detector never execute one in place.

The two follow-ups that must land in the same boundary are declared that way:
`memory.resolve` returns `pending_persistence` and a `resolve.persist`
dependency; `resolve.persist` returns a `nav.run` dependency for the revision it
saved. Both are maintenance jobs, so a maintenance parent yields to its own
children.

## Result envelope

`MemoryJobResult` is what the daemon stores as the job result:

```ts
{ op, kind, result, text, deferred, notes }
```

`result` is the operation's JSON payload (the same fields the pi tool put in
`details`), `text` is the legacy tool text where the operation maps to a tool,
and `deferred`/`notes` record what was scheduled and what degraded (missing
model, missing history adapter, rejected stale event).

## Runtime

`openMemoryRuntime(storePath, options)` opens the store and resolves the model
and history adapter from the environment:

| env | meaning |
| --- | --- |
| `VESTIGIO_STORE` | store path (else the daemon passes it) |
| `VESTIGIO_PROJECT_ID` | default project for operations that omit one |
| `VESTIGIO_MODEL_BASE_URL` / `VESTIGIO_MODEL_ID` / `VESTIGIO_MODEL_API_KEY` / `VESTIGIO_MODEL_THINKING` | model client |
| `VESTIGIO_OBELISK_HOME` / `VESTIGIO_OBELISK_CLI` | read-only history adapter (absent → no history) |

An unconfigured model degrades exactly like the extension: reads still answer,
writes that need a model report `missing`/`model_not_configured` instead of
writing a partial model result. Daemon agents use explicit cancellation and
retain call-count and token limits. Their execution has no wall-clock deadline.

## Compatibility notes

- Tool params and result details keep their pi names (`query`, `include_archived`,
  `uri`, `revision`, `question`, `include_history`, …); `memory_mark_stale`'s
  four params become one `stale.publish` event (`producer: "agent"`), and the
  detector's findings become the same event shape (`producer: "detector"`).
- `memory_mark_stale`'s guards moved with the logic: URI/store-id/project checks
  live in the caller's operation, the unanchored-value guard lives in
  `stale.publish` so both producers get it.
- The legacy renderers (`renderSearch`, `renderResolve`, `renderRead`,
  `renderFreshness`, `unanchoredValues`) are ported into `render.ts` rather than
  imported from `pi-extension`, because the daemon must not depend on the
  extension package. A later change can lift them into `@vestigio/core` and have
  both call one copy.
- `session.input` is the whole `input` hook in one maintenance job, for clients
  that cannot hold an `InjectionLedger` between plan and commit. It returns
  `{ action, text, plan, commit }`.
