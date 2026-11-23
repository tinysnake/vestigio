import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LayeredSearchOutcome, MemoryReadOutcome } from "@vestigio/core/retrieval";
import type { ModelPort } from "@vestigio/core/resolver";
import { openStore, type MemoryStore, type ProjectReassignment } from "@vestigio/core/storage";
import { main } from "../src/index.js";
import { PROJECT_A, captureIo, historyHit, makeHistoryPort, type FakeHistoryOptions, seed, sourceRef, tempDbPath } from "./support.js";

const stores: MemoryStore[] = [];

/** Any directory works for unit tests: the history port is faked. */
const FIXTURE_HOME = "/tmp/vestigio-cli-test-home";

function track(store: MemoryStore): MemoryStore {
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

type RunResult = { code: number; out: string; err: string };

async function run(
  argv: readonly string[],
  extra: { history?: FakeHistoryOptions; model?: ModelPort } = {},
): Promise<RunResult & { fake: ReturnType<typeof makeHistoryPort> }> {
  const captured = captureIo();
  const fake = makeHistoryPort(extra.history ?? {});
  const code = await main(argv, captured.io, {
    open: (options) => track(openStore(options)),
    createHistoryPort: () => fake.port,
    ...(extra.model === undefined ? {} : { createModel: () => extra.model as ModelPort }),
  });
  return { code, out: captured.stdout(), err: captured.stderr(), fake };
}

function judgeModel(replies: readonly string[]): { port: ModelPort; calls: () => number } {
  let calls = 0;
  const port: ModelPort = {
    async complete() {
      const text = replies[Math.min(calls, replies.length - 1)] ?? "";
      calls += 1;
      return {
        ok: true,
        value: {
          text,
          usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.0001 },
          model: "fake",
          finish_reason: "stop",
        },
      };
    },
  };
  return { port, calls: () => calls };
}

function decision(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    sufficient: false,
    answer: null,
    evidence_ids: [],
    read_uris: [],
    next_queries: [],
    conflicts: [],
    descend: false,
    ...overrides,
  });
}

