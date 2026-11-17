import { describe, expect, it } from "vitest";
import { renderScript, type ScriptName } from "../../src/scripts.js";
import { UUID_A1 } from "../support/fake.js";

type Api = Record<string, (...args: never[]) => unknown>;

function never(): never {
  throw new Error("this API surface was not expected by the template");
}

function run(name: ScriptName, input: Record<string, unknown>, api: Api): unknown {
  const source = renderScript(name, input);
  const factory = new Function("search", "messages", "sessions", "sql", source);
  return factory(
    api["search"] ?? never,
    api["messages"] ?? never,
    api["sessions"] ?? never,
    api["sql"] ?? never,
  );
}

const baseSearchInput = {
  text: "zqleak",
  limit: 20,
  context_limit: 0,
  include_meta: false,
  include_inactive: false,
  project_path: null,
  session_id: null,
  after: null,
  before: null,
  source: null,
  session_lookup_limit: 11,
};

describe("search.query.mjs", () => {
  it("maps adapter options onto the API's option names", () => {
    let seen: { text: string; options: Record<string, unknown> } | undefined;
    run(
      "search",
      { ...baseSearchInput, text: "a \"quoted\" ${x} text", context_limit: 2, project_path: "/tmp/x_a" },
      {
        search: ((text: string, options: Record<string, unknown>) => {
          seen = { text, options };
          return [];
        }) as never,
      },
    );
    expect(seen?.text).toBe("a \"quoted\" ${x} text");
    expect(seen?.options).toEqual({
      limit: 20,
      contextLimit: 2,
      includeMeta: false,
      includeInactive: false,
      projectPath: "/tmp/x_a",
    });
  });

  it("omits the filters that were not requested", () => {
    let options: Record<string, unknown> | undefined;
    run("search", baseSearchInput, {
      search: ((_text: string, passed: Record<string, unknown>) => {
        options = passed;
        return [];
      }) as never,
    });
    expect(Object.hasOwn(options ?? {}, "projectPath")).toBe(false);
    expect(Object.hasOwn(options ?? {}, "sessionId")).toBe(false);
    expect(Object.hasOwn(options ?? {}, "after")).toBe(false);
    expect(Object.hasOwn(options ?? {}, "source")).toBe(false);
  });

  it("binds the message uuid as a SQL parameter and keeps the SQL constant", () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const result = run("search", { ...baseSearchInput, text: "'; DROP TABLE messages; --" }, {
      search: (() => [
        { message: { uuid: UUID_A1 }, session: { id: "s" }, rank: 1, context: [] },
      ]) as never,
      sql: ((sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return [{ parent_uuid: null, jsonl_path: "/f.jsonl", project_path: "/tmp/x_a" }];
      }) as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("WHERE m.uuid = ?");
    expect(calls[0]?.sql).not.toContain("DROP TABLE");
    expect(calls[0]?.params).toEqual([UUID_A1]);
    expect(result).toMatchObject({
      hits: [{ parent_uuid: null, jsonl_path: "/f.jsonl", project_path: "/tmp/x_a" }],
      session_found: null,
    });
  });

  it("reports an exact session match, not a substring decoy", () => {
    const decoys = [{ id: "pi:absent-v2" }, { id: "pi:absent-v3" }];
    const withExact = run("search", { ...baseSearchInput, session_id: "pi:absent" }, {
      search: (() => []) as never,
      sessions: (() => [...decoys, { id: "pi:absent" }]) as never,
    });
    const withoutExact = run("search", { ...baseSearchInput, session_id: "pi:absent" }, {
      search: (() => []) as never,
      sessions: (() => decoys) as never,
    });
    expect(withExact).toMatchObject({ session_found: true });
    expect(withoutExact).toMatchObject({ session_found: false });
  });
});

describe("messages.query.mjs", () => {
  it("asks for one bounded window with the session attached", () => {
    let seen: Record<string, unknown> | undefined;
    run(
      "messages",
      { anchor: UUID_A1, relation: "parents", before_count: 5, after_count: 0, include_inactive: false },
      {
        messages: ((options: Record<string, unknown>) => {
          seen = options;
          return null;
        }) as never,
      },
    );
    expect(seen).toEqual({
      around: UUID_A1,
      relation: "parents",
      beforeCount: 5,
      afterCount: 0,
      includeInactive: false,
      includeSession: true,
    });
  });

  it("turns a null window into found:false rather than an empty page", () => {
    expect(
      run("messages", { anchor: "h1", relation: "timeline", before_count: 0, after_count: 0, include_inactive: false }, {
        messages: (() => null) as never,
      }),
    ).toEqual({ found: false });
  });

  it("passes the window through with its flags", () => {
    const rows = [{ uuid: UUID_A1 }];
    expect(
      run("messages", { anchor: UUID_A1, relation: "timeline", before_count: 0, after_count: 0, include_inactive: false }, {
        messages: (() => ({ anchor: UUID_A1, messages: rows, session: { id: "s" }, hasMore: true, nextCursor: "c1" })) as never,
      }),
    ).toEqual({
      found: true,
      anchor: UUID_A1,
      messages: rows,
      session: { id: "s" },
      has_more: true,
      next_cursor: "c1",
    });
  });
});

describe("session.query.mjs", () => {
  it("filters the exact id out of the substring matches", () => {
    const rows = [
      { id: "pi:absent-v2", jsonl_path: "/wrong.jsonl" },
      { id: "pi:absent", jsonl_path: "/right.jsonl", project_path: "/tmp/x_a" },
    ];
    expect(
      run("session", { session_id: "pi:absent", lookup_limit: 11 }, { sessions: (() => rows) as never }),
    ).toMatchObject({ found: true, session: { id: "pi:absent", jsonl_path: "/right.jsonl" } });
  });

  it("reports not-found when only decoys come back", () => {
    expect(
      run("session", { session_id: "pi:absent", lookup_limit: 11 }, {
        sessions: (() => [{ id: "pi:absent-v2" }]) as never,
      }),
    ).toEqual({ found: false, session: null });
  });
});
