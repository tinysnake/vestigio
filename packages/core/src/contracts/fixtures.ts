import {
  readField,
  readNonEmptyString,
  readRecord,
  readUnion,
} from "./primitives.js";

/**
 * Synthetic corpus contract for `eval/fixtures/`.
 *
 * The coverage slugs are the required corpus behaviours; the
 * fixture test asserts each slug prefixes at least one case id. Each record
 * carries exactly `id`, `input`, `expected`, `why`.
 */
export const FIXTURE_COVERAGE = [
  "should-query",
  "should-not-query",
  "hotspot-shared-two-projects",
  "short-chinese-terms",
  "english-identifiers",
  "stale-configuration",
  "conflicting-decisions",
  "missing-source",
  "malicious-history-instruction",
  "archived-then-recovered",
  "repeat-runs",
] as const;

export type FixtureCoverage = (typeof FIXTURE_COVERAGE)[number];

export const FIXTURE_EXPECTATIONS = [
  "query",
  "no_query",
  "inject",
  "flag_stale",
  "flag_conflict",
  "flag_missing_source",
  "ignore_as_data",
  "recover_archived",
  "dedupe",
] as const;

export type FixtureExpectation = (typeof FIXTURE_EXPECTATIONS)[number];

export type FixtureInput = {
  text: string;
  project_id: string;
  session_id: string;
};

export type EvalCase = {
  id: string;
  input: FixtureInput;
  expected: FixtureExpectation;
  why: string;
};

export function parseFixtureInput(value: unknown, path = "$"): FixtureInput {
  const record = readRecord(value, path);
  return {
    text: readNonEmptyString(readField(record, "text", path), `${path}.text`),
    project_id: readNonEmptyString(readField(record, "project_id", path), `${path}.project_id`),
    session_id: readNonEmptyString(readField(record, "session_id", path), `${path}.session_id`),
  };
}

export function parseEvalCase(value: unknown, path = "$"): EvalCase {
  const record = readRecord(value, path);
  return {
    id: readNonEmptyString(readField(record, "id", path), `${path}.id`),
    input: parseFixtureInput(readField(record, "input", path), `${path}.input`),
    expected: readUnion(readField(record, "expected", path), `${path}.expected`, FIXTURE_EXPECTATIONS),
    why: readNonEmptyString(readField(record, "why", path), `${path}.why`),
  };
}
