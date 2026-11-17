import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "../src/contracts/index.js";
import { FIXTURE_COVERAGE, parseEvalCase } from "../src/contracts/index.js";

const FIXTURES_DIR = fileURLToPath(new URL("../../../eval/fixtures", import.meta.url));

function readCases(): { cases: EvalCase[]; totalLines: number; files: string[] } {
  const files = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .sort();
  const cases: EvalCase[] = [];
  let totalLines = 0;
  for (const file of files) {
    const content = readFileSync(join(FIXTURES_DIR, file), "utf8");
    if (file.endsWith(".jsonl")) {
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      totalLines += lines.length;
      for (const [index, line] of lines.entries()) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `${file}:${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        cases.push(parseEvalCase(raw, `${file}:${index + 1}`));
      }
    } else {
      const raw = JSON.parse(content) as unknown;
      const records = Array.isArray(raw) ? raw : [raw];
      totalLines += records.length;
      for (const [index, record] of records.entries()) {
        cases.push(parseEvalCase(record, `${file}[${index}]`));
      }
    }
  }
  return { cases, totalLines, files };
}

describe("eval fixtures", () => {
  it("has at least one fixture file", () => {
    expect(readdirSync(FIXTURES_DIR).some((name) => name.endsWith(".jsonl") || name.endsWith(".json"))).toBe(
      true,
    );
  });

  it("parses and validates every fixture record", () => {
    const { cases, totalLines, files } = readCases();
    expect(files.length).toBeGreaterThan(0);
    expect(cases.length).toBeGreaterThanOrEqual(FIXTURE_COVERAGE.length);
    expect(totalLines).toBeLessThan(200);
    const ids = new Set<string>();
    for (const evalCase of cases) {
      expect(evalCase.id.length).toBeGreaterThan(0);
      expect(evalCase.why.length).toBeGreaterThan(0);
      expect(ids.has(evalCase.id)).toBe(false);
      ids.add(evalCase.id);
    }
  });

  it("covers every corpus requirement with a case id prefix", () => {
    const { cases } = readCases();
    for (const coverage of FIXTURE_COVERAGE) {
      expect(cases.some((evalCase) => evalCase.id.startsWith(coverage)), `missing coverage: ${coverage}`).toBe(
        true,
      );
    }
  });
});
