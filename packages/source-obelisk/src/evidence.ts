/**
 * Which indexed row makes usable evidence.
 *
 * Tool traffic is not knowledge: a memory tool's own output repeats the words
 * of the question, so it matches as well as the answer and outranks it.
 * Reasoning rows (`thinking`) are the model talking to itself; the conclusion
 * is restated in its reply, which is the row worth carrying.
 *
 * A read window keeps `tool_result` on purpose: a command's output is often the
 * evidence itself, and the window is already anchored on a hit that mattered.
 */

const SEARCH_NOISE: ReadonlySet<string> = new Set(["tool_use", "tool_result", "thinking"]);
const WINDOW_NOISE: ReadonlySet<string> = new Set(["tool_use", "thinking"]);

/** True for a row a keyword search should not rank as a hit. */
export function isSearchNoise(content_type: string | null): boolean {
  return content_type !== null && SEARCH_NOISE.has(content_type);
}

/** True for a row a bounded read window should not carry as evidence. */
export function isWindowNoise(content_type: string | null): boolean {
  return content_type !== null && WINDOW_NOISE.has(content_type);
}
