/**
 * Deterministic lexical normalization for the local FTS5 indexes.
 *
 * Why not the stock tokenizer: the FTS5 `unicode61` tokenizer treats a whole CJK
 * run as one token, so 服务器 / 配置 inside a sentence are unreachable, and
 * `tokenize='trigram'` cannot match a query shorter than three code points at
 * all. Two-character Chinese words are common, so trigram alone is not enough.
 *
 * Mechanism: the same `normalizeForIndex` runs over indexed text and over the
 * query, emitting one token per CJK code point (unigram) plus every adjacent
 * pair (bigram), and one token per Latin/digit run lowercased and split on
 * `-`, `_` and every other separator. The tokens are joined with single spaces
 * and stored in an ordinary FTS5 table, whose own tokenizer then only has to
 * split on whitespace. Because index and query share this function, a
 * two-character word matches through its bigram and a one-character word
 * through its unigram.
 *
 * Query syntax: `buildMatchQuery` joins the quoted normalized tokens with
 * `AND` (default) or `OR`, e.g. `"服" AND "务" AND "器" AND "服务" AND "务器"`.
 */

/** Han, kana and hangul syllables. Checked before the general letter class. */
const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2fa1f}]/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Lowercase, NFKC-normalize and tokenize `text`. Deterministic: the same input
 * always yields the same token list. Separators (whitespace, punctuation, emoji)
 * are dropped; tokens are de-duplicated while keeping first-seen order.
 */
export function normalizeForIndex(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  const lowered = text.normalize("NFKC").toLowerCase();
  let previousCjk: string | null = null;
  let latin = "";
  const flushLatin = (): void => {
    if (latin.length > 0) {
      push(latin);
      latin = "";
    }
  };

  for (const character of lowered) {
    if (CJK.test(character)) {
      flushLatin();
      push(character);
      if (previousCjk !== null) {
        push(previousCjk + character);
      }
      previousCjk = character;
    } else if (WORD.test(character)) {
      previousCjk = null;
      latin += character;
    } else {
      flushLatin();
      previousCjk = null;
    }
  }
  flushLatin();
  return tokens;
}

export type MatchMode = "all" | "any";

/**
 * FTS5 MATCH expression for a user query, or `null` when the query normalizes
 * to nothing. Every token is quoted, so punctuation in the query can never be
 * read as FTS5 syntax.
 */
export function buildMatchQuery(text: string, mode: MatchMode = "all"): string | null {
  const tokens = normalizeForIndex(text);
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((token) => `"${token.replaceAll('"', '""')}"`);
  return quoted.join(mode === "all" ? " AND " : " OR ");
}
