# Memory stale

## Sub-features

Explicit stale marking, agent-end detection, readable stale summaries, revision mismatch and selective event acknowledgement, and the end-of-session repair pass.

## How to get to it (user POV)

Read a memory, complete work that changes its topic, and use the memory maintenance tools or let the end-of-turn detector record the change. Read again to inspect the summary and pending evidence. The repair itself happens when the session ends, so a read during the session still shows the stored body with `repair: deferred`.

## Driving it with the pi harness

Run `node --import ./hook.mjs ./run.mjs --only stale` from `eval/pi`, or run the full harness. The scenario scripts the loopback provider, then drives the actual pi extension through a completed bash result, automatic end-of-turn marking and the same `agent_end` pass absorbing that change, freshness reinjection, `memory_read` returning `repair: deferred`, explicit `memory_mark_stale` with real entry ids, a staged event that outlives a pass, and a later session reading the repaired memory without another repair. It checks the memory reaches revision 4 with zero pending, that no tool hands the agent a memory writer, that no extra agent run happens, and that the real Obelisk index mtime is untouched. Core tests additionally prove selective acknowledgement, rollback, source fallback and revision races, and `packages/pi-extension/test/stale-tools.test.ts` covers the `nav_pending` rule.

## Gotchas

A stale summary stays available. Do not weaken the journey by suppressing its content or replacing actual lifecycle hooks with direct calls. No real Obelisk index or provider is needed. Repair runs at `agent_end` only, so a scenario that expects a read to write is testing the removed design: fix the assertions instead of restoring the read path. When the rendered `repair:` lines change, update the scenario text rather than the product, and let `packages/daemon/src/memory/maintenance.ts` own the pass budget and attempt semantics.
