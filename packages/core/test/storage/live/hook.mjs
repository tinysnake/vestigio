// Maps the repo's NodeNext `.js` specifiers back to the `.ts` sources they
// name, so the live-proof processes run the real store without a build step.
// Node's own type stripping handles the file bodies.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
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
