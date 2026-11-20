import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { captureIo } from "./support.js";
import { fakeDaemonClient, fakeEvent } from "./fake-client.js";

const args = ["jobs", "run", "--db", "test.sqlite"];

describe("vestigio jobs run", () => {
  it("submits navigation to the maintenance pool and delivers its result", async () => {
    const captured = captureIo();
    const result = { claimed: 1, completed: 1 };
    const client = fakeDaemonClient({
      async submit(submission) {
        expect(submission).toMatchObject({ kind: "maintenance", input: { op: "nav.run", limit: 2 } });
        return { jobId: "job-1", sessionRef: 7 };
      },
      async receive(sessionRef, relay) {
        expect([sessionRef, relay]).toEqual([7, true]);
        return [fakeEvent({ result: { result } })];
      },
      async relayed(sessionRef, ids) {
        expect([sessionRef, ids]).toEqual([7, ["ev-1"]]);
        expect(JSON.parse(captured.stdout())).toEqual(result);
      },
    });
    expect(await main([...args, "--limit", "2", "--json"], captured.io, {
      createClient: () => client,
      open: () => { throw new Error("CLI opened the store"); },
    })).toBe(0);
  });

  it("rejects per-command model overrides", async () => {
    const captured = captureIo();
    expect(await main([...args, "--model-id", "other"], captured.io)).toBe(2);
    expect(captured.stderr()).toContain("daemon's VESTIGIO_MODEL_*");
  });

  it("rejects a missing subcommand", async () => {
    const captured = captureIo();
    expect(await main(["jobs", "--db", "test.sqlite"], captured.io)).toBe(2);
    expect(captured.stderr()).toContain("jobs needs exactly one subcommand: run");
  });
});
