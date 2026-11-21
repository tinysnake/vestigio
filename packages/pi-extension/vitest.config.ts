import { defineConfig } from "vitest/config";

// Unit tests never read the operator's ~/.vestigio/config.json; they set the
// variables they need and an empty VESTIGIO_CONFIG keeps the default file out.
export default defineConfig({
	test: {
		env: {
			VESTIGIO_CONFIG: "",
		},
	},
});
