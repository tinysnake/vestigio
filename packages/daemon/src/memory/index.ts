/**
 * The daemon's memory surface.
 *
 * `contract.ts` is the wire schema: operation names, per-operation inputs and
 * validators, with no runtime imports, so a client can depend on the shape
 * without loading the daemon. Everything else is daemon-internal; importing the
 * module graph from `runtime.ts` brings in `@vestigio/core`,
 * `@vestigio/model-client` and `@vestigio/source-obelisk`.
 *
 * `entry.ts` calls `createMemoryHandler(storePath)`; tests build a runtime over a
 * temp store and call `createMemoryJobHandler(runtime)` directly.
 */

import { createMemoryJobHandler } from "./handler.js";
import { openMemoryRuntime, type MemoryRuntime, type MemoryRuntimeOptions } from "./runtime.js";

export * from "./contract.js";
export * from "./runtime.js";
export * from "./handler.js";
export * from "./search.js";
export * from "./detector.js";
export * from "./maintenance.js";
export * from "./render.js";

/**
 * The handler factory the daemon process calls. Opens the store at `storePath`
 * and reads the model/history configuration from the environment; an
 * unconfigured model or history degrades the same way it does in the extension.
 */
export function createMemoryHandler(storePath: string, options: MemoryRuntimeOptions = {}) {
  return createMemoryJobHandler(openMemoryRuntime(storePath, options));
}

export type { MemoryRuntime, MemoryRuntimeOptions };
