/**
 * The per-call observation decorator (OBS-05).
 *
 * `createAgentModelPort` accepts an optional observer and wraps its port with
 * this. The wrapper only ever reads: it times `complete`, reports one event
 * after the result is in hand, and returns the very same `ModelResult`. An
 * observer that throws is contained here, so a broken log can never fail,
 * delay past the call, or change what the caller sees.
 */

import type { ModelCallObserver } from "@vestigio/core/observability";
import type { ModelPort, ModelRequest, ModelResult } from "@vestigio/core/resolver";

export type { ModelCallEvent, ModelCallObserver } from "@vestigio/core/observability";

export function observeModelCalls(port: ModelPort, observer: ModelCallObserver): ModelPort {
	return {
		async complete(request: ModelRequest): Promise<ModelResult> {
			const started = performance.now();
			const result = await port.complete(request);
			try {
				observer({ request, result, elapsed_ms: performance.now() - started });
			} catch {
				/* Observation never changes the result. */
			}
			return result;
		},
	};
}
