/**
 * Node module hook for the PR-06 resolver harness.
 *
 * `eval/resolver` is not a workspace package, so it has no node_modules of its
 * own. This maps every `@vestigio/*` specifier straight onto the workspace
 * source and rewrites NodeNext `./x.js` specifiers to the `.ts` files they
 * refer to, so `node --import ./hook.mjs <script>` can drive the real resolver,
 * the real OpenAI-compatible client and the real store API from source.
 */

import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");

const BARE = {
  "@vestigio/core": `${ROOT}/packages/core/src/contracts/index.ts`,
  "@vestigio/core/storage": `${ROOT}/packages/core/src/storage/index.ts`,
  "@vestigio/core/hotspots": `${ROOT}/packages/core/src/hotspots/index.ts`,
  "@vestigio/core/retrieval": `${ROOT}/packages/core/src/retrieval/index.ts`,
  "@vestigio/core/resolver": `${ROOT}/packages/core/src/resolver/index.ts`,
  "@vestigio/model-client": `${ROOT}/packages/model-client/src/index.ts`,
  "@vestigio/source-obelisk": `${ROOT}/packages/source-obelisk/src/index.ts`,
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
