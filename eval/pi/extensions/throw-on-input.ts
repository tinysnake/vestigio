/**
 * Test-only extension for the "handler error" harness case.
 *
 * It throws from an `input` handler so the run proves pi's behaviour when one
 * handler in the chain fails: the error is logged by pi, the other handlers
 * still run, and the prompt is never corrupted. It registers nothing else.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function throwOnInput(pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		if (process.env.VESTIGIO_TEST_THROW !== "1") return;
		// Match the earlier probe: only throw when the text asks for it, so the
		// same extension can be reused for a non-throwing control run.
		if (event.text.includes("THROW_NOW")) {
			throw new Error("VESTIGIO_TEST_HANDLER_THROW");
		}
	});
}
