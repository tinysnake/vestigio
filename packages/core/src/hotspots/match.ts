/**
 * The local, lexical hotspot matcher.
 *
 * Contract (plan §4.3.1, requirements §1/§9): this path reads only persisted
 * short summaries and their keywords, never calls a model, never generates or
 * rewrites a summary, and must finish well inside one second. A Chinese hit is
 * a reminder, not a statement of semantic relevance.
 *
 * Match rule, stated explicitly:
 *
 * 1. Tokenize the user input and each pool entry with the store's own
 *    `normalizeForIndex`, so matching and the FTS index cannot drift apart:
 *    one token per CJK code point, every adjacent CJK pair, one token per
 *    Latin/digit run lowercased and split on separators.
 * 2. A shared token counts as a signal only when it is significant:
 *    a CJK token of at least two code points (never a lone character), a
 *    Latin/digit run of at least three code points, or any token that appears
 *    verbatim in the memory's `keywords` (its explicit aliases). Function words
 *    are dropped by a small stop list. This is what stops a short identifier
 *    from matching inside an unrelated word and stops "the"/"is" from matching.
 * 3. A keyword with two or more tokens also matches as a contiguous phrase and
 *    adds a bonus, so a multi-word alias like "deploy port" beats a stray token.
 * 4. Threshold: one signal is enough (`min_score` default 1) only when that
 *    signal is strong: a keyword alias, a contiguous keyword phrase, or two
 *    independent tokens. A lone shared nav/title token is not enough, because
 *    "配置" or "端口" alone appears in half the summaries and would drag an
 *    unrelated memory into the prompt. Aliases are the escape hatch: a memory
 *    that really is about a word declares it in `keywords`.
 * 5. An entry is returned at most once per turn no matter how many tokens or
 *    aliases hit, because the unit of the result is the memory.
 */

import { codePointCount } from "../contracts/index.js";
import { normalizeForIndex } from "../storage/index.js";
import type { Deadline } from "./deadline.js";
import { retentionScore } from "./policy.js";
import type { HotspotEntry, HotspotMatch } from "./types.js";

/** Plan §4.1: one input may surface at most this many memories. */
export const DEFAULT_MAX_HOTSPOT_MEMORIES = 3;
/** One shared signal is enough; exposed so PR-06/07 can tune it with evidence. */
export const DEFAULT_MIN_MATCH_SCORE = 1;
/** A phrase hit is worth this many token hits. */
export const PHRASE_BONUS = 2;

const CJK_ONLY =
  /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2fa1f}]+$/u;

/**
 * English function words of three or more code points. Shorter ones are already
 * rejected by the significance rule; one- and two-character CJK strings are
 * rejected the same way.
 */
const LATIN_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "that", "this", "from",
  "have", "has", "had", "was", "were", "will", "would", "should", "could", "can", "may",
  "might", "must", "about", "into", "then", "than", "them", "they", "their", "there",
  "where", "when", "which", "while", "what", "who", "why", "all", "any", "our", "out",
  "off", "own", "too", "very", "just", "also", "new", "old", "one", "two", "get", "got",
  "let", "use", "using", "used", "make", "made", "take", "taken", "give", "given", "see",
  "say", "said", "does", "did", "doing", "done", "been", "being", "its", "how", "more",
  "most", "some", "such", "only", "over", "under", "after", "before", "because", "again",
]);

/**
 * Common two-character Chinese function words. Two-character content words are
 * exactly what the bigram tokenizer is for, so only grammar words are dropped.
 */
const CJK_STOPWORDS = new Set([
  "我们", "你们", "他们", "她们", "这个", "那个", "这些", "那些", "什么", "怎么",
  "如果", "因为", "所以", "但是", "可以", "需要", "应该", "已经", "还是", "就是",
  "不是", "没有", "一个", "自己", "现在", "时候", "这样", "那样", "由于", "并且",
  "以及", "然后", "而是", "或者", "为了", "关于", "对于", "根据", "通过", "进行",
  "使用", "一起", "一下", "一些", "一样", "一边", "一直", "一定", "一般", "不要",
  "可能", "如何", "哪里", "这里", "那里",
]);

