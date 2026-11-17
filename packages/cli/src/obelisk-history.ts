import type {
  HistoryHit,
  HistoryMessage,
  HistoryPort,
  HistoryResult,
} from "@vestigio/core/retrieval";
import { join } from "node:path";
import {
  INDEX_RELATIVE_PATH,
  ObeliskSource,
  isUnavailable,
  isObeliskError,
  type ObeliskSourceOptions,
  type ReadMessage,
  type SearchHit,
} from "@vestigio/source-obelisk";

/**
 * The concrete history port: the Obelisk adapter, narrowed to what
 * `@vestigio/core` is allowed to know about.
 *
 * This is the only place that imports `@vestigio/source-obelisk`, and it lives
 * in the CLI on purpose. Core defines the port; the caller injects an
 * implementation; a second history provider would be another file like this
 * one, with no core change.
 */

export type ObeliskHistoryOptions = {
  /** Isolated Obelisk data directory. Never guessed. */
  home: string;
  cli_path?: string | undefined;
  source_instance?: string | undefined;
  timeout_ms?: number | undefined;
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
     * The causal chain, one bounded window. `parents` cannot take an `after`
     * window, so the CLI pays exactly one script invocation here.
     */
    async readByAnchor(input) {
      try {
        const page = await source.read({
          anchor: input.anchor,
          relation: "parents",
          before: input.before,
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
