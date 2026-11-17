/**
 * Obelisk rows → `SourceRef`.
 *
 * The mapping is deliberately thin and total: every field is either read from
 * the row or explicitly `null`, and the result goes through the core
 * `parseSourceRef` validator, so the adapter cannot emit a ref the rest of the
 * system would reject. `content_hash` is SHA-256 over the message text exactly
 * as stored (full text, never a snippet), which is what lets a ref be
 * re-verified against the source after an index rebuild.
 */

import { createHash } from "node:crypto";
import type { SourceRef } from "@vestigio/core";
import { parseSourceRef } from "@vestigio/core";
import { obeliskError } from "./errors.js";
import type { CliMessage, CliSession } from "./parse.js";

/** Sessions with no recorded project. Stable, greppable, never silently empty. */
export const UNSCOPED_PROJECT = "(unscoped)";

export function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * The project identity is the absolute project path, not the derived slug: the
 * slug collapses `/a/b` and `/a-b`-style separators, and exact project scoping
 * is the property this adapter is here to keep. The slug is available on the
 * session for display.
 */
export function projectIdFor(session: CliSession, project_hint: string | null = null): string {
  return project_hint ?? session.project_path ?? session.project ?? UNSCOPED_PROJECT;
}

export function locatorFor(jsonl_path: string | null, message_id: string): string | null {
  return jsonl_path === null ? null : `${jsonl_path}#${message_id}`;
}

export type SourceRefInput = {
  readonly message: CliMessage;
  readonly session: CliSession;
  readonly source_instance: string;
  readonly parent_uuid: string | null;
  readonly jsonl_path: string | null;
  /**
   * The exact project the caller asked for, when there is one. A scoped search
   * has verified every hit is in that project, so the path is known even though
   * `--search` rows do not carry it; without it the project identity falls back
   * to the lossy derived slug.
   */
  readonly project_path_hint?: string | null;
};

export function toSourceRef(input: SourceRefInput, path = "$"): SourceRef {
  const { message, session } = input;
  const provider = message.source ?? session.source;
  if (provider === null) {
    throw obeliskError("protocol", `${path}: message ${message.uuid} has no provider on the row or its session`, {
      expected: "messages.source or sessions.source",
    });
  }
  if (input.parent_uuid !== null && input.parent_uuid === message.uuid) {
    throw obeliskError("protocol", `${path}: message ${message.uuid} lists itself as its own parent`, {
      expected: "parent_uuid is a different message",
    });
  }
  return parseSourceRef(
    {
      provider,
      source_instance: input.source_instance,
      session_id: message.session_id ?? session.id,
      message_id: message.uuid,
      parent_message_id: input.parent_uuid,
      project_id: projectIdFor(session, input.project_path_hint ?? null),
      timestamp: message.timestamp,
      content_hash: contentHash(message.text),
      locator: locatorFor(input.jsonl_path, message.uuid),
    },
    path,
  );
}

/**
 * The derived project slug, exactly as the pinned release computes it
 * (`projectSlugFromPath`): leading separators dropped, separator runs → `-`,
 * prefixed with `-`. Used to check that a `--project-path` result really came
 * from that project.
 */
export function projectSlugFor(project_path: string): string {
  return `-${project_path.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "-")}`;
}
