#!/usr/bin/env node
/**
 * Installs vestigio for the local machine: dependencies, the config file, the
 * `vestigio` command on PATH, and the pi extension through `pi install`.
 *
 * It refuses to fake a registration and never edits a pi setting it did not
 * understand: the extension must show up in the pi settings' `packages` list
 * after the install, which `pi -e` alone never does.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = join(ROOT, "packages", "pi-extension");
const CLI_ENTRY = join(ROOT, "packages", "cli", "bin", "vestigio");

const HELP = `usage: node scripts/deploy.mjs [options]

  --dry-run                print every step without changing anything
  --config <path>          config file (default ~/.vestigio/config.json)
  --pi-settings <path>     pi settings file (default ~/.pi/agent/settings.json)
  --pi <command>           pi binary (default "pi")
  --bin-dir <dir>          where to link the vestigio command
  --model-base-url <url>   write model.base_url into the config file
  --model-id <id>          write model.id into the config file
  --model-api-key <key>    write model.api_key into the config file
  --skip-install           do not run pnpm install
  --skip-link              do not link the vestigio command
  --help                   show this text
`;

function parse(argv) {
  const options = {
    dry_run: false,
    config: join(homedir(), ".vestigio", "config.json"),
    pi_settings: join(homedir(), ".pi", "agent", "settings.json"),
    pi: "pi",
    bin_dir: null,
    model: {},
    skip_install: false,
    skip_link: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--dry-run":
        options.dry_run = true;
        break;
      case "--config":
        options.config = resolve(value());
        break;
      case "--pi-settings":
        options.pi_settings = resolve(value());
        break;
      case "--pi":
        options.pi = value();
        break;
      case "--bin-dir":
        options.bin_dir = resolve(value());
        break;
      case "--model-base-url":
        options.model.base_url = value();
        break;
      case "--model-id":
        options.model.id = value();
        break;
      case "--model-api-key":
        options.model.api_key = value();
        break;
      case "--skip-install":
        options.skip_install = true;
        break;
      case "--skip-link":
        options.skip_link = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

const report = [];

function step(name, status, detail) {
  report.push({ name, status, detail });
  process.stdout.write(`${status.padEnd(5)} ${name}${detail === "" ? "" : ` — ${detail}`}\n`);
}

function fail(name, detail) {
  step(name, "FAIL", detail);
  finish();
  process.exit(1);
}

function finish() {
  const failed = report.filter((entry) => entry.status === "FAIL").length;
  const changed = report.filter((entry) => entry.status === "ok").length;
  process.stdout.write(`\n${changed} step(s) done, ${failed} failed\n`);
}

function run(command, args, options = {}) {
  if (options.dry_run === true) {
    process.stdout.write(`      would run: ${command} ${args.join(" ")}\n`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---- config file ----------------------------------------------------------

function readJsonFile(path, label) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(label, `cannot read ${path}: ${error.message}`);
  }
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fail(label, `${path} is not valid JSON: ${error.message}`);
  }
}

function mergeConfig(path, options) {
  const existing = readJsonFile(path, "config");
  if (existing !== null && (typeof existing !== "object" || Array.isArray(existing))) {
    fail("config", `${path} must hold a JSON object`);
  }
  const next = { ...(existing ?? {}), version: 1 };
  if (typeof next.store !== "string" || next.store === "") {
    next.store = "~/.vestigio/store.sqlite";
  }
  const logging = typeof next.logging === "object" && next.logging !== null && !Array.isArray(next.logging)
    ? next.logging
    : {};
  next.logging = { activity: false, ...logging };
  if (Object.keys(options.model).length > 0) {
    const model = typeof next.model === "object" && next.model !== null && !Array.isArray(next.model)
      ? next.model
      : {};
    next.model = { ...model, ...options.model };
  }
  const before = existing === null ? null : JSON.stringify(existing);
  const after = JSON.stringify(next);
  if (before === after) {
    step("config", "skip", `${path} already up to date`);
    return;
  }
  if (options.dry_run) {
    step("config", "ok", `would write ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, path);
  step("config", "ok", `wrote ${path}`);
}

// ---- pi extension ---------------------------------------------------------

function packageSources(settings) {
  const packages = settings?.packages;
  if (!Array.isArray(packages)) return [];
  return packages
    .map((entry) => (typeof entry === "string" ? entry : entry?.source))
    .filter((source) => typeof source === "string");
}

function resolvesToPackage(source, settingsPath) {
  if (source.startsWith("npm:") || source.startsWith("git:") || /^[a-z]+:\/\//i.test(source)) return false;
  const absolute = resolve(dirname(settingsPath), source);
  try {
    return realpathSync(absolute) === realpathSync(EXTENSION_DIR);
  } catch {
    return false;
  }
}

function installedThroughPiInstall(settingsPath) {
  const settings = readJsonFile(settingsPath, "pi settings");
  return packageSources(settings).some((source) => resolvesToPackage(source, settingsPath));
}

function installExtension(options) {
  if (installedThroughPiInstall(options.pi_settings)) {
    step("pi install", "skip", "the extension is already in pi settings");
    return;
  }
  if (!existsSync(EXTENSION_DIR)) fail("pi install", `${EXTENSION_DIR} is missing`);
  const source = EXTENSION_DIR;
  const result = run(options.pi, ["install", source], { dry_run: options.dry_run, timeout: 120_000 });
  if (result.status !== 0) {
    fail("pi install", (result.stderr || result.stdout || "pi install failed").trim());
  }
  if (options.dry_run) {
    step("pi install", "ok", `would register ${source}`);
    return;
  }
  if (!installedThroughPiInstall(options.pi_settings)) {
    fail("pi install", `${options.pi_settings} still has no entry for ${EXTENSION_DIR}`);
  }
  step("pi install", "ok", `registered ${source}`);
}

function warnAboutExtensionFlagCache(options) {
  const cache = join(dirname(options.pi_settings), "tmp", "extensions");
  if (!existsSync(cache)) return;
  const hits = [];
  for (const entry of readdirSafe(cache)) {
    if (entry.includes("vestigio")) hits.push(entry);
  }
  if (hits.length > 0) {
    step("pi -e cache", "warn", `${hits.length} cached copy under ${cache}; -e entries are not a registration`);
  }
}

function readdirSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ---- command on PATH ------------------------------------------------------

function writableDirectory(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function linkCommand(options) {
  const candidates = options.bin_dir === null
    ? ["/usr/local/bin", join(homedir(), ".local", "bin")]
    : [options.bin_dir];
  const target = candidates.find((dir) => existsSync(dir) && writableDirectory(dir)) ?? null;
  if (target === null) {
    step("vestigio command", "warn", `no writable bin dir among ${candidates.join(", ")}; run ${CLI_ENTRY} directly`);
    return;
  }
  const link = join(target, "vestigio");
  if (existsSync(link)) {
    let current = null;
    try {
      current = realpathSync(link);
    } catch {
      current = null;
    }
    if (current === realpathSync(CLI_ENTRY)) {
      step("vestigio command", "skip", `${link} already points here`);
      return;
    }
    step("vestigio command", "warn", `${link} exists and is not ours; leaving it alone`);
    return;
  }
  if (options.dry_run) {
    step("vestigio command", "ok", `would link ${link}`);
    return;
  }
  chmodSync(CLI_ENTRY, 0o755);
  symlinkSync(CLI_ENTRY, link);
  step("vestigio command", "ok", `linked ${link}`);
}

// ---- main ----------------------------------------------------------------

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  process.stdout.write(`vestigio deploy${options.dry_run ? " (dry run)" : ""}\n\n`);

  if (!options.skip_install) {
    const result = run("pnpm", ["install", "--frozen-lockfile"], { dry_run: options.dry_run, timeout: 300_000 });
    if (result.status !== 0) fail("pnpm install", (result.stderr || result.stdout).trim());
    step("pnpm install", "ok", "workspace dependencies are installed");
  } else {
    step("pnpm install", "skip", "requested");
  }

  mergeConfig(options.config, options);

  installExtension(options);
  warnAboutExtensionFlagCache(options);

  if (!options.skip_link) linkCommand(options);
  else step("vestigio command", "skip", "requested");

  const config = readJsonFile(options.config, "config") ?? {};
  if (typeof config.model !== "object" || config.model === null || typeof config.model.base_url !== "string") {
    step(
      "model",
      "warn",
      `no model.base_url in ${options.config}; memory saves need one (pass --model-base-url and --model-id)`,
    );
  } else {
    step("model", "ok", `${config.model.id} via ${config.model.base_url}`);
  }

  finish();
  process.stdout.write(`\nnext: restart pi, then ask a question the store already answers.\n`);
}

main();
