/**
 * Probe extension: append a fixed marker to the END of every user input.
 * The append string is taken from PROBE_APPEND (default "\n\n[VESTIGIO_PROBE_MARKER]").
 * Set PROBE_THROW=1 to make the handler throw.
 *
 * Supplementary (NOT primary) evidence: each invocation is recorded to PROBE_EVENTS
 * so the harness can map which source/streamingBehavior produced each wire capture.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		if (process.env.PROBE_THROW === "1") {
			record(event, "THROW");
			throw new Error("PROBE_HANDLER_THROW");
		}
		if (event.text.includes("<noappend>")) {
			record(event, "continue-noappend");
			return { action: "continue" };
		}
		const append = process.env.PROBE_APPEND ?? "\n\n[VESTIGIO_PROBE_MARKER]";
		const out = `${event.text}${append}`;
		record(event, "transform");
		return { action: "transform", text: out };
	});

	// Trigger an extension-source user message via pi.sendUserMessage().
	pi.registerCommand("probe-ext-send", {
		description: "Send an extension-source user message",
		handler: async (args) => {
			await pi.sendUserMessage(args || "EXT_DEFAULT_TEXT", { expandPromptTemplates: true });
		},
	});
}

function record(event: any, action: string) {
	const path = process.env.PROBE_EVENTS;
	if (!path) return;
	try {
		appendFileSync(
			path,
			JSON.stringify({
				ts: new Date().toISOString(),
				source: event.source,
				streamingBehavior: event.streamingBehavior,
				textIn: event.text,
				action,
			}) + "\n",
		);
	} catch {}
}
