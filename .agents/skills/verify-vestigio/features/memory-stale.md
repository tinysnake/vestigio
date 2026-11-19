# Memory stale

## Sub-features

Explicit stale marking, agent-end detection, readable stale summaries, revision mismatch and selective event acknowledgement, plus the repair timing (`VESTIGIO_REPAIR_MODE`).

## How to get to it (user POV)

Read a memory, complete work that changes its topic, and use the memory maintenance tools or let the end-of-turn detector record the change. Read again to inspect the summary and pending evidence.

## Driving it with the pi harness

Run `node --import ./hook.mjs ./run.mjs --only stale` from `eval/pi`, or run the full harness. The scenario scripts the loopback provider, then drives the actual pi extension through a completed bash result, automatic end-of-turn marking, freshness reinjection, `memory_read`, explicit `memory_mark_stale`, process resume, and `memory_resolve` in a new session. It checks the original memory reaches revision 2 and its incorporated events are acknowledged. The run checks no extra agent run and preserves the real Obelisk index mtime. Core tests additionally prove selective acknowledgement, rollback, source fallback and revision races.

`--only stale-background` reruns the journey with `VESTIGIO_REPAIR_MODE=background`. It asserts the read defers the repair (`repair: deferred`, stale body still returned), that `agent_end` then repairs and publishes the memory, and that a fresh process reads a current memory without another repair. The scenario re-seeds the run store first, because every scenario shares it.

## Gotchas

A stale summary stays available. Do not weaken the journey by suppressing its content or replacing actual lifecycle hooks with direct calls. No real Obelisk index or provider is needed. The repair timing is a setting, not a behaviour to hard-code, so keep the two scenarios aligned when the rendered `repair:` lines change.
