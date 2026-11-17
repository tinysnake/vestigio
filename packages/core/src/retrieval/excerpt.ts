/**
 * Bounded history excerpts.
 *
 * The history layer is the only layer that can hand back an unbounded body, so
 * every excerpt it emits goes through here. Truncation is never silent: the
 * kept text carries a marker that names how many code points were dropped, and
 * the caller gets `truncated`, the full count and the excerpt count.
 */

import { codePointCount } from "../contracts/index.js";

export type BoundedExcerpt = {
  excerpt: string;
  truncated: boolean;
  full_char_count: number;
  excerpt_char_count: number;
  truncation_marker: string | null;
};

/** The marker is part of the emitted excerpt, so its cost is visible in bytes. */
export function truncationMarker(omitted_char_count: number): string {
  return `…[truncated ${omitted_char_count} more characters]`;
}

export function boundExcerpt(text: string, maxChars: number): BoundedExcerpt {
  const full = codePointCount(text);
  if (full <= maxChars) {
    return {
      excerpt: text,
      truncated: false,
      full_char_count: full,
      excerpt_char_count: full,
      truncation_marker: null,
    };
  }
  const kept = [...text].slice(0, maxChars).join("");
  const marker = truncationMarker(full - maxChars);
  const excerpt = `${kept}${marker}`;
  return {
    excerpt,
    truncated: true,
    full_char_count: full,
    excerpt_char_count: codePointCount(excerpt),
    truncation_marker: marker,
  };
}
