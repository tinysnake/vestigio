import { createHash } from "node:crypto";
import { parseSourceRef } from "./parse.js";
import { parseMemoryId, parseRevision } from "./primitives.js";
import type { MemoryId, Revision, SourceRef } from "./types.js";

/** Reason is normalized to this many code points before it becomes identity. */
export const STALE_REASON_MAX = 240;
/** Evidence excerpt stored (and hashed) at this many code points. */
export const STALE_EXCERPT_MAX = 400;

function codePoints(text: string): string[] {
  return [...text];
}

/** Collapse whitespace and bound the reason so retries hash identically. */
export function normalizeStaleReason(reason: string): string {
  const collapsed = reason.replace(/\s+/gu, " ").trim();
  const points = codePoints(collapsed);
  if (points.length <= STALE_REASON_MAX) {
    return collapsed;
  }
  return `${points.slice(0, STALE_REASON_MAX - 1).join("")}…`;
}

export type BoundedExcerpt = {
  excerpt: string;
  truncated: boolean;
  char_count: number;
};

/** Bound an evidence excerpt with a visible marker, counting code points. */
export function boundStaleExcerpt(text: string, max = STALE_EXCERPT_MAX): BoundedExcerpt {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const full = codePoints(normalized);
  if (full.length <= max) {
    return { excerpt: normalized, truncated: false, char_count: full.length };
  }
  const kept = full.slice(0, Math.max(1, max - 1)).join("");
  return { excerpt: `${kept}…`, truncated: true, char_count: kept.length + 1 };
}

/**
 * A source's identity as an anchor tuple. This is the canonical conversation
 * locator a stale event preserves, independent of the memory revision it is
 * attached to.
 */
export function staleAnchorKey(source: SourceRef): string {
  const ref = parseSourceRef(source);
  return JSON.stringify([
    ref.provider,
    ref.source_instance,
    ref.session_id,
    ref.message_id,
    ref.content_hash,
    ref.locator,
  ]);
}

export type StaleEventIdentityInput = {
  memory_id: MemoryId;
  observed_revision: Revision;
  reason: string;
  excerpt: string;
  sources: readonly SourceRef[];
  branch_ref?: string | null;
};

export type StaleEventIdentity = {
  event_id: string;
  content_hash: string;
  memory_id: MemoryId;
  observed_revision: Revision;
  reason: string;
  excerpt: string;
  excerpt_truncated: boolean;
  excerpt_char_count: number;
  branch_ref: string | null;
  anchor_keys: string[];
};

/**
 * Deterministic event identity.
 *
 * `event_id` covers only the logical change — memory id, observed revision,
 * normalized reason and the sorted source anchor tuples — so the same detector
 * finding retried with a different timestamp or producer is one event. The
 * `content_hash` additionally covers the bounded excerpt so reusing an explicit
 * event id with different evidence is detectable instead of silently replacing
 * the stored row. Producer, observation time and branch are context, never
 * evidence, so a retry that only changes them stays an idempotent no-op.
 */
export function staleEventIdentity(input: StaleEventIdentityInput): StaleEventIdentity {
  const memoryId = parseMemoryId(input.memory_id);
  const observedRevision = parseRevision(input.observed_revision);
  const reason = normalizeStaleReason(input.reason);
  if (reason.length === 0) {
    throw new Error("stale event reason must not be empty");
  }
  const bounded = boundStaleExcerpt(input.excerpt);
  const anchorKeys = input.sources.map((source) => staleAnchorKey(source)).sort();
  const branchRef = input.branch_ref ?? null;
  const logical = [memoryId, observedRevision, reason, anchorKeys];
  const eventId = sha256(JSON.stringify(logical));
  const contentHash = sha256(
    JSON.stringify([
      ...logical,
      bounded.excerpt,
      bounded.char_count,
      bounded.truncated,
    ]),
  );
  return {
    event_id: eventId,
    content_hash: contentHash,
    memory_id: memoryId,
    observed_revision: observedRevision,
    reason,
    excerpt: bounded.excerpt,
    excerpt_truncated: bounded.truncated,
    excerpt_char_count: bounded.char_count,
    branch_ref: branchRef,
    anchor_keys: anchorKeys,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