/** Seed a project A store at a fresh path and return the closed-over path. */
function seedStore(seedFn: (store: MemoryStore) => void, label = "cli"): string {
  const path = tempDbPath(label);
  const store = openStore({ path });
  seedFn(store);
  store.close();
  return path;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

describe("cli usage", () => {
  it("prints help and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("vestigio — layered memory inspection");
  });

  it("rejects an unknown command with exit 2", async () => {
    const result = await run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command");
  });

  it("falls back to VESTIGIO_DB when --db is absent", async () => {
    const path = tempDbPath();
    const previous = process.env["VESTIGIO_DB"];
    process.env["VESTIGIO_DB"] = path;
    try {
      const result = await run(["search", "--project", PROJECT_A, "--query", "端口", "--json"]);
      expect(result.code).toBe(0);
      expect(result.err).not.toContain("--db is required");
    } finally {
      if (previous === undefined) delete process.env["VESTIGIO_DB"];
      else process.env["VESTIGIO_DB"] = previous;
    }
  });

  it("requires --db, --query and a scope", async () => {
    expect((await run(["search"])).err).toContain("--db is required");
    const path = seedStore(() => {});
    expect((await run(["search", "--db", path])).err).toContain("--query is required");
    expect((await run(["search", "--db", path, "--query", "端口"])).err).toContain("or --global is required");
  });

  it("refuses a non-normalised project path so store scope and history agree", async () => {
    const path = seedStore(() => {});
    for (const bad of ["/tmp//proj-a", "tmp/proj-a", "/tmp/proj-a/"]) {
      const result = await run(["search", "--db", path, "--project", bad, "--query", "端口"]);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/absolute path|normalised|path separator/u);
    }
  });

  it("rejects --project together with --global", async () => {
    const path = seedStore(() => {});
    const result = await run(["search", "--db", path, "--project", PROJECT_A, "--global", "--query", "端口"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("mutually exclusive");
  });

  it("rejects a card limit outside the frozen cap", async () => {
    const path = seedStore(() => {});
    const result = await run(["search", "--db", path, "--global", "--query", "端口", "--limit", "11"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--limit must be an integer from 1 to 10");
  });
});

describe("cli search", () => {
  it("returns only Active cards in the default ranking and widens to Archived on request", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
      seed(store, { memory_id: "mem-archived", nav_text: "归档的端口约定。", state: "archived" });
    });

    const base = ["search", "--db", path, "--project", PROJECT_A, "--query", "端口", "--json"];
    const plain = await run(base);
    expect(plain.code).toBe(0);
    const outcome = parseJson<LayeredSearchOutcome>(plain.out);
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-active"]);
    expect(outcome.layers.find((layer) => layer.layer === "archived")?.status).toBe("skipped");
    expect(outcome.result.budget_used.model_calls).toBe(0);
    expect(plain.fake.calls.probe).toBe(0);

    const widened = await run([...base, "--archived"]);
    const widenedOutcome = parseJson<LayeredSearchOutcome>(widened.out);
    expect(widenedOutcome.result.cards.map((card) => card.memory_id)).toEqual(["mem-active", "mem-archived"]);
    expect(widenedOutcome.layers.find((layer) => layer.layer === "archived")?.reason).toBe("explicit");
  });

  it("prints a human summary with the layer table and the next action", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
    });
    const result = await run(["search", "--db", path, "--project", PROJECT_A, "--query", "端口"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("status: partial");
    expect(result.out).toContain("layers:");
    expect(result.out).toContain("active: matched");
    expect(result.out).toContain("archived: skipped (candidates 0, emitted 0, reason not_consulted)");
    expect(result.out).toContain("next_action: widen:archived");
    expect(result.out).not.toContain("history_index:");
  });

  it("reaches history through the injected port only when asked, with bounded excerpts", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
    });
    const long = `zqleak ${"长".repeat(120)}`;

    const untouched = await run(
      ["search", "--db", path, "--project", PROJECT_A, "--query", "端口", "--json"],
      { history: { hits: [historyHit(long)] } },
    );
    expect(untouched.fake.calls.search).toBe(0);

    const widened = await run(
      [
        "search",
        "--db",
        path,
        "--project",
        PROJECT_A,
        "--query",
        "端口",
        "--history",
        "--obelisk-home",
        FIXTURE_HOME,
        "--history-excerpt-chars",
        "32",
        "--json",
      ],
      { history: { hits: [historyHit(long)] } },
    );
    expect(widened.code).toBe(0);
    const outcome = parseJson<LayeredSearchOutcome>(widened.out);
    expect(widened.fake.calls.search).toBe(1);
    expect(widened.fake.calls.last_search).toEqual({ text: "端口", project_path: PROJECT_A, limit: 3 });
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("matched");
    expect(history?.evidence).toBe("ids_only");
    expect(outcome.history.length).toBe(1);
    expect(outcome.history[0]?.truncated).toBe(true);
    expect(outcome.history[0]?.excerpt).toContain("…[truncated");
    expect(outcome.history[0]?.source_ref.message_id).toBe("h-1");
    expect(outcome.measured.history_available).toBe(true);
    expect(outcome.result.evidence.some((ref) => ref.message_id === "h-1")).toBe(true);
  });

  it("reports an unavailable history source without failing the command", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
    });
    const result = await run(
      [
        "search",
        "--db",
        path,
        "--project",
        PROJECT_A,
        "--query",
        "端口",
        "--history",
        "--obelisk-home",
        FIXTURE_HOME,
        "--json",
      ],
      { history: { available: false, reason: "index_missing" } },
    );
    expect(result.code).toBe(0);
    const outcome = parseJson<LayeredSearchOutcome>(result.out);
    const history = outcome.layers.find((layer) => layer.layer === "history");
    expect(history?.status).toBe("unavailable");
    expect(history?.reason).toBe("index_missing");
    expect(outcome.result.missing).toContain("history:unavailable:index_missing");
  });

  it("refuses to reach a history source without an explicit --obelisk-home", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
    });
    for (const command of [
      ["search", "--db", path, "--project", PROJECT_A, "--query", "端口", "--history"],
      ["search", "--db", path, "--project", PROJECT_A, "--query", "端口", "--history-read"],
      ["probe", "--db", path],
    ]) {
      const result = await run(command);
      expect(result.code).toBe(2);
      expect(result.err).toContain("--obelisk-home <dir> is required");
      // The point of the refusal: no port is built, so nothing can spawn the CLI.
      expect(result.fake.calls.probe).toBe(0);
      expect(result.fake.calls.search).toBe(0);
      expect(result.fake.calls.readByAnchor).toBe(0);
    }
  });
});

