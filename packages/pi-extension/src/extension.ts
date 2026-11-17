/**
 * Vestigio pi extension (PR-05).
 *
 * Two jobs, both bounded:
 *   1. On a real user input, append a bounded memory block to the end of that
 *      same message when a project hotspot matches. This uses only the `input`
 *      handler's `transform`, which is the one place pi lets an extension rewrite
 *      the user's text.
 *   2. Register `memory_search` / `memory_read` so the agent can pull the full
 *      long summary on demand.
 *
 * Nothing here touches the system prompt. The hotspot pool and its keywords are
 * read from the local store and never sent anywhere except inside the appended
 * block of a matched turn.
 *
 * The extension is inert until `VESTIGIO_STORE` names a store. Loading never
 * throws: a broken memory layer must not stop pi from starting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.js";
import { handleInput } from "./input.js";
import { VestigioState } from "./state.js";
import { registerMemoryTools } from "./tools.js";

export default function vestigio(pi: ExtensionAPI): void {
	const config = readConfig();
	if (!config.enabled) return;

	const state = new VestigioState(config);

	pi.on("session_start", async (_event, ctx) => {
		state.bindSession(ctx.sessionManager);
	});

	// Fires when the session tree moves: a branch switch, a revert, a fork
	// landing. Re-reading the branch is what keeps fork inheritance and revert
	// forgetting correct.
	pi.on("session_tree", async (_event, ctx) => {
		state.bindSession(ctx.sessionManager);
	});

	pi.on("session_shutdown", async () => {
		state.close();
	});

	pi.on("input", (event, ctx) => handleInput(state, event, ctx, pi));

	registerMemoryTools(pi, state);
}

export { VestigioState } from "./state.js";
export { readConfig } from "./config.js";
export { handleInput } from "./input.js";
export { registerMemoryTools } from "./tools.js";
