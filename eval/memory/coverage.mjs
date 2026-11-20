#!/usr/bin/env node
// Renders the coverage annotation set (coverage.jsonl) as a review sheet and
// prints the counts the coverage rate is built from.
//
//   node ./coverage.mjs                       # summary + markdown to stdout
//   node ./coverage.mjs --out out/coverage.md # write the sheet
//
// The rows carry two independent axes:
//   durable        the answer is long-lived, project-scoped knowledge a memory
//                  should hold, rather than session-local reasoning
//   answer_lives   where the answer is actually recorded: "history" (raw
//                  session transcripts), "nowhere" (no transcript has it), or
//                  "unverified" (not searched credibly)
// A row is only judged once `answer_lives` is set; `draft_*` stays untouched so
// the reviewer can see what the drafting pass believed. `verified_answer`
// replaces the draft's answer in the sheet when a reviewer corrected it.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const input = resolve(flag("in", "coverage.jsonl"));
const out = flag("out", null);

const rows = readFileSync(input, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const judged = rows.filter((row) => row.answer_lives != null);
const durable = judged.filter((row) => row.durable === true);
const lives = (value) => durable.filter((row) => row.answer_lives === value).length;
const unverified = judged.filter((row) => row.answer_lives === "unverified").length;
const disputed = judged.filter(
  (row) =>
    row.durable !== row.draft_durable || row.answer_lives !== row.draft_answer_lives,
);

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (text, limit) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const evidence = (row) =>
  (row.evidence ?? []).map((e) => `${e.session_id.slice(0, 22)}… ${short(e.quote, 40)}`).join(" / ");
const answer = (row) => {
  const text = row.verified_answer ?? row.draft_answer;
  return row.verified_answer ? `${text}（初判更正）` : text;
};

const sheet = [
  "| id | asked | topic | durable | answer lives | question | answer | evidence |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...judged.map((row) =>
    [
      row.id,
      row.asked_at.slice(0, 10),
      cell(row.topic),
      row.durable ? "yes" : "no",
      row.answer_lives,
      cell(short(row.question, 90)),
      cell(short(answer(row), 110)),
      cell(evidence(row)),
    ].join(" | ").replace(/^/, "| ").concat(" |"),
  ),
].join("\n");

const summary = {
  rows: rows.length,
  judged: judged.length,
  durable: durable.length,
  answer_lives: { history: lives("history"), nowhere: lives("nowhere"), unverified },
  durable_history: durable.filter((row) => row.answer_lives === "history").length,
  durable_nowhere: durable.filter((row) => row.answer_lives === "nowhere").length,
  disputed: disputed.length,
  corrected_answers: rows.filter((row) => row.verified_answer).length,
  judges: [...new Set(judged.map((row) => row.judge).filter(Boolean))],
};

const text = [
  `rows ${summary.rows}, judged ${summary.judged}, durable ${summary.durable}, judge ${summary.judges.join(",") || "none"}`,
  `durable rows: history ${summary.durable_history}, nowhere ${summary.durable_nowhere}`,
  summary.judged < summary.rows
    ? `not judged yet: ${rows.length - judged.length} rows (answer_lives is null)`
    : "every row judged",
  `disagrees with the draft: ${summary.disputed}; answers corrected: ${summary.corrected_answers}`,
  "",
  sheet,
  "",
].join("\n");

if (out) {
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`sheet ${path}`);
}
console.log(
  `rows ${summary.rows} | judged ${summary.judged} | durable ${summary.durable} | history ${summary.durable_history} | nowhere ${summary.durable_nowhere} | unverified ${unverified} | disputed ${summary.disputed} | corrected ${summary.corrected_answers}`,
);
if (!out) console.log(`\n${sheet}`);
