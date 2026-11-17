/**
 * A deterministic, zero-LLM conflict signal.
 *
 * A lexical score cannot tell whether two memories disagree; only a model can
 * (PR-06). What the base layer *can* see is that two candidates in the same
 * scope claim the same subject, which means a reader cannot pick one from this
 * result alone. That is reported as `conflicted` and both ids are listed, so
 * the caller knows to disambiguate instead of trusting the first hit.
 *
 * The subject key is the normalized title with separators and qualifiers
 * dropped: `端口约定` and `端口约定（冲突）` both key to a prefix of the other,
 * and a one-code-point key is ignored because it is too weak to mean "the same
 * subject". Same titles in *different* scopes never collide — scope is part of
 * the grouping key.
 */

import type { MemoryCard, Scope } from "../contracts/index.js";

const SUBJECT_CHARACTER = /[\p{L}\p{N}]/u;

/** Shortest subject key that may participate in a collision. */
const MIN_SUBJECT_CHARS = 2;

export function subjectKey(title: string): string {
  let key = "";
  for (const character of title.normalize("NFKC").toLowerCase()) {
    if (SUBJECT_CHARACTER.test(character)) {
      key += character;
    }
  }
  return key;
}

function scopeKey(scope: Scope): string {
  return scope.kind === "project" ? `project:${scope.project_id}` : "global";
}

/**
 * Whether two normalized subject keys claim the same subject. Exported so the
 * PR-06 resolver can anchor the same rule on the cards its answer cites,
 * instead of letting a model-held `resolved` outrank a contested subject.
 */
export function subjectsCollide(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < MIN_SUBJECT_CHARS) {
    return false;
  }
  return longer.startsWith(shorter);
}

/** Memory ids of every card that shares a subject with another card in scope. */
export function findConflictingMemoryIds(cards: readonly MemoryCard[]): string[] {
  const groups = new Map<string, { memory_id: string; key: string }[]>();
  for (const card of cards) {
    const group = groups.get(scopeKey(card.scope)) ?? [];
    group.push({ memory_id: card.memory_id, key: subjectKey(card.title) });
    groups.set(scopeKey(card.scope), group);
  }

  const conflicting = new Set<string>();
  for (const group of groups.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left];
        const b = group[right];
        if (a === undefined || b === undefined) {
          continue;
        }
        if (subjectsCollide(a.key, b.key)) {
          conflicting.add(a.memory_id);
          conflicting.add(b.memory_id);
        }
      }
    }
  }
  return [...conflicting].sort();
}
