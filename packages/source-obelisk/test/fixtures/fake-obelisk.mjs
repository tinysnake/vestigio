// Stand-in for the pinned Obelisk CLI, for unit tests only.
//
// It speaks the same surface the adapter uses (`--version`, `--search`,
// `--query <file>`) and nothing else, so unit tests can drive every failure
// branch deterministically without an Obelisk install. Behaviour is chosen by
// env vars, which the adapter passes through untouched:
//
//   FAKE_OBELISK_VERSION      raw text printed for --version (default 0.3.2)
//   FAKE_OBELISK_SEARCH       JSON printed for --search
//   FAKE_OBELISK_QUERY        JSON printed for --query
//   FAKE_OBELISK_STDOUT       raw stdout bytes, overrides the JSON above
//   FAKE_OBELISK_EXIT         exit code (default 0)
//   FAKE_OBELISK_STDERR       diagnostic bytes on stderr (never a failure signal)
//   FAKE_OBELISK_SLEEP_MS     delay before printing anything
//   FAKE_OBELISK_IGNORE_TERM  ignore SIGTERM (SIGKILL still works)
//   FAKE_OBELISK_ARGV_LOG     file to append one JSON line of argv to
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (process.env["FAKE_OBELISK_ARGV_LOG"] !== undefined) {
  appendFileSync(process.env["FAKE_OBELISK_ARGV_LOG"], `${JSON.stringify(argv)}\n`);
}

if (process.env["FAKE_OBELISK_IGNORE_TERM"] === "1") {
  process.on("SIGTERM", () => {});
}

if (process.env["FAKE_OBELISK_VERSION"] !== undefined && argv[0] === "--version") {
  process.stdout.write(process.env["FAKE_OBELISK_VERSION"]);
  process.exit(Number(process.env["FAKE_OBELISK_EXIT"] ?? "0"));
}

const sleep_ms = Number(process.env["FAKE_OBELISK_SLEEP_MS"] ?? "0");
if (sleep_ms > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleep_ms));
}

if (process.env["FAKE_OBELISK_STDERR"] !== undefined) {
  process.stderr.write(process.env["FAKE_OBELISK_STDERR"]);
}

const exit_code = Number(process.env["FAKE_OBELISK_EXIT"] ?? "0");
const script_path = argv[0] === "--query" ? argv[1] : undefined;
if (script_path !== undefined && process.env["FAKE_OBELISK_ECHO_SCRIPT"] === "1") {
  process.stdout.write(
    JSON.stringify({
      argv,
      script: existsSync(script_path) ? readFileSync(script_path, "utf8") : null,
      home: process.env["HOME"] ?? null,
    }),
  );
  process.exit(exit_code);
}

const raw = process.env["FAKE_OBELISK_STDOUT"];
if (raw !== undefined) {
  process.stdout.write(raw);
  process.exit(exit_code);
}

const payload =
  argv[0] === "--query" ? process.env["FAKE_OBELISK_QUERY"] : process.env["FAKE_OBELISK_SEARCH"];
process.stdout.write(payload ?? "[]");
process.exit(exit_code);
