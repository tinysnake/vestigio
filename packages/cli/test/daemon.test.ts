/**
 * Daemon compatibility commands: the CLI must post the identity the invoker
 * gave it, resolve a session by identity when only the stable key is known, and
 * claim terminal results in relay mode so a stdout failure keeps them pending.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Submission } from "@vestigio/client";
import { main, type CliIo } from "../src/index.js";
import { captureIo } from "./support.js";
import { fakeDaemonClient, fakeEvent } from "./fake-client.js";

type RunResult = { code: number; out: string; err: string };

async function run(argv: readonly string[], client = fakeDaemonClient(), io: Partial<CliIo> = {}): Promise<RunResult> {
  const captured = captureIo();
  const code = await main(argv, { ...captured.io, ...io }, { createClient: () => client });
  return { code, out: captured.stdout(), err: captured.stderr() };
}

describe("vestigio submit", () => {
  it("posts the session identity, kind and parsed input", async () => {
    const submissions: Submission[] = [];
    const client = fakeDaemonClient({
      async submit(input) {
        submissions.push(input);
        return { jobId: "job-9", sessionRef: 4 };
      },
    });
    const result = await run(
      ["submit", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1", "--kind", "search", "--input", '{"q":1}', "--json"],
      client,
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out) as { jobId: string; sessionRef: number; request_id: string };
    expect(payload.jobId).toBe("job-9");
    expect(payload.sessionRef).toBe(4);
    expect(payload.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.session).toEqual({ source: "pi", sessionId: "s-1" });
    expect(submissions[0]?.kind).toBe("search");
    expect(submissions[0]?.input).toEqual({ q: 1 });
  });

  it("rejects an unknown kind before touching the daemon", async () => {
    const client = fakeDaemonClient();
    const result = await run(
      ["submit", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1", "--kind", "nope", "--input", "{}"],
      client,
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain("--kind must be one of maintenance, detector, search");
    expect(client.calls).toHaveLength(0);
  });

  it("rejects input that is not JSON", async () => {
    const result = await run(
      ["submit", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1", "--kind", "search", "--input", "not-json"],
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain("job input must be valid JSON");
  });

  it("requires a session identity", async () => {
    const result = await run(["submit", "--db", "/tmp/x.db", "--kind", "search", "--input", "{}"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("needs --source and --session-id");
  });

  it("reads the job input from --input-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vestigio-cli-"));
    const file = join(dir, "input.json");
    writeFileSync(file, '{"from":"file"}', "utf8");
    const submissions: Submission[] = [];
    const client = fakeDaemonClient({
      async submit(input) {
        submissions.push(input);
        return { jobId: "job-3", sessionRef: 7 };
      },
    });
    const result = await run(
      ["submit", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1", "--kind", "maintenance", "--input-file", file],
      client,
    );
    expect(result.code).toBe(0);
    expect(submissions[0]?.input).toEqual({ from: "file" });
  });

  it("rejects --input together with --input-file", async () => {
    const result = await run(
      ["submit", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1", "--kind", "search", "--input", "{}", "--input-file", "/nope.json"],
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain("mutually exclusive");
  });
});

describe("vestigio get/cancel/stop", () => {
  it("prints a job as JSON on request", async () => {
    const result = await run(["get", "--db", "/tmp/x.db", "--job", "job-1", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out) as { jobId: string }).jobId).toBe("job-1");
  });

  it("prints a job in human form by default", async () => {
    const result = await run(["get", "--db", "/tmp/x.db", "--job", "job-1"]);
    expect(result.out).toContain("job: job-1");
    expect(result.out).toContain("state: queued");
  });

  it("cancels through the daemon", async () => {
    const client = fakeDaemonClient();
    const result = await run(["cancel", "--db", "/tmp/x.db", "--job", "job-1"], client);
    expect(result.code).toBe(0);
    expect(result.out).toContain("cancelled=true");
    expect(client.calls).toContain("cancel:job-1");
  });

  it("stops through the daemon and reports the outcome", async () => {
    const result = await run(["stop", "--db", "/tmp/x.db"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("stopped=true");
  });

  it("requires --job for get", async () => {
    const result = await run(["get", "--db", "/tmp/x.db"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--job is required");
  });
});

describe("vestigio list", () => {
  it("resolves a session by identity before listing", async () => {
    const client = fakeDaemonClient({
      async list(sessionRef, after) {
        client.calls.push(`list:${sessionRef}:${after ?? ""}`);
        return { jobs: [{ jobId: "job-2", kind: "detector", state: "running", hasResult: false }], nextCursor: "c1" };
      },
    });
    const result = await run(["list", "--db", "/tmp/x.db", "--source", "pi", "--session-id", "s-1"], client);
    expect(result.code).toBe(0);
    expect(client.calls).toContain("session:pi/s-1");
    expect(client.calls).toContain("list:7:");
    expect(result.out).toContain("job-2");
    expect(result.out).toContain("next_cursor: c1");
  });

  it("passes the page cursor through to the daemon", async () => {
    const client = fakeDaemonClient();
    const result = await run(["list", "--db", "/tmp/x.db", "--session-ref", "7", "--after", "c0"], client);
    expect(result.code).toBe(0);
    expect(client.calls).toContain("list:7:c0");
  });

  it("rejects mixing --session-ref with a key", async () => {
    const result = await run([
      "list", "--db", "/tmp/x.db", "--session-ref", "7", "--source", "pi", "--session-id", "s-1",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("not both");
  });
});

describe("vestigio receive", () => {
  it("claims in relay mode, prints, then marks delivered", async () => {
    const order: string[] = [];
    const client = fakeDaemonClient({
      async receive() {
        order.push("receive");
        return [fakeEvent()];
      },
      async relayed(_sessionRef, eventIds) {
        order.push(`relayed:${eventIds.join(",")}`);
      },
    });
    const captured = captureIo();
    const code = await main(
      ["receive", "--db", "/tmp/x.db", "--session-ref", "7"],
      {
        ...captured.io,
        write: async (text) => {
          order.push("write");
          captured.io.out(text);
        },
      },
      { createClient: () => client },
    );
    expect(code).toBe(0);
    expect(order).toEqual(["receive", "write", "relayed:ev-1"]);
    expect(captured.stdout()).toContain("event: ev-1");
  });

  it("keeps a result pending when the stdout write fails", async () => {
    const client = fakeDaemonClient({
      async receive() {
        return [fakeEvent()];
      },
      async relayed() {
        client.calls.push("relayed");
      },
    });
    const captured = captureIo();
    const code = await main(
      ["receive", "--db", "/tmp/x.db", "--session-ref", "7"],
      { ...captured.io, write: async () => { throw new Error("EPIPE"); } },
      { createClient: () => client },
    );
    expect(code).toBe(1);
    expect(captured.stderr()).toContain("EPIPE");
    expect(client.calls).not.toContain("relayed");
  });
});

describe("vestigio watch", () => {
  it("delivers up to --count and exits", async () => {
    let received = 0;
    let relayed = 0;
    const client = fakeDaemonClient({
      async receive() {
        received += 1;
        return [fakeEvent()];
      },
      async relayed() {
        relayed += 1;
      },
    });
    const result = await run(["watch", "--db", "/tmp/x.db", "--session-ref", "7", "--count", "1", "--interval", "50"], client);
    expect(result.code).toBe(0);
    expect(result.out).toContain("event: ev-1");
    expect(received).toBe(1);
    expect(relayed).toBe(1);
  });
});