describe("cli read", () => {
  it("reads one memory by uri", async () => {
    let uri = "";
    const path = seedStore((store) => {
      uri = seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" }).uri;
    });

    const result = await run(["read", "--db", path, "--uri", uri, "--json"]);
    expect(result.code).toBe(0);
    const outcome = parseJson<MemoryReadOutcome>(result.out);
    expect(outcome.result.status).toBe("resolved");
    expect(outcome.result.memory_summary).not.toBeNull();
    expect(outcome.result.memory_uri).toBe(uri);
    expect(outcome.result.navigation_status).toBe("ready");
    expect(outcome.result.budget_used.model_calls).toBe(0);
  });

  it("reports not_found for an unknown uri without a failure exit code", async () => {
    const path = seedStore(() => {});
    const result = await run(["read", "--db", path, "--uri", "memory://vestigio/mem-9999", "--json"]);
    expect(result.code).toBe(0);
    const outcome = parseJson<MemoryReadOutcome>(result.out);
    expect(outcome.result.status).toBe("not_found");
    expect(outcome.result.memory_summary).toBeNull();
  });

  it("prints a human read summary with the medium body", async () => {
    let uri = "";
    const path = seedStore((store) => {
      uri = seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" }).uri;
    });
    const result = await run(["read", "--db", path, "--uri", uri]);
    expect(result.out).toContain("status: resolved");
    expect(result.out).toContain("--- summary ---");
    expect(result.out).toContain("navigation: ready");
  });
});

describe("cli probe", () => {
  it("reports store integrity and the resolved history index", async () => {
    const path = seedStore((store) => {
      seed(store, { memory_id: "mem-active" });
    });
    const result = await run(["probe", "--db", path, "--obelisk-home", "/tmp/fixture-home", "--json"]);
    expect(result.code).toBe(0);
    const payload = parseJson<{
      store: { integrity_ok: boolean; heads: number; active_index_rows: number };
      history: { available: boolean; reason: string | null; index: string; home: string };
    }>(result.out);
    expect(payload.store.integrity_ok).toBe(true);
    expect(payload.store.heads).toBe(1);
    expect(payload.store.active_index_rows).toBe(1);
    expect(payload.history.available).toBe(true);
    expect(payload.history.index).toBe("/tmp/fixture-home/.obelisk/obelisk.sqlite");
    expect(payload.history.home).toBe("/tmp/fixture-home");
  });

  it("reports an unavailable history source in the human output", async () => {
    const path = seedStore(() => {});
    const result = await run(
      ["probe", "--db", path, "--obelisk-home", "/tmp/fixture-home"],
      { history: { available: false, reason: "cli_missing" } },
    );
    expect(result.out).toContain("history: unavailable (cli_missing)");
    expect(result.out).toContain("history_index: /tmp/fixture-home/.obelisk/obelisk.sqlite");
  });
});

