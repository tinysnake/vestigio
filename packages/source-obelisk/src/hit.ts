/**
 * Row → public hit mapping, shared by search and read so a hit means the same
 * thing wherever it came from.
 */

import type { SourceRef } from "@vestigio/core";
import type { CliHit, CliMessage, CliSession } from "./parse.js";
import { toSourceRef } from "./source-ref.js";

export type HitSession = {
  readonly id: string;
  readonly title: string | null;
  readonly project: string | null;
  readonly project_path: string | null;
  readonly source: string | null;
};

export type ContextMessage = {
  readonly message_id: string;
  readonly text: string;
  readonly role: string | null;
};

export type CallTiming = {
  /** Child process wall time, spawn → exit. The direct-CLI baseline. */
  readonly child_ms: number;
  /** Whole adapter call, entry → return. `total_ms - child_ms` is adapter overhead. */
  readonly total_ms: number;
};

export type SearchHit = {
  readonly source_ref: SourceRef;
  readonly text: string;
  readonly role: string | null;
  readonly timestamp: string;
  readonly visibility: string;
  readonly is_meta: boolean;
  readonly session: HitSession;
  readonly rank: number;
  readonly context: readonly ContextMessage[];
  /**
   * True when the causal parent and the source file are resolved. The
   * `--search` path cannot see either, so it reports false rather than
   * pretending a hit has no parent.
   */
  readonly evidence_complete: boolean;
  /**
   * True when `source_ref.project_id` is the exact project path. False when the
   * only identity the CLI gave was the derived slug (an unscoped `--search`).
   */
  readonly project_resolved: boolean;
  /** Fields the pinned release returned that this adapter does not model. */
  readonly unrecognised: readonly string[];
};

export type SearchQueryEcho = {
  /** The caller's text, exactly as passed in. */
  readonly text: string;
  /** What FTS5 actually received; equal to `text` when nothing was expanded. */
  readonly fts_text: string;
  readonly limit: number;
  readonly project_path: string | null;
  readonly session_id: string | null;
  readonly after: string | null;
  readonly before: string | null;
  readonly source: string | null;
  readonly include_meta: boolean;
  readonly include_inactive: boolean;
  readonly context_limit: number;
};

export type SearchResult = {
  readonly hits: readonly SearchHit[];
  readonly query: SearchQueryEcho;
  readonly evidence: "ids_only" | "resolved";
  readonly timing: CallTiming;
};

export function sessionOf(session: CliSession): HitSession {
  return {
    id: session.id,
    title: session.title,
    project: session.project,
    project_path: session.project_path,
    source: session.source,
  };
}

export function mapHit(
  hit: CliHit,
  source_instance: string,
  project_hint: string | null = null,
  path = "$",
): SearchHit {
  const source_ref = toSourceRef(
    {
      message: hit.message,
      session: hit.session,
      source_instance,
      parent_uuid: hit.parent_uuid,
      jsonl_path: hit.jsonl_path,
      project_path_hint: project_hint,
    },
    path,
  );
  const unrecognised = new Set<string>(hit.unrecognised);
  for (const key of hit.session.unrecognised) unrecognised.add(`session.${key}`);
  for (const entry of hit.context) {
    for (const key of entry.unrecognised) unrecognised.add(`context.${key}`);
  }
  return {
    source_ref,
    text: hit.message.text,
    role: hit.message.role,
    timestamp: hit.message.timestamp,
    visibility: hit.message.visibility,
    is_meta: hit.message.is_meta,
    session: sessionOf(hit.session),
    rank: hit.rank,
    context: hit.context.map((entry: CliMessage) => ({
      message_id: entry.uuid,
      text: entry.text,
      role: entry.role,
    })),
    evidence_complete: hit.parent_resolved,
    project_resolved: project_hint !== null || hit.session.project_path !== null,
    unrecognised: [...unrecognised].sort(),
  };
}
