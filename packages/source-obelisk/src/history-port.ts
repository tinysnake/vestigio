import { join } from "node:path";
import type { HistoryHit, HistoryMessage, HistoryPort, HistoryResult } from "@vestigio/core/retrieval";
import { isObeliskError, isUnavailable } from "./errors.js";
import { INDEX_RELATIVE_PATH } from "./pinned.js";
import { ObeliskSource, type ObeliskSourceOptions } from "./source.js";
import type { SearchHit } from "./hit.js";
import type { ReadMessage } from "./read.js";

/**
 * The Obelisk adapter narrowed to the `HistoryPort` that `@vestigio/core`
 * defines, so a host injects the port instead of core importing this package.
 *
 * A port reports environment problems as `{ ok: false }` and never throws
 * (`packages/core/src/retrieval/types.ts`), which is what keeps a missing index
 * a degraded search instead of a failed tool call.
 */

export type ObeliskHistoryOptions = {
  /** Isolated Obelisk data directory. Never guessed. */
  readonly home: string;
  readonly cli_path?: string | undefined;
  readonly source_instance?: string | undefined;
  readonly timeout_ms?: number | undefined;
};

function failureOf(error: unknown): HistoryResult<never> {
  if (isUnavailable(error)) {
    return {
      ok: false,
      status: "unavailable",
      reason: isObeliskError(error) ? `${error.kind}:${error.message}` : String(error),
    };
  }
  if (isObeliskError(error)) {
    return { ok: false, status: "failed", reason: `${error.kind}:${error.message}` };
  }
  return { ok: false, status: "failed", reason: error instanceof Error ? error.message : String(error) };
}

function toHistoryHit(hit: SearchHit): HistoryHit {
  return {
    source_ref: hit.source_ref,
    text: hit.text,
    timestamp: hit.timestamp,
    role: hit.role,
    evidence_complete: hit.evidence_complete,
    project_resolved: hit.project_resolved,
  };
}

function toHistoryMessage(message: ReadMessage): HistoryMessage {
  return { source_ref: message.source_ref, text: message.text, role: message.role };
}

export function createObeliskHistoryPort(options: ObeliskHistoryOptions): HistoryPort {
  const adapterOptions: ObeliskSourceOptions = {
    home: options.home,
    cli_path: options.cli_path,
    source_instance: options.source_instance,
    timeout_ms: options.timeout_ms,
  };
  const source = new ObeliskSource(adapterOptions);

  return {
    async probe() {
      try {
        const probe = await source.probe();
        return { available: probe.available, reason: probe.reason };
      } catch (error) {
        return {
          available: false,
          reason: isObeliskError(error) ? `${error.kind}:${error.message}` : "probe_failed",
        };
      }
    },

    async search(input) {
      try {
        const found = await source.search({
          text: input.text,
          project_path: input.project_path,
          limit: input.limit,
        });
        return {
          ok: true,
          value: {
            hits: found.hits.map(toHistoryHit),
            evidence: found.evidence,
            elapsed_ms: found.timing.total_ms,
          },
        };
      } catch (error) {
        return failureOf(error);
      }
    },

    /**
     * One bounded window. `parents` walks the causal chain; `timeline` walks the
     * conversation, which is where a reply to the anchor lives.
     */
    async readByAnchor(input) {
      try {
        const page = await source.read({
          anchor: input.anchor,
          relation: input.relation ?? "parents",
          before: input.before,
          after: input.after ?? 0,
          ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
        });
        return {
          ok: true,
          value: {
            anchor: page.anchor,
            messages: page.messages.map(toHistoryMessage),
            has_more: page.has_more,
            elapsed_ms: page.timing.total_ms,
          },
        };
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}

/** The Obelisk index path the adapter will open for `home`. */
export function obeliskIndexPath(home: string): string {
  return join(home, INDEX_RELATIVE_PATH);
}
