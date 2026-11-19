/**
 * Node module hook for the PR-05 harness scripts.
 *
 * `eval/pi` is not a workspace package, so it has no node_modules of its own.
 * This maps the `@vestigio/core` specifiers straight onto the workspace source
 * and rewrites NodeNext `./x.js` specifiers to the `.ts` files they refer to, so
 * `node --import ./hook.mjs seed.mjs` can use the real store API from source
 * (the same trick `packages/cli/hook.mjs` uses for the CLI).
 */

import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolvePath(HERE, "../../packages/core/src");

const BARE = {
	"@vestigio/core": `${CORE}/contracts/index.ts`,
	"@vestigio/core/storage": `${CORE}/storage/index.ts`,
	"@vestigio/core/hotspots": `${CORE}/hotspots/index.ts`,
	"@vestigio/core/retrieval": `${CORE}/retrieval/index.ts`,
	"@vestigio/core/resolver": `${CORE}/resolver/index.ts`,
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		const mapped = BARE[specifier];
		if (mapped !== undefined) {
			return { url: pathToFileURL(mapped).href, shortCircuit: true };
		}
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			}
			throw error;
		}
	},
});
