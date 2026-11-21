import { applyConfigToEnv } from "@vestigio/config";
import { main } from "./index.js";

applyConfigToEnv();
process.exitCode = await main(process.argv.slice(2));
