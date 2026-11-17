import type { InjectionReceipt } from "./types.js";
import { fail } from "./primitives.js";

/**
 * Uniqueness key for injection receipts.
 *
 * The key deliberately excludes `revision`: a memory is injected once per
 * (session, branch, input) even after it is revised, because `memory_id` is the
 * stable identity across revisions.
 */
export function injectionReceiptKey(receipt: InjectionReceipt): string {
  return [receipt.session_id, receipt.branch_ref, receipt.input_id, receipt.memory_id].join("\u001f");
}

/**
 * Rejects a receipt list that injects the same (session, branch, input, memory)
 * twice, including across different revisions.
 */
export function assertUniqueInjectionReceipts(receipts: readonly InjectionReceipt[]): void {
  const seen = new Map<string, number>();
  for (const [index, receipt] of receipts.entries()) {
    const key = injectionReceiptKey(receipt);
    const first = seen.get(key);
    if (first !== undefined) {
      fail(
        `$[${index}]`,
        "invariant_violation",
        `duplicate injection receipt for ${key} (first at $[${first}]); memory_id is stable across revisions`,
      );
    }
    seen.set(key, index);
  }
}
