/**
 * The injection orchestrator: read the pool, match, render, append.
 *
 * This is the whole PR-05 path. It is synchronous on purpose — there is no
 * model call and no I/O beyond the local SQLite reads — and every store read is
 * followed by a cooperative deadline check. On timeout the turn is abandoned
 * with reason `timeout`: the user's text is returned unchanged, a hit is not
 * committed, and a later turn may inject normally.
 */

import {
  usageEventId,
  type InjectionReceipt,
  type MemoryId,
  type Revision,
  type UsageEvent,
  type UsageEventKind,
} from "../contracts/index.js";
import { TOKEN_ESTIMATE_BYTES_PER_TOKEN } from "../retrieval/index.js";
import { Deadline, HotspotTimeoutError } from "./deadline.js";
import { InjectionLedger } from "./ledger.js";
import { DEFAULT_MAX_HOTSPOT_MEMORIES, DEFAULT_MIN_MATCH_SCORE, matchHotspots } from "./match.js";
import { DEFAULT_HOTSPOT_POOL_CAPACITY } from "./policy.js";
import { evaluatePool, markHotspotAccess, markHotspotHits } from "./pool.js";
import { DEFAULT_INJECTION_BUDGET_BYTES, renderInjectionBlock } from "./render.js";
import type {
  CommitResult,
  HotspotMatch,
  HotspotStore,
  InjectionPlan,
  InjectionReason,
} from "./types.js";

/** Plan §9: the hard ceiling on the whole local match path. */
export const DEFAULT_HOTSPOT_TIMEOUT_MS = 1000;

export type PlanInjectionInput = {
  /** `null` when no store is configured; the turn is then a clean no-op. */
  store: HotspotStore | null;
  project_id: string;
  session_id: string;
  branch_ref: string;
  input_id: string;
  text: string;
  /** pi's `InputSource`. `"extension"` is refused: never match our own message. */
  source?: string;
  streaming_behavior?: "steer" | "followUp" | null;
  /**
   * The host declares that this text is one of its own commands rather than
   * plain user text (pi expands skills and templates before the model sees the
   * input, so a rewrite would break the command). `core` never guesses this
   * from the text: the convention belongs to the host.
   */
  host_command?: boolean;
  ledger: InjectionLedger;
  budget_bytes?: number;
  max_memories?: number;
  min_score?: number;
  capacity?: number;
  timeout_ms?: number;
  /** Injectable clock so the timeout test is deterministic. */
  now?: () => number;
};

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notInjected(
  input: PlanInjectionInput,
  deadline: Deadline,
  budgetBytes: number,
  reason: InjectionReason,
  extra: { matched?: HotspotMatch[]; used_bytes?: number } = {},
): InjectionPlan {
  const usedBytes = extra.used_bytes ?? 0;
  return {
    status: "not_injected",
    reason,
    original_text: input.text,
    text: input.text,
    block: null,
    matched: extra.matched ?? [],
    injected: [],
    budget: { limit_bytes: budgetBytes, used_bytes: usedBytes, estimated_tokens: estimateTokens(usedBytes) },
    elapsed_ms: deadline.elapsed_ms,
    timeout_ms: deadline.timeout_ms,
    session_id: input.session_id,
    branch_ref: input.branch_ref,
    input_id: input.input_id,
    project_id: input.project_id,
  };
}

