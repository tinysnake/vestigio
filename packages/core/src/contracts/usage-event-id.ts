import { createHash } from "node:crypto";
import type { UsageEvent } from "./types.js";

/**
 * Deterministic id for a usage event, derived from the event's own fields.
 *
 * A retried callback that carries the same fields yields the same id, so the
 * store can dedupe on (event_id) without trusting the transport to retry only
 * once. `node:crypto` is a Node built-in, not a runtime dependency.
 *
 * Field order is fixed here so that a differently ordered object or a
 * round-tripped JSON object hashes identically.
 */
export function usageEventId(event: Omit<UsageEvent, "event_id">): string {
  const canonical = JSON.stringify([
    event.memory_id,
    event.revision,
    event.kind,
    event.channel,
    event.session_id,
    event.input_id,
    event.at,
    event.dedup_key,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