describe("cli resolve", () => {
	it("resolves from Active with the configured model and reports the measured budget", async () => {
		const path = seedStore((store) => {
			seed(store, { memory_id: "mem-active", nav_text: "部署配置与默认端口。" });
		});
		const model = judgeModel([
			decision({ sufficient: true, answer: "默认端口是部署脚本里的那个值。", evidence_ids: ["mem-active"] }),
		]);
		const result = await run(
			[
				"resolve",
				"--db",
				path,
				"--project",
				PROJECT_A,
				"--question",
				"端口",
				"--model-base-url",
				"http://127.0.0.1:9/v1",
				"--model-id",
				"test-model",
				"--cost-input",
				"0.15",
				"--cost-output",
				"0.6",
				"--json",
			],
			{ model: model.port },
		);
		expect(result.code).toBe(0);
		const payload = parseJson<{
			result: { status: string; answer: string | null; budget_used: { model_calls: number; cost_usd: number | null } };
			layers: { layer: string; status: string }[];
			measured: { model_calls: number; tokens_in: number; cost_usd: number | null; degraded: boolean };
			model_info: { base_url: string | null; model_id: string };
		}>(result.out);
		expect(payload.model_info.base_url).toBe("http://127.0.0.1:9/v1");
		expect(payload.model_info.model_id).toBe("test-model");
		expect(payload.result.status).toBe("resolved");
		expect(payload.result.answer).toContain("默认端口");
		expect(payload.measured.model_calls).toBe(1);
		expect(payload.measured.degraded).toBe(false);
		expect(payload.measured.tokens_in).toBe(100);
		expect(payload.measured.cost_usd).toBeCloseTo(0.0001, 8);
		expect(payload.result.budget_used.cost_usd).toBeCloseTo(0.0001, 8);
		expect(payload.layers.find((layer) => layer.layer === "history")?.status).toBe("skipped");
	});

	it("degrades to the zero-LLM layered search with a stated reason without a backend", async () => {
		const path = seedStore((store) => {
			seed(store, { memory_id: "mem-active" });
		});
		const result = await run(["resolve", "--db", path, "--project", PROJECT_A, "--question", "端口"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("model: degraded");
		expect(result.out).toContain("VESTIGIO_MODEL_BASE_URL");
		expect(result.out).toContain("cards=1");
	});

	it("requires a question and a scope", async () => {
		const path = seedStore((store) => seed(store, {}));
		const missingQuestion = await run(["resolve", "--db", path, "--project", PROJECT_A]);
		expect(missingQuestion.code).toBe(2);
		expect(missingQuestion.err).toContain("--question");

		const missingScope = await run(["resolve", "--db", path, "--question", "端口"]);
		expect(missingScope.code).toBe(2);
		expect(missingScope.err).toContain("--project");
	});
});

describe("cli projects", () => {
	const OLD = "/tmp/proj-old";
	const NEW = "/tmp/proj-new";

	it("lists each stored project id with its memory count and repository root", async () => {
		const path = seedStore((store) => {
			seed(store, { memory_id: "mem-a", scope: { kind: "project", project_id: OLD } });
			seed(store, {
				memory_id: "mem-b",
				scope: { kind: "project", project_id: NEW },
				sources: [sourceRef({ project_id: NEW })],
			});
		});

		const result = await run(["projects", "--db", path, "--json"]);
		expect(result.code).toBe(0);
		const listing = parseJson<{
			projects: { project_id: string; memories: number; repository_root: string }[];
		}>(result.out);
		expect(listing.projects).toEqual([
			{ project_id: NEW, memories: 1, repository_root: NEW },
			{ project_id: OLD, memories: 1, repository_root: OLD },
		]);
	});

	it("moves one project id's whole footprint onto another and reports the counts", async () => {
		const path = seedStore((store) => {
			seed(store, {
				memory_id: "mem-a",
				scope: { kind: "project", project_id: OLD },
				sources: [sourceRef({ project_id: OLD })],
			});
		});

		const moved = await run(["projects", "move", OLD, NEW, "--db", path, "--json"]);
		expect(moved.code).toBe(0);
		expect(parseJson<ProjectReassignment>(moved.out)).toMatchObject({
			from: OLD,
			to: NEW,
			memory_ids: ["mem-a"],
			revisions: 1,
			sources: 1,
		});

		const after = await run(["projects", "--db", path]);
		expect(after.out).toContain(NEW);
		expect(after.out).not.toContain(OLD);

		const again = await run(["projects", "move", OLD, NEW, "--db", path]);
		expect(again.code).toBe(0);
		expect(again.out).toContain(`nothing in the store carries ${OLD}`);
	});

	it("rejects a missing target and an unknown subcommand", async () => {
		const path = seedStore((store) => seed(store, {}));

		const missing = await run(["projects", "move", OLD, "--db", path]);
		expect(missing.code).toBe(2);
		expect(missing.err).toContain("<from> <to>");

		const unknown = await run(["projects", "rename", "--db", path]);
		expect(unknown.code).toBe(2);
		expect(unknown.err).toContain("unknown projects subcommand");
		expect(unknown.err).toContain("projects id");
	});
});

function git(dir: string, args: string[]): void {
	execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "vestigio-test",
			GIT_AUTHOR_EMAIL: "vestigio-test@example.com",
			GIT_COMMITTER_NAME: "vestigio-test",
			GIT_COMMITTER_EMAIL: "vestigio-test@example.com",
		},
	});
}