export function planInjection(input: PlanInjectionInput): InjectionPlan {
  const timeoutMs = input.timeout_ms ?? DEFAULT_HOTSPOT_TIMEOUT_MS;
  const budgetBytes = input.budget_bytes ?? DEFAULT_INJECTION_BUDGET_BYTES;
  const deadline = new Deadline(timeoutMs, input.now);

  if (input.source === "extension") {
    return notInjected(input, deadline, budgetBytes, "extension_source");
  }
  if (input.text.trim().length === 0) {
    return notInjected(input, deadline, budgetBytes, "empty_input");
  }
  // The `input` handler runs before the host expands skills and templates, so
  // rewriting a command would both break the command and feed the block into
  // its arguments. The host decides what counts as a command.
  if (input.host_command === true) {
    return notInjected(input, deadline, budgetBytes, "slash_command");
  }
  if (input.store === null || input.project_id.length === 0) {
    return notInjected(input, deadline, budgetBytes, "store_unavailable");
  }

  try {
    const store = input.store;
    const activity = store.readProjectActivity(input.project_id);
    deadline.check("readProjectActivity");
    const activitySeq = activity?.activity_seq ?? 0;

    const pool = evaluatePool({
      store,
      project_id: input.project_id,
      activity_seq: activitySeq,
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      deadline,
    });
    deadline.check("evaluatePool");
    if (pool.entries.length === 0) {
      return notInjected(input, deadline, budgetBytes, "no_pool_members");
    }

    const matched = matchHotspots({
      entries: pool.entries,
      text: input.text,
      max_matches: input.max_memories ?? DEFAULT_MAX_HOTSPOT_MEMORIES,
      min_score: input.min_score ?? DEFAULT_MIN_MATCH_SCORE,
      activity_seq: activitySeq,
      deadline,
    });
    deadline.check("matchHotspots");
    if (matched.length === 0) {
      return notInjected(input, deadline, budgetBytes, "no_match");
    }

    // Session dedup: a memory is injected once per Session (the ledger), and at
    // most once per turn even when several aliases hit (the `seen` set).
    const fresh: HotspotMatch[] = [];
    const seen = new Set<MemoryId>();
    for (const match of matched) {
      if (seen.has(match.memory_id) || input.ledger.has(match.memory_id)) {
        continue;
      }
      seen.add(match.memory_id);
      fresh.push(match);
    }
    if (fresh.length === 0) {
      return notInjected(input, deadline, budgetBytes, "all_deduped", { matched });
    }

    deadline.check("dedup");
    const rendered = renderInjectionBlock({ matches: fresh, budget_bytes: budgetBytes });
    deadline.check("render");
    if (rendered.block === null) {
      return notInjected(input, deadline, budgetBytes, "over_budget", {
        matched,
        used_bytes: rendered.used_bytes,
      });
    }

    return {
      status: "injected",
      reason: null,
      original_text: input.text,
      text: `${input.text}\n\n${rendered.block}`,
      block: rendered.block,
      matched,
      injected: rendered.included,
      budget: {
        limit_bytes: budgetBytes,
        used_bytes: rendered.used_bytes,
        estimated_tokens: estimateTokens(rendered.used_bytes),
      },
      elapsed_ms: deadline.elapsed_ms,
      timeout_ms: timeoutMs,
      session_id: input.session_id,
      branch_ref: input.branch_ref,
      input_id: input.input_id,
      project_id: input.project_id,
    };
  } catch (error) {
    const reason: InjectionReason = error instanceof HotspotTimeoutError ? "timeout" : "store_error";
    return notInjected(input, deadline, budgetBytes, reason);
  }
}

export type CommitInjectionInput = {
  plan: InjectionPlan;
  store: HotspotStore;
  ledger: InjectionLedger;
  /** ISO timestamp shared by every row this commit writes. */
  at: string;
  /** Project real-input clock value for this turn. */
  activity_seq: number;
};

function usageFields(
  kind: UsageEventKind,
  channel: UsageEvent["channel"],
  input: {
    session_id: string;
    input_id: string;
    at: string;
    dedup_key: string;
    memory_id: MemoryId;
    revision: Revision;
  },
): UsageEvent {
  const fields = {
    memory_id: input.memory_id,
    revision: input.revision,
    kind,
    channel,
    session_id: input.session_id,
    input_id: input.input_id,
    at: input.at,
    dedup_key: input.dedup_key,
  };
  return { event_id: usageEventId(fields), ...fields };
}

/**
 * Commit a delivered injection: hit statistics for every match, a receipt for
 * every block actually appended, and the ledger advance for those receipts.
 *
 * A per-row failure is collected, not thrown: a receipt that failed to write
 * must not suppress the same memory on a later turn, which is exactly what
 * happens because the ledger only learns about the receipts that succeeded.
 */
