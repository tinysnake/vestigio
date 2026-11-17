/**
 * Controlled scripts.
 *
 * The three templates in `src/scripts/` are fixed, reviewable programs. The
 * adapter substitutes exactly one token, `__OBELISK_INPUT__`, with a single
 * JSON literal — never with a fragment of JavaScript. Caller data therefore
 * reaches the sandbox as parsed data and is bound as an option value or a SQL
 * parameter inside the template; it can never become code. A template that
 * lost or gained its token fails loudly instead of quietly running something
 * else.
 */

import { readFileSync } from "node:fs";
import { obeliskError } from "./errors.js";

export type ScriptName = "search" | "messages" | "session";

const INPUT_TOKEN = "__OBELISK_INPUT__";

const SCRIPTS: Record<ScriptName, URL> = {
  search: new URL("./scripts/search.query.mjs", import.meta.url),
  messages: new URL("./scripts/messages.query.mjs", import.meta.url),
  session: new URL("./scripts/session.query.mjs", import.meta.url),
};

const templates = new Map<ScriptName, string>();

export function templateSource(name: ScriptName): string {
  const cached = templates.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(SCRIPTS[name], "utf8");
  templates.set(name, text);
  return text;
}

/**
 * JSON, not JavaScript: the value is a literal that `JSON.parse` consumes on
 * the first line of the template. U+2028/U+2029 are escaped so the literal is
 * also safe inside a string that some tool may later re-parse.
 */
export function encodeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (typeof json !== "string") {
    throw obeliskError("protocol", "script input is not JSON-serialisable", { expected: "a plain object" });
  }
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderScript(name: ScriptName, input: Record<string, unknown>): string {
  const template = templateSource(name);
  const first = template.indexOf(INPUT_TOKEN);
  if (first < 0) {
    throw obeliskError("protocol", `script ${name} lost its input token`, {
      expected: `exactly one ${INPUT_TOKEN}`,
    });
  }
  if (template.indexOf(INPUT_TOKEN, first + INPUT_TOKEN.length) >= 0) {
    throw obeliskError("protocol", `script ${name} has more than one input token`, {
      expected: `exactly one ${INPUT_TOKEN}`,
    });
  }
  return template.slice(0, first) + encodeInput(input) + template.slice(first + INPUT_TOKEN.length);
}