describe("cli projects id", () => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-cli-project-")));
	const repo = join(parent, "repo");
	const worktree = join(parent, "worktree");
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "vestigio-cli-plain-")));
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q"]);
	writeFileSync(join(repo, "README.md"), "seed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	git(repo, ["worktree", "add", "-q", worktree]);

	type Identity = { path: string; project_id: string; repository_root: string | null };

	it("prints only the id", async () => {
		const result = await run(["projects", "id", "--dir", repo]);
		expect(result.code).toBe(0);
		expect(result.out).toBe(`${repo}\n`);
	});

	it("--json carries path, project_id and repository_root", async () => {
		const result = await run(["projects", "id", "--dir", repo, "--json"]);
		expect(result.code).toBe(0);
		expect(parseJson<Identity>(result.out)).toEqual({ path: repo, project_id: repo, repository_root: repo });
	});

	it("returns one id for the checkout and a linked worktree while path differs", async () => {
		const main = parseJson<Identity>((await run(["projects", "id", "--dir", repo, "--json"])).out);
		const linked = parseJson<Identity>((await run(["projects", "id", "--dir", worktree, "--json"])).out);
		expect(linked.project_id).toBe(main.project_id);
		expect(linked.path).not.toBe(main.path);
		expect(linked.repository_root).toBe(main.project_id);
	});

	it("returns the path as the id with a null repository root outside a repository", async () => {
		const result = await run(["projects", "id", "--dir", outside, "--json"]);
		expect(parseJson<Identity>(result.out)).toEqual({
			path: outside,
			project_id: outside,
			repository_root: null,
		});
	});

	it("accepts a relative --dir", async () => {
		const result = await run(["projects", "id", "--dir", ".", "--json"]);
		expect(result.code).toBe(0);
		expect(parseJson<Identity>(result.out).path).toBe(resolve("."));
	});

	it("resolves the same identity from a positional path", async () => {
		const flag = parseJson<Identity>((await run(["projects", "id", "--dir", worktree, "--json"])).out);
		const positional = parseJson<Identity>((await run(["projects", "id", worktree, "--json"])).out);
		expect(positional).toEqual(flag);
	});

	it("rejects more than one directory", async () => {
		const both = await run(["projects", "id", repo, "--dir", worktree]);
		expect(both.code).toBe(2);
		expect(both.err).toContain("give the directory once");
		const extra = await run(["projects", "id", repo, worktree]);
		expect(extra.code).toBe(2);
		expect(extra.err).toContain("projects id takes at most one directory");
	});
});
