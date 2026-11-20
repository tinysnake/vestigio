# Daemon compatibility adapters — capability table

`docs/daemon-architecture.md` steps the migration so that the daemon owns
scheduling, model calls, memory writes and delivery, while the CLI and MCP stay
thin entry points. This file records what each adapter supports today and what
it still owes.

Neither adapter pins the caller's identity. `source`/`sessionId` are supplied by
the invoker (`--source`/`--session-id`, or the MCP tool's `source`/`sessionId`),
so a call made from pi is recorded as pi, not as `cli` or `mcp`.

## CLI

| Command | Status | Notes |
| --- | --- | --- |
| `submit` | supported | `POST /v1/jobs`. Job keeps running after the command returns; `--request-id` is the idempotency key (generated when omitted). |
| `get` | supported | Active record, full result, or compact `summary_only` record after delivery cleanup. |
| `list` | supported | Pages one session, oldest first; prints `next_cursor`. Accepts `--session-ref` or `--source`/`--session-id`. |
| `cancel` | supported | Committed effects stay committed. |
| `receive` | supported | One-shot **relay** claim: fetch without consuming, print, then `POST /v1/sessions/:ref/delivered`. |
| `watch` | supported | Polls relay claims until `--count` is reached or the process is signalled. Never uses the SSE stream (see "Delivery" below). |
| `stop` | supported | Graceful daemon shutdown; the state directory survives. |
| `search` / `read` / `probe` / `resolve` | unchanged | Direct store reads. They do not write, so they did not need to move. |
| `jobs run` | daemon maintenance | Submits `nav.run` and waits for its result. Model configuration belongs to the daemon. |

## MCP (`vestigio-mcp`, stdio)

Protocol version `2026-07-28`; the adapter is stateless and records support in a
table because not every host can receive pushed results.

| MCP feature | Status | Notes |
| --- | --- | --- |
| `server/discover` | supported | One fixed result: `supportedVersions: ["2026-07-28"]`, `capabilities.tools`, `ttlMs`, `cacheScope`. |
| `tools/list` | supported | The five tools below. A listing alone never consumes a notification. |
| `tools/call` | supported | `isError: true` for tool-level failures; JSON-RPC codes only for protocol failures. |
| `job_submit` / `job_get` / `job_list` / `job_cancel` | supported | Mirror the CLI commands, including the `requestId` idempotency key. |
| `events_receive` | supported | Relay claim. The response carries the full results; the daemon marks them delivered only after the response is written, so an interrupted caller retries the same claim. |
| resources, prompts, completion | not supported | No such capability is advertised. |
| server-initiated push (`subscriptions/listen`) | not implemented | Clients claim with `events_receive`. No push-only host compatibility is claimed. |
| sampling, elicitation, roots | not supported | No such capability is advertised. |
| `initialize` handshake, `ping`, `logging/setLevel`, `notifications/roots/list_changed` | removed by the spec | Not implemented; requests for them fail as unknown methods. |

`kind` picks the daemon handler; `input` is that handler's own payload. Memory
jobs read `input.op` (for example `memory.search`, `memory.read`,
`detector.run`), so the adapters pass `input` through untouched and never
validate it beyond "is JSON".

Tool schema notes:

- `job_submit` requires `source`, `sessionId`, `kind`, `input`; `requestId`
  defaults to a generated UUID; `kind` is one of
  `maintenance`, `detector`, `search`.
- `job_list` and `events_receive` take `--session-ref`-style `sessionRef` **or**
  `source`/`sessionId`, never both.
- Every tool takes an optional `store`; otherwise the adapter uses its own
  `--db`/`--store`/`VESTIGIO_DB`.

## Delivery and failure semantics

Both adapters deliver in this order: **relay claim → write the full payload to
stdout → mark delivered**.

- The claim (`receive(ref, relay: true)`) asks the daemon not to auto-deliver.
- The payload is written and awaited. Only a resolved write is success.
- `POST /v1/sessions/:ref/delivered` then reclaims the notification and result.

`watch` polls relay claims instead of consuming the SSE stream, because the SSE
route marks events delivered once the response is written to the socket, which
cannot guarantee the previous step. A failed stdout write therefore leaves the
result pending for retry until it expires.

This is **not** exactly-once. A payload written but not marked delivered (the
process dies between the two steps) is redelivered, so consumers must treat a
result as at-least-once and key on `jobId`/`eventId`.

## Required wire operations

All of these already exist on `@vestigio/client`; no adapter needs a new method.

| Adapter call | Wire operation |
| --- | --- |
| `client.session(key)` | `POST /v1/sessions` |
| `client.submit(input)` | `POST /v1/jobs` |
| `client.get(jobId)` | `GET /v1/jobs/:id` |
| `client.cancel(jobId)` | `POST /v1/jobs/:id/cancel` |
| `client.list(ref, after)` | `GET /v1/sessions/:ref/jobs?after` |
| `client.receive(ref, true)` | `GET /v1/sessions/:ref/events?relay` |
| `client.relayed(ref, ids)` | `POST /v1/sessions/:ref/delivered` |
| `client.stop()` | `POST /v1/stop` |