export type MatchInput = {
  entries: readonly HotspotEntry[];
  text: string;
  max_matches?: number;
  min_score?: number;
  activity_seq?: number;
  deadline?: Deadline;
};

/** Tokens of a text with stop words and single code points removed. */
export function matchTokens(text: string): string[] {
  return normalizeForIndex(text).filter((token) => !isStopword(token));
}

function isStopword(token: string): boolean {
  if (CJK_ONLY.test(token)) {
    if (codePointCount(token) <= 1) {
      return true;
    }
    return CJK_STOPWORDS.has(token);
  }
  return LATIN_STOPWORDS.has(token);
}

/** A token may carry a match on its own. */
function isSignificant(token: string, aliasTokens: ReadonlySet<string>): boolean {
  if (aliasTokens.has(token)) {
    return true;
  }
  if (CJK_ONLY.test(token)) {
    return codePointCount(token) >= 2 && !CJK_STOPWORDS.has(token);
  }
  return codePointCount(token) >= 3;
}

function entryTokens(entry: HotspotEntry): Set<string> {
  return new Set(matchTokens(`${entry.title} ${entry.keywords.join(" ")} ${entry.nav_text}`));
}

function aliasTokens(entry: HotspotEntry): Set<string> {
  return new Set(matchTokens(entry.keywords.join(" ")));
}

/**
 * Keywords that tokenize to a single token. Only these stand alone, because a
 * piece of a longer alias ("端口" out of "端口约定") is not the alias itself.
 */
function singleTokenAliases(entry: HotspotEntry): Set<string> {
  const single = new Set<string>();
  for (const keyword of entry.keywords) {
    const tokens = matchTokens(keyword);
    if (tokens.length === 1) {
      single.add(tokens[0] as string);
    }
  }
  return single;
}

/** True when `needle` occurs contiguously inside `haystack`. */
function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

export function matchHotspots(input: MatchInput): HotspotMatch[] {
  const inputTokens = matchTokens(input.text);
  if (inputTokens.length === 0) {
    return [];
  }
  const maxMatches = input.max_matches ?? DEFAULT_MAX_HOTSPOT_MEMORIES;
  const minScore = input.min_score ?? DEFAULT_MIN_MATCH_SCORE;
  const activitySeq = input.activity_seq ?? 0;
  const matches: HotspotMatch[] = [];

  for (const entry of input.entries) {
    input.deadline?.check("match");
    const aliases = aliasTokens(entry);
    const singleAliases = singleTokenAliases(entry);
    const own = entryTokens(entry);
    const matched: string[] = [];
    for (const token of inputTokens) {
      if (own.has(token) && isSignificant(token, aliases)) {
        matched.push(token);
      }
    }
    const aliasHits = matched.filter((token) => singleAliases.has(token)).length;
    let phrase = false;
    for (const keyword of entry.keywords) {
      const needle = matchTokens(keyword);
      if (needle.length >= 2 && containsPhrase(inputTokens, needle)) {
        phrase = true;
        break;
      }
    }
    if (matched.length === 0 && !phrase) {
      continue;
    }
    const score = matched.length + (phrase ? PHRASE_BONUS : 0);
    // A weak hit is one shared non-alias token with no phrase: too common to act on.
    const strong = phrase || aliasHits > 0 || matched.length >= 2;
    if (score < minScore || !strong) {
      continue;
    }
    matches.push({
      memory_id: entry.memory_id,
      uri: entry.uri,
      title: entry.title,
      nav_text: entry.nav_text,
      revision: entry.revision,
      keywords: entry.keywords,
      source_label: entry.source_label,
      source_count: entry.source_count,
      score,
      specificity: score / Math.max(1, own.size),
      matched_tokens: matched,
      phrase_matched: phrase,
      retention_score: retentionScore(entry, activitySeq),
      freshness: entry.freshness,
    });
  }

  matches.sort(
    (left, right) =>
      right.score - left.score ||
      right.specificity - left.specificity ||
      right.retention_score - left.retention_score ||
      left.memory_id.localeCompare(right.memory_id),
  );
  return matches.slice(0, Math.max(0, maxMatches));
}

export type { HotspotEntry, HotspotMatch };
