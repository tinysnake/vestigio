/**
 * The one place a probe stops the daemons it started.
 *
 * A probe that spawns pi or runs the CLI leaves a detached daemon per store, so
 * every probe ends in the same two steps: stop each store's daemon, then report
 * the stores that survived. Reporting is the point. `stop()` is asynchronous
 * and can return while the process is still listening, so a probe that only
 * calls it can claim three daemons stopped and leave three running.
 *
 * Callers decide how loud a leak is: an exit code, a failing check, a line on
 * stderr. Returning the stores keeps that policy at the call site.
 */

import { daemonRunning, VestigioClient } from "../../packages/client/src/index.ts";

export async function stopProbeDaemons(stores) {
	const leaked = [];
	for (const store of stores) {
		await new VestigioClient(store).stop();
		if (await daemonRunning(store)) leaked.push(store);
	}
	return leaked;
}
