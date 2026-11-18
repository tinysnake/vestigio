/**
 * Session injection ledger.
 *
 * Rule (requirements 2026-11-17 §1, plan §4.1): one memory id is injected at
 * most once per Session, the fact survives continue and restart, a fork
 * inherits the records on the branch it forked from, and a revert is not held
 * back by records on the branch it abandoned. Compaction never re-injects.
 *
 * The store's `injection_receipts` table records each delivery but offers no
 * read that lists a Session's memories (`hasInjectionReceipt` is an exact
 * five-key lookup). So the ledger is the read side of dedup: an ordered set of
 * memory ids, rebuilt by replaying persisted deltas. The pi extension persists
 * the deltas as branch-scoped session entries, which is what gives fork and
 * revert their semantics for free — the replay sees exactly the deltas that
 * sit on the current branch.
 *
 * The ledger has no dependency beyond core contracts, so it is fully unit
 * testable and reusable by any host.
 */

import type { MemoryId } from "../contracts/index.js";
import type { InjectionLedgerDelta } from "./types.js";

export class InjectionLedger {
  private readonly seen = new Map<MemoryId, { at: string; freshness_sig: string }>();

  constructor(initial?: ReadonlyMap<MemoryId, string>) {
    if (initial !== undefined) {
      for (const [memoryId, at] of initial) {
        this.seen.set(memoryId, { at, freshness_sig: "" });
      }
    }
  }

  get size(): number {
    return this.seen.size;
  }

  has(memoryId: MemoryId): boolean {
    return this.seen.has(memoryId);
  }

  /**
   * True when this teller already delivered exactly this freshness snapshot.
   * A changed snapshot (new pending stale events, or a new head) is not
   * deduped, so freshness is never hidden forever by an old delivery.
   */
  isDelivered(memoryId: MemoryId, freshnessSig: string): boolean {
    const entry = this.seen.get(memoryId);
    return entry !== undefined && entry.freshness_sig === freshnessSig;
  }

  /** ISO timestamp of the first delivery, or null when never injected. */
  deliveredAt(memoryId: MemoryId): string | null {
    return this.seen.get(memoryId)?.at ?? null;
  }

  freshnessSig(memoryId: MemoryId): string | null {
    return this.seen.get(memoryId)?.freshness_sig ?? null;
  }

  ids(): MemoryId[] {
    return [...this.seen.keys()];
  }

  /**
   * Record one delivery. Returns false when this exact freshness snapshot was
   * already in the ledger. A changed snapshot returns true (re-deliver) and
   * refreshes the fingerprint; a later delivery never overwrites an earlier
   * `at`, so the stamp is the first delivery whichever order deltas arrive in.
   */
  add(memoryId: MemoryId, at: string, freshnessSig = ""): boolean {
    const existing = this.seen.get(memoryId);
    if (existing !== undefined) {
      if (existing.freshness_sig === freshnessSig) {
        if (isEarlier(at, existing.at)) this.seen.set(memoryId, { at, freshness_sig: freshnessSig });
        return false;
      }
      this.seen.set(memoryId, {
        at: isEarlier(at, existing.at) ? at : existing.at,
        freshness_sig: freshnessSig,
      });
      return true;
    }
    this.seen.set(memoryId, { at, freshness_sig: freshnessSig });
    return true;
  }

  /**
   * Record a delivery batch. Returns the ids that were newly added or whose
   * freshness snapshot changed, i.e. the ids worth persisting in a delta.
   */
  addMany(
    memoryIds: readonly MemoryId[],
    at: string,
    freshnessSigs?: Readonly<Record<string, string>>,
  ): MemoryId[] {
    const added: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      if (this.add(memoryId, at, freshnessSigs?.[memoryId] ?? "")) {
        added.push(memoryId);
      }
    }
    return added;
  }

  /**
   * Rebuild a ledger by replaying deltas in branch order. A delta whose ids
   * were already seen at the same snapshot adds nothing; the earliest `at` for
   * an id wins, independent of the order the deltas are replayed in.
   */
  static replay(deltas: readonly InjectionLedgerDelta[]): InjectionLedger {
    const ledger = new InjectionLedger();
    for (const delta of deltas) {
      for (const memoryId of delta.memory_ids) {
        ledger.add(memoryId, delta.at, delta.freshness_sigs?.[memoryId] ?? "");
      }
    }
    return ledger;
  }

  static fromIds(memoryIds: readonly MemoryId[], at = ""): InjectionLedger {
    const ledger = new InjectionLedger();
    for (const memoryId of memoryIds) {
      ledger.add(memoryId, at);
    }
    return ledger;
  }
}

/** ISO timestamps compare by instant; an unparseable stamp never wins. */
function isEarlier(candidate: string, current: string): boolean {
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  if (Number.isNaN(candidateMs) || Number.isNaN(currentMs)) return false;
  return candidateMs < currentMs;
}
