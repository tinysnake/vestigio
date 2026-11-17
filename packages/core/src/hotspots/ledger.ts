/**
 * Session injection ledger.
 *
 * Rule (requirements 2026-11-17 §1, plan §4.1): one memory id is injected at
 * most once per Session, the fact survives continue and restart, a fork
 * inherits the records on the branch it forked from, and a revert is not held
 * back by records on the branch it abandoned. Compaction and a revision bump
 * never re-inject.
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
  private readonly firstSeen = new Map<MemoryId, string>();

  constructor(initial?: ReadonlyMap<MemoryId, string>) {
    if (initial !== undefined) {
      for (const [memoryId, at] of initial) {
        this.firstSeen.set(memoryId, at);
      }
    }
  }

  get size(): number {
    return this.firstSeen.size;
  }

  has(memoryId: MemoryId): boolean {
    return this.firstSeen.has(memoryId);
  }

  /** ISO timestamp of the first delivery, or null when never injected. */
  deliveredAt(memoryId: MemoryId): string | null {
    return this.firstSeen.get(memoryId) ?? null;
  }

  ids(): MemoryId[] {
    return [...this.firstSeen.keys()];
  }

  /**
   * Record one delivery. Returns false when the memory was already in the
   * ledger. A later delivery never overwrites an earlier `at`, so the stamp is
   * the first delivery whichever order the deltas arrive in.
   */
  add(memoryId: MemoryId, at: string): boolean {
    const existing = this.firstSeen.get(memoryId);
    if (existing !== undefined) {
      if (isEarlier(at, existing)) this.firstSeen.set(memoryId, at);
      return false;
    }
    this.firstSeen.set(memoryId, at);
    return true;
  }

  /** Record a delivery batch. Returns only the ids that were newly added. */
  addMany(memoryIds: readonly MemoryId[], at: string): MemoryId[] {
    const added: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      if (this.add(memoryId, at)) {
        added.push(memoryId);
      }
    }
    return added;
  }

  /**
   * Rebuild a ledger by replaying deltas in branch order. A delta whose ids
   * were already seen adds nothing; the earliest `at` for an id wins,
   * independent of the order the deltas are replayed in.
   */
  static replay(deltas: readonly InjectionLedgerDelta[]): InjectionLedger {
    const ledger = new InjectionLedger();
    for (const delta of deltas) {
      for (const memoryId of delta.memory_ids) {
        ledger.add(memoryId, delta.at);
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