export function commitInjection(input: CommitInjectionInput): CommitResult {
  const { plan, store, ledger } = input;
  const result: CommitResult = {
    hit_events: 0,
    duplicate_hit_events: 0,
    receipts: 0,
    delivered: [],
    membership_hits: 0,
    ledger_added: [],
    delta: null,
    errors: [],
  };
  if (plan.status !== "injected") {
    return result;
  }

  for (const match of plan.matched) {
    try {
      const inserted = store.recordUsageEvent(
        usageFields("hit", "hotspot", {
          session_id: plan.session_id,
          input_id: plan.input_id,
          at: input.at,
          dedup_key: `hotspot:${plan.project_id}:${plan.input_id}:${match.memory_id}`,
          memory_id: match.memory_id,
          revision: match.revision,
        }),
      );
      if (inserted) {
        result.hit_events += 1;
      } else {
        result.duplicate_hit_events += 1;
      }
    } catch (error) {
      result.errors.push(`hit:${match.memory_id}:${errorMessage(error)}`);
    }
  }

  const delivered: MemoryId[] = [];
  for (const match of plan.injected) {
    const receipt: InjectionReceipt = {
      store_id: store.storeId,
      session_id: plan.session_id,
      branch_ref: plan.branch_ref,
      input_id: plan.input_id,
      memory_id: match.memory_id,
      revision: match.revision,
      committed_at: input.at,
    };
    try {
      store.recordInjectionReceipt(receipt);
      result.receipts += 1;
      delivered.push(match.memory_id);
    } catch (error) {
      result.errors.push(`receipt:${match.memory_id}:${errorMessage(error)}`);
    }
  }

  try {
    result.membership_hits = markHotspotHits(
      store,
      plan.project_id,
      plan.matched.map((match) => match.memory_id),
      input.activity_seq,
    );
  } catch (error) {
    result.errors.push(`membership:${errorMessage(error)}`);
  }

  // Delivery record and Session ledger move together or not at all: the caller
  // must not tell the user the memory arrived unless both are true.
  result.delivered = delivered;
  const receiptComplete = delivered.length === plan.injected.length;
  result.ledger_added = receiptComplete ? ledger.addMany(delivered, input.at) : [];
  result.delta =
    result.ledger_added.length === 0
      ? null
      : { at: input.at, input_id: plan.input_id, memory_ids: result.ledger_added };
  return result;
}

export type RecordSearchHitsInput = {
  store: HotspotStore;
  session_id: string;
  input_id: string;
  at: string;
  hits: readonly { memory_id: MemoryId; revision: Revision }[];
};

/** A search that returned these cards counts as a hit for each of them. */
export function recordSearchHits(input: RecordSearchHitsInput): number {
  let recorded = 0;
  for (const hit of input.hits) {
    const inserted = input.store.recordUsageEvent(
      usageFields("hit", "search", {
        session_id: input.session_id,
        input_id: input.input_id,
        at: input.at,
        dedup_key: `search:${input.session_id}:${input.input_id}:${hit.memory_id}`,
        memory_id: hit.memory_id,
        revision: hit.revision,
      }),
    );
    if (inserted) {
      recorded += 1;
    }
  }
  return recorded;
}

export type RecordMemoryReadInput = {
  store: HotspotStore;
  project_id: string;
  session_id: string;
  input_id: string;
  at: string;
  memory_id: MemoryId;
  revision: Revision;
  activity_seq: number;
};

/**
 * A full medium summary was read and handed to the caller. This is the only
 * event that counts as an access; a short-summary injection or a card does not.
 */
export function recordMemoryRead(input: RecordMemoryReadInput): {
  recorded: boolean;
  membership: boolean;
} {
  const recorded = input.store.recordUsageEvent(
    usageFields("access", "read", {
      session_id: input.session_id,
      input_id: input.input_id,
      at: input.at,
      dedup_key: `read:${input.session_id}:${input.input_id}:${input.memory_id}`,
      memory_id: input.memory_id,
      revision: input.revision,
    }),
  );
  let membership = false;
  try {
    membership = markHotspotAccess(input.store, input.project_id, input.memory_id, input.activity_seq);
  } catch {
    membership = false;
  }
  return { recorded, membership };
}

export { InjectionLedger };
export { DEFAULT_HOTSPOT_POOL_CAPACITY };
