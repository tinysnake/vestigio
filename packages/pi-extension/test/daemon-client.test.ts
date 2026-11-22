import { describe, expect, it } from "vitest";
import { failureMessage } from "../src/daemon-client.js";

describe("failureMessage", () => {
	it("keeps a bare result code when the result carries no detail", () => {
		expect(failureMessage(undefined, "dependency_failed")).toBe("dependency_failed");
	});

	it("prefers the job's own error", () => {
		expect(failureMessage({ error: "model unavailable" }, "error")).toBe("model unavailable");
	});

	it("names each failed child and the reason it failed", () => {
		const result = {
			children: [
				{ jobId: "job-ok", status: "succeeded", resultCode: "ok", result: { ok: true } },
				{
					jobId: "job-child",
					status: "failed",
					resultCode: "error",
					result: { error: "hits must be a non-empty array of at most 256 objects" },
				},
			],
		};

		expect(failureMessage(result, "dependency_failed")).toBe(
			"dependency_failed: job-child: hits must be a non-empty array of at most 256 objects",
		);
	});
});
