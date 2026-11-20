/**
 * FTS5 query rewriting for the tokenizer the pinned index actually uses.
 *
 * The index is built without a `tokenize` option, so SQLite's unicode61
 * tokenizer applies: every run of letters, digits and Han characters becomes one
 * token. A Chinese question is therefore compared as a whole string against
 * whole runs of text, so `灰度发布` matches a message only when the message
 * contains a token that is exactly `灰度发布` — never `灰度发布按5%` or
 * `下一批灰度发布`. Measured on the operator's 6.97 GiB index, `灰度发布`
 * returned 6 of the 16 hits `灰度发布*` returned, and `迁移脚本` 8 of 20.
 *
 * Appending `*` turns a term into a prefix match, which is a superset of the
 * exact match it replaces and is the same thing FTS5's own prefix queries do.
 * Nothing else about the query is changed: no reordering, no quoting, no
 * operator synthesis. A query that already carries FTS5 syntax is passed
 * through untouched, because the caller is then speaking deliberately and a
 * silent rewrite can only move it away from what it asked for.
 */

/** A term shorter than this stays exact: one Han character prefixes half the index. */
export const PREFIX_MIN_CODEPOINTS = 2;

/** Syntax that means the caller is writing FTS5 on purpose. */
const SYNTAX_CHARS = ['"', "*", "(", ")", "^", ":", "~"] as const;

/** Bare operators, which are only operators in upper case. */
const OPERATORS = ["AND", "OR", "NOT", "NEAR"] as const;

export type ExpandedQuery = {
  /** What to send to the tool. Equal to `original` when nothing was expanded. */
  readonly text: string;
  /** The caller's text, kept for the query echo. */
  readonly original: string;
  /** True when at least one term became a prefix match. */
  readonly expanded: boolean;
  /** The rewritten terms, in order; empty when the query was not rewritten. */
  readonly terms: readonly string[];
};

function isTokenChar(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

/** Strips leading/trailing punctuation FTS5 would treat as a separator anyway. */
function trimToTokenCharacters(term: string): string {
  const characters = [...term];
  let start = 0;
  let end = characters.length;
  while (start < end && !isTokenChar(characters[start]!)) start += 1;
  while (end > start && !isTokenChar(characters[end - 1]!)) end -= 1;
  return characters.slice(start, end).join("");
}

function hasExplicitSyntax(text: string): boolean {
  for (const character of SYNTAX_CHARS) {
    if (text.includes(character)) return true;
  }
  for (const raw of text.split(/\s+/u)) {
    // Leading `-` / `+` are the NOT and "must contain" prefixes.
    if (raw.startsWith("-") || raw.startsWith("+")) return true;
    if ((OPERATORS as readonly string[]).includes(raw)) return true;
  }
  return false;
}

/**
 * Rewrites every term into a prefix match, so a token the tool indexed as part
 * of a longer run is still found. Idempotent: an already-rewritten query is
 * returned unchanged, because `*` counts as explicit syntax.
 */
export function expandFtsQuery(text: string): ExpandedQuery {
  const unchanged: ExpandedQuery = { text, original: text, expanded: false, terms: [] };
  if (hasExplicitSyntax(text)) return unchanged;

  const terms: string[] = [];
  let prefixed = false;
  for (const raw of text.split(/\s+/u)) {
    if (raw.length === 0) continue;
    const core = trimToTokenCharacters(raw);
    if (core.length === 0) continue;
    if ([...core].length >= PREFIX_MIN_CODEPOINTS) {
      terms.push(`${core}*`);
      prefixed = true;
      continue;
    }
    terms.push(core);
  }

  if (!prefixed || terms.length === 0) return unchanged;
  return { text: terms.join(" "), original: text, expanded: true, terms };
}
