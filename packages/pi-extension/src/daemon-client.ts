import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VestigioClient, type Event, type Kind, type SessionKey } from "@vestigio/client";

export function sessionOf(ctx: ExtensionContext): SessionKey {
	return { source: "pi", sessionId: ctx.sessionManager.getSessionId() };
}

/**
 * The text a failed call shows the agent. A dependency failure carries the
 * parent's result code, while the reason lives in the child outcomes; naming
 * them keeps the failure actionable instead of returning a bare code.
 */
export function failureMessage(result: unknown, resultCode: string): string {
	if (typeof result !== "object" || result === null) return resultCode;
	const record = result as Record<string, unknown>;
	if ("error" in record) return String(record.error);
	const children = Array.isArray(record.children) ? record.children : [];
	const reasons: string[] = [];
	for (const child of children) {
		if (typeof child !== "object" || child === null) continue;
		const entry = child as Record<string, unknown>;
		if (entry.status === "succeeded") continue;
		const inner = entry.result;
		const detail =
			typeof inner === "object" && inner !== null && "error" in inner
				? String((inner as Record<string, unknown>).error)
				: String(entry.resultCode ?? entry.status ?? "failed");
		reasons.push(`${String(entry.jobId ?? "child")}: ${detail}`);
	}
	return reasons.length > 0 ? `${resultCode}: ${reasons.join("; ")}` : resultCode;
}

export class PiDaemon {
	private readonly client: VestigioClient;
	private subscription: AbortController | undefined;
	private sessionId: string | undefined;
	private epoch = 0;
	private readonly recent = new Map<string, Event>();
	private onResult: ((event: Event) => void) | undefined;

	constructor(storePath: string) {
		this.client = new VestigioClient(storePath);
	}

	bind(ctx: ExtensionContext, onResult: (event: Event) => void): void {
		this.epoch++;
		this.onResult = onResult;
		this.subscribe(ctx);
	}

	private subscribe(ctx: ExtensionContext): void {
		const session = sessionOf(ctx);
		if (session.sessionId === this.sessionId) return;
		this.subscription?.abort();
		this.recent.clear();
		this.sessionId = session.sessionId;
		const controller = new AbortController();
		this.subscription = controller;
		void this.listen(session, controller.signal);
	}

	close(): void {
		this.epoch++;
		this.subscription?.abort();
		this.subscription = undefined;
		this.sessionId = undefined;
		this.onResult = undefined;
		this.recent.clear();
	}

	private async listen(session: SessionKey, signal: AbortSignal): Promise<void> {
		try {
			const { sessionRef } = await this.client.session(session);
			for await (const event of this.client.events(sessionRef, signal)) {
				if (signal.aborted) return;
				this.recent.set(event.jobId, event);
				if (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!);
				this.onResult?.(event);
			}
		} catch (error) {
			if (!signal.aborted && process.env.VESTIGIO_DEBUG) console.error(error);
		} finally {
			if (this.subscription?.signal === signal) {
				this.sessionId = undefined;
			}
		}
	}

	async submit(ctx: ExtensionContext, kind: Kind, requestId: string, input: unknown) {
		this.subscribe(ctx);
		return this.client.submit({ session: sessionOf(ctx), kind, requestId, input });
	}

	async run(ctx: ExtensionContext, kind: Kind, requestId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
		const epoch = this.epoch;
		const { jobId } = await this.submit(ctx, kind, requestId, input);
		let compactSeenAt: number | undefined;
		for (;;) {
			signal?.throwIfAborted();
			if (epoch !== this.epoch) throw new Error("The active branch changed");
			const job = this.recent.get(jobId) ?? await this.client.get(jobId, signal);
			signal?.throwIfAborted();
			if (epoch !== this.epoch) throw new Error("The active branch changed");
			if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
				const result = this.recent.get(jobId)?.result ?? job.result;
				// The SSE write may be reclaimed before this connection reads its frame.
				if (result === undefined && this.subscription) {
					compactSeenAt ??= performance.now();
					if (performance.now() - compactSeenAt < 500) {
						await delay(20, undefined, signal ? { signal } : {});
						continue;
					}
				}
				if (job.state !== "succeeded") {
					throw new Error(failureMessage(result, String(job.resultCode)));
				}
				if (result === undefined) throw new Error("The detailed job result has already been delivered");
				return result;
			}
			await delay(20, undefined, signal ? { signal } : {});
		}
	}
}
