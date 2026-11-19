/**
 * One question to a real model, through the pi CLI, with the cost kept.
 *
 * Both `usage.mjs` and `generate-candidates.mjs` need the same thing: send a
 * prompt, get the assistant text, and keep duration, tokens and cost so the
 * report can say what a call cost instead of guessing.
 */

import { execFileSync } from "node:child_process";

/** Borrowed from the `feature, refactoring` row of ~/.pstack/models.md, low thinking. */
export const DEFAULT_MODEL = "magpie/auto/deepseek-v4.1-flash:low";

export function ask({ text, model = DEFAULT_MODEL, system }) {
	const args = ["-p", "--no-session", "--no-tools", "--mode", "json"];
	if (system !== undefined) args.push("--system-prompt", system);
	args.push("--model", model, text);
	const started = Date.now();
	const stdout = execFileSync("pi", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	const wall = Date.now() - started;
	let reply = null;
	let usage = null;
	let durationMs = null;
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const content = event.message.content;
		reply = Array.isArray(content)
			? content.filter((part) => part.type === "text").map((part) => part.text).join("")
			: "";
		usage = event.message.usage ?? null;
		durationMs = event.message.durationMs ?? null;
	}
	return {
		reply,
		wall_ms: wall,
		duration_ms: durationMs,
		input_tokens: usage?.input ?? null,
		output_tokens: usage?.output ?? null,
		cost_usd: usage?.cost?.total ?? null,
	};
}

/** The first JSON object or array in a reply, tolerating fences and prose. */
export function parseJson(reply) {
	if (typeof reply !== "string") return null;
	const start = reply.indexOf("{") === -1 ? reply.indexOf("[") : reply.indexOf("{");
	const end = Math.max(reply.lastIndexOf("}"), reply.lastIndexOf("]"));
	if (start === -1 || end === -1 || end < start) return null;
	try {
		return JSON.parse(reply.slice(start, end + 1));
	} catch {
		return null;
	}
}
